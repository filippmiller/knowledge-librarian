/**
 * Контрольный замер «весь корпус в промпте» (benchmark Aurora, 2026-08-12).
 *
 * Эталон качества ответов: вместо полного RAG-пайплайна ВЕСЬ канонический
 * текст фикстуры (те же 15 блоков из `extractCanonicalDocument`, что кормят
 * пайплайн) кладётся в system-промпт с prompt caching
 * (`cache_control: ephemeral`), и все 16 контрольных вопросов оракула
 * задаются модели напрямую. Модель — `claude-sonnet-5`, та же, что на
 * вопросной стороне пайплайна (engineProfile quality), для честного
 * сравнения со счётом пайплайна (baseline 6/10 + 2/6).
 *
 * Счёт pass = совпадение диспозиции с ожидаемой (та же семантика, что у
 * детерминированного грейдера пайплайна):
 *   positive       -> DIRECT_ANSWER
 *   must_clarify   -> HOLD
 *   must_not_apply -> DIRECT_ANSWER (ответ обязан прямо отклонить исключение)
 *
 * Usage:
 *   npx tsx scripts/run-full-corpus-control.ts
 *
 * Needs: ANTHROPIC_API_KEY в .env (как у остальных eval-скриптов).
 * Артефакты: scratchpad/corpus-in-prompt/run-1-<timestamp>/{answers,summary}.json
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { extractCanonicalDocument } from '../src/lib/knowledge/docx-canonical-blocks';
import { estimateCostUsd } from '../src/lib/ai/cost';

const MODEL = 'claude-sonnet-5';
const MAX_TOKENS = 1024;
const MAX_RETRIES = 2; // повторы только на 429/5xx; 400/403 — фатально
const COST_BUDGET_USD = 0.5;

const DOC_PATH = path.join(
  'scripts',
  'fixtures',
  'semantic-rule-extraction-test-pack',
  'uchebnaya_instrukciya_semanticheskoe_izvlechenie_pravil.docx'
);
const ORACLE_PATH = path.join(
  'scripts',
  'fixtures',
  'semantic-rule-extraction-test-pack',
  'test_cases_semantic_rules.jsonl'
);

type Disposition = 'DIRECT_ANSWER' | 'HOLD' | 'UNVERIFIED_ANSWER';

interface OracleNegativeCase {
  readonly id: string;
  readonly question: string;
  readonly expected_behavior: 'must_clarify' | 'must_not_apply';
  readonly expected_answer: string;
}

interface OracleCase {
  readonly id: string;
  readonly question: string;
  readonly expected_rule_ids: readonly number[];
  readonly expected_answer: string;
  readonly negativeCases?: readonly OracleNegativeCase[];
}

interface QuestionItem {
  readonly caseId: string;
  readonly question: string;
  readonly kind: 'positive' | 'must_clarify' | 'must_not_apply';
  readonly expectedDisposition: Disposition;
  readonly expectedRuleIds?: readonly number[];
  readonly expectedBehavior?: string;
  readonly expectedAnswer: string;
  /** Для must_not_apply — правило родительского кейса, чьё ошибочное
   *  применение проверяет кейс (эвристика для сводки, не для pass). */
  readonly forbiddenRuleIds?: readonly number[];
}

interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
}

interface AnswerRecord {
  readonly caseId: string;
  readonly question: string;
  readonly disposition: Disposition | null;
  readonly answer: string | null;
  readonly citedRuleNumbers: readonly number[];
  readonly expectedDisposition: Disposition;
  readonly expectedRuleIds?: readonly number[];
  readonly expectedBehavior?: string;
  readonly pass: boolean;
  readonly error?: string;
  readonly usage: Usage;
}

function loadQuestions(): QuestionItem[] {
  const lines = readFileSync(ORACLE_PATH, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const items: QuestionItem[] = [];
  for (const line of lines) {
    const c = JSON.parse(line) as OracleCase;
    items.push({
      caseId: c.id,
      question: c.question,
      kind: 'positive',
      expectedDisposition: 'DIRECT_ANSWER',
      expectedRuleIds: c.expected_rule_ids,
      expectedAnswer: c.expected_answer,
    });
  }
  // Негативные — после всех позитивных, в порядке родительских кейсов.
  for (const line of lines) {
    const c = JSON.parse(line) as OracleCase;
    for (const n of c.negativeCases ?? []) {
      items.push({
        caseId: n.id,
        question: n.question,
        kind: n.expected_behavior,
        expectedDisposition: n.expected_behavior === 'must_clarify' ? 'HOLD' : 'DIRECT_ANSWER',
        expectedBehavior: n.expected_behavior,
        expectedAnswer: n.expected_answer,
        forbiddenRuleIds: n.expected_behavior === 'must_not_apply' ? c.expected_rule_ids : undefined,
      });
    }
  }
  return items;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface AnthropicUsageRaw {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly cache_read_input_tokens?: number;
}

async function callModel(
  apiKey: string,
  system: readonly unknown[],
  question: string
): Promise<{ text: string; usage: Usage }> {
  let lastError = '';
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        system,
        messages: [{ role: 'user', content: `Вопрос: ${question}\n\nОтветь строго одним JSON-объектом.` }],
        max_tokens: MAX_TOKENS,
        // temperature НЕ передаём: Sonnet 5 отвечает 400 "`temperature` is
        // deprecated for this model".
        // См. chat-provider.ts: на Sonnet 5 omission включает adaptive thinking
        // и съедает весь токен-бюджет — отключаем явно.
        thinking: { type: 'disabled' },
      }),
    });
    } catch (err) {
      // Сетевой сбой (fetch failed) — тот же класс transient, что 429/5xx.
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_RETRIES) {
        const pauseMs = attempt === 0 ? 5000 : 15000;
        console.warn(`  сетевой сбой, повтор ${attempt + 1}/${MAX_RETRIES} через ${pauseMs / 1000}s`);
        await sleep(pauseMs);
        continue;
      }
      break;
    }
    if (res.ok) {
      const body = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: AnthropicUsageRaw;
      };
      const text = (body.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      const u = body.usage ?? {};
      return {
        text,
        usage: {
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
          cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
        },
      };
    }
    const status = res.status;
    const snippet = (await res.text()).slice(0, 300);
    if (status === 400 || status === 401 || status === 403) {
      throw new Error(`Фатальный ответ Anthropic ${status}: ${snippet}`);
    }
    lastError = `${status}: ${snippet}`;
    if (status === 429 || status >= 500) {
      const pauseMs = attempt === 0 ? 5000 : 15000;
      console.warn(`  ${status}, повтор ${attempt + 1}/${MAX_RETRIES} через ${pauseMs / 1000}s`);
      await sleep(pauseMs);
      continue;
    }
    throw new Error(`Неожиданный ответ Anthropic ${status}: ${snippet}`);
  }
  throw new Error(`Исчерпаны повторы. Последняя ошибка: ${lastError}`);
}

function parseModelJson(text: string): { disposition: Disposition; answer: string; citedRuleNumbers: number[] } {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`JSON не найден в ответе: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    disposition?: string;
    answer?: string;
    citedRuleNumbers?: unknown;
  };
  const d = parsed.disposition;
  if (d !== 'DIRECT_ANSWER' && d !== 'HOLD' && d !== 'UNVERIFIED_ANSWER') {
    throw new Error(`Неизвестная диспозиция "${String(d)}" в ответе: ${text.slice(0, 200)}`);
  }
  const cited = Array.isArray(parsed.citedRuleNumbers)
    ? parsed.citedRuleNumbers.filter((n): n is number => typeof n === 'number' && Number.isInteger(n))
    : [];
  return { disposition: d, answer: typeof parsed.answer === 'string' ? parsed.answer : '', citedRuleNumbers: cited };
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY не задан в .env');

  // 1. Канонизация — та же функция, что кормит пайплайн, чтобы корпус совпадал.
  const canonical = await extractCanonicalDocument(readFileSync(DOC_PATH));
  console.log(`канонических блоков: ${canonical.blocks.length}`);
  const corpusText = canonical.blocks.map((b) => `[${b.anchor} | ${b.kind}] ${b.text}`).join('\n\n');

  // 2. System-промпт: инструкция + весь корпус с cache_control на блоке корпуса.
  const system = [
    {
      type: 'text',
      text: [
        'Ты — справочная система по корпоративной инструкции. Отвечай ТОЛЬКО на основании канонического текста ниже; ничего не додумывай.',
        'Каждый блок текста имеет якорь [bN | KIND]. Правила в тексте пронумерованы.',
        '',
        'Ответь строго одним JSON-объектом (без markdown, без пояснений вокруг):',
        '{"disposition": "DIRECT_ANSWER" | "HOLD" | "UNVERIFIED_ANSWER", "answer": string, "citedRuleNumbers": number[]}',
        '',
        'Семантика диспозиций:',
        '- DIRECT_ANSWER — уверенный прямой ответ по правилам инструкции. Если вопрос предлагает применить исключение там, где оно НЕ действует, — это тоже DIRECT_ANSWER: прямо скажи, что исключение неприменимо, и дай верный порядок.',
        '- HOLD — в вопросе не хватает условия, без которого однозначного ответа нет; сформулируй в answer, что именно нужно уточнить у пользователя.',
        '- UNVERIFIED_ANSWER — в тексте инструкции нет оснований для ответа.',
        '',
        'В answer — сам ответ на русском языке. В citedRuleNumbers — номера правил, на которые опирается ответ (пустой массив, если ни на какие).',
      ].join('\n'),
    },
    {
      type: 'text',
      text: `КАНОНИЧЕСКИЙ ТЕКСТ ИНСТРУКЦИИ:\n\n${corpusText}`,
      cache_control: { type: 'ephemeral' },
    },
  ];

  const questions = loadQuestions();
  console.log(`вопросов: ${questions.length} (порядок: Q01..Q10, затем негативные)`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join('scratchpad', 'corpus-in-prompt', `run-1-${timestamp}`);
  mkdirSync(outDir, { recursive: true });

  // 3. Задаём вопросы последовательно — кэш создаётся на первом вызове,
  //    читается на остальных 15.
  const answers: AnswerRecord[] = [];
  let totalCostUsd = 0;
  const totals = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };

  for (const q of questions) {
    let record: AnswerRecord;
    try {
      const { text, usage } = await callModel(apiKey, system, q.question);
      const cost = estimateCostUsd(MODEL, usage) ?? 0;
      totalCostUsd += cost;
      totals.inputTokens += usage.inputTokens;
      totals.outputTokens += usage.outputTokens;
      totals.cacheCreationInputTokens += usage.cacheCreationInputTokens;
      totals.cacheReadInputTokens += usage.cacheReadInputTokens;
      if (totalCostUsd > COST_BUDGET_USD) {
        throw new Error(`Бюджет исчерпан: $${totalCostUsd.toFixed(4)} > $${COST_BUDGET_USD}. Останавливаюсь.`);
      }
      const parsed = parseModelJson(text);
      record = {
        caseId: q.caseId,
        question: q.question,
        disposition: parsed.disposition,
        answer: parsed.answer,
        citedRuleNumbers: parsed.citedRuleNumbers,
        expectedDisposition: q.expectedDisposition,
        expectedRuleIds: q.expectedRuleIds,
        expectedBehavior: q.expectedBehavior,
        pass: parsed.disposition === q.expectedDisposition,
        usage,
      };
      console.log(
        `${q.caseId}: ${parsed.disposition} (ожидалось ${q.expectedDisposition}) ${record.pass ? 'PASS' : 'FAIL'} ` +
          `[in=${usage.inputTokens} out=${usage.outputTokens} cacheW=${usage.cacheCreationInputTokens} cacheR=${usage.cacheReadInputTokens}] $${cost.toFixed(4)}`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Фатальные ошибки API (400/403/бюджет) — наружу; ошибки парсинга — в запись.
      if (message.startsWith('Фатальный') || message.startsWith('Бюджет')) throw err;
      record = {
        caseId: q.caseId,
        question: q.question,
        disposition: null,
        answer: null,
        citedRuleNumbers: [],
        expectedDisposition: q.expectedDisposition,
        expectedRuleIds: q.expectedRuleIds,
        expectedBehavior: q.expectedBehavior,
        pass: false,
        error: message,
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      };
      console.log(`${q.caseId}: ERROR ${message}`);
    }
    answers.push(record);
  }

  // 4-5. Артефакты.
  const positives = answers.filter((a) => a.expectedBehavior === undefined);
  const negatives = answers.filter((a) => a.expectedBehavior !== undefined);
  const failedIds = answers.filter((a) => !a.pass).map((a) => a.caseId);

  const ruleCoverage = positives.map((a) => ({
    caseId: a.caseId,
    expectedRuleIds: a.expectedRuleIds ?? [],
    citedRuleNumbers: a.citedRuleNumbers,
    covered: (a.expectedRuleIds ?? []).every((id) => a.citedRuleNumbers.includes(id)),
  }));
  const forbiddenCitations = negatives
    .filter((a) => a.expectedBehavior === 'must_not_apply')
    .map((a) => {
      const q = questions.find((x) => x.caseId === a.caseId);
      const forbidden = q?.forbiddenRuleIds ?? [];
      return {
        caseId: a.caseId,
        forbiddenRuleIds: forbidden,
        citedRuleNumbers: a.citedRuleNumbers,
        forbiddenCited: forbidden.some((id) => a.citedRuleNumbers.includes(id)),
      };
    });

  const summary = {
    model: MODEL,
    doc: DOC_PATH,
    canonicalBlocks: canonical.blocks.length,
    score: {
      positivePassed: positives.filter((a) => a.pass).length,
      positiveTotal: positives.length,
      negativePassed: negatives.filter((a) => a.pass).length,
      negativeTotal: negatives.length,
      totalPassed: answers.filter((a) => a.pass).length,
      total: answers.length,
    },
    failedCaseIds: failedIds,
    ruleCoverage,
    forbiddenRuleCitations: forbiddenCitations,
    usage: {
      totals,
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      pricingNote:
        'claude-sonnet-5: $2/M input, $10/M output, cache write x1.25, cache read x0.1 (src/lib/ai/cost.ts)',
    },
  };

  writeFileSync(path.join(outDir, 'answers.json'), JSON.stringify(answers, null, 2));
  writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n=== ИТОГ ===');
  console.log(
    `позитивные: ${summary.score.positivePassed}/${summary.score.positiveTotal}, ` +
      `негативные: ${summary.score.negativePassed}/${summary.score.negativeTotal}, ` +
      `всего: ${summary.score.totalPassed}/${summary.score.total}`
  );
  console.log(`фейлы: ${failedIds.length > 0 ? failedIds.join(', ') : 'нет'}`);
  console.log(
    `токены: in=${totals.inputTokens} out=${totals.outputTokens} cacheWrite=${totals.cacheCreationInputTokens} cacheRead=${totals.cacheReadInputTokens}`
  );
  console.log(`стоимость: $${totalCostUsd.toFixed(4)}`);
  console.log(`артефакты: ${outDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
