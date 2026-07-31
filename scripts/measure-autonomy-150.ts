/**
 * Замер автономности на ~150 реальных вопросах из переписки за май 2026.
 *
 * Вопрос владельца: укладываемся ли мы в «не более 2% ошибочных среди
 * ОТПРАВЛЕННЫХ». Ответить на него можно только объёмом: 15 вопросов прошлого
 * замера дают доверительный интервал шире самой цели.
 *
 * Источник вопросов — `docs/email-bot/may2026-knowledge-base-final.json`:
 * 180 кейсов, где `answer` — ответ живого оператора. Он эталон по смыслу, но не
 * по полноте (см. промпт судьи).
 *
 * Движок импортируется напрямую из рабочего дерева и работает на продовой базе
 * через `railway run` — измеряется рабочее дерево, прод не задействован.
 *
 * Запуск:   railway run npx tsx scripts/measure-autonomy-150.ts
 * Смоук:    LIMIT=3 railway run npx tsx scripts/measure-autonomy-150.ts
 * Заново:   FRESH=1 railway run npx tsx scripts/measure-autonomy-150.ts
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { answerQuestionEnhanced } from '../src/lib/ai/enhanced-answering-engine';
import { resolveDelivery } from '../src/lib/ai/delivery';
import { checkCertificationPriceAttribution } from '../src/lib/knowledge/certification-price';
import { createChatCompletion, normalizeJsonResponse } from '../src/lib/ai/chat-provider';
import prisma from '../src/lib/db';

const CORPUS = 'docs/email-bot/may2026-knowledge-base-final.json';

/**
 * Один вопрос стоит ~150 секунд: движок делает с десяток последовательных
 * вызовов модели. 150 вопросов подряд — это шесть часов, поэтому прогон режется
 * на диапазоны, каждый со своим файлом результатов, и они идут параллельно.
 * Отбор кейсов от диапазона не зависит, так что номер `n` остаётся одним и тем
 * же во всех воркерах, и файлы просто склеиваются по `n`.
 */
const SUFFIX = process.env.SUFFIX ?? '';
const RESULTS = `docs/bot-audit/.autonomy-150-results${SUFFIX}.jsonl`;
const PROGRESS = `docs/bot-audit/.autonomy-150-progress${SUFFIX}.log`;

const [RANGE_FROM, RANGE_TO] = (process.env.RANGE ?? '1-99999')
  .split('-')
  .map(Number);

const TARGET = Number(process.env.LIMIT ?? 150);

/** Пауза между вопросами. Без неё прогон валит провайдера: прошлый замер
 *  потерял 8 ответов из 15 на `UND_ERR_SOCKET`. */
const PACE_MS = 4000;
const RETRIES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function note(line: string): void {
  console.log(line);
  appendFileSync(PROGRESS, `${line}\n`, 'utf8');
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      note(`      попытка ${attempt}/${RETRIES}: ${String(e).slice(0, 140).replace(/\s+/g, ' ')}`);
      if (attempt < RETRIES) await sleep(attempt * 8000);
    }
  }
  throw lastError;
}

/** Промпт судьи скопирован из scripts/rerun-out-of-corpus-inprocess.ts без
 *  изменений: сравнивать замеры можно только при одинаковой мерке. */
const JUDGE_PROMPT = `Ты строгий проверяющий в бюро переводов. Сравниваешь ответ бота с ответом, который реально дал клиенту опытный оператор на тот же по смыслу вопрос.

Оператор — эталон по СМЫСЛУ, но не по полноте: бот законно может назвать цену из прайса, которой оператор не назвал. Отсутствие факта у оператора само по себе не ошибка бота.

Ошибка бота — это:
· ответ не на заданный вопрос;
· противоречие оператору по существу (разные цены за одно и то же, «делаем» против «не делаем», разные сроки);
· пропуск условия, без которого ответ вводит в заблуждение.

Ответ строго JSON:
{"answers_question":"yes"|"partial"|"no","contradicts":true|false,"contradiction_detail":"","missing_essential":"","verdict":"OK"|"WEAK"|"WRONG","reason":""}

Вердикт применяй буквально: contradicts=true → WRONG; answers_question="no" → WRONG; "partial" или есть missing_essential → WEAK; иначе OK.`;

interface CorpusCase {
  category: string;
  question: string;
  answer: string;
  price_dependent: boolean;
  freq: number;
  confidence: number;
}

/**
 * Стратифицированный отбор: доля категории в выборке равна её доле в корпусе
 * (метод наибольших остатков), внутри категории — по убыванию частоты.
 * Пропорция важна: 56 кейсов `capability` против 11 `location` — это и есть
 * структура входящего потока, и ошибка в редкой категории должна весить меньше.
 */
function selectCases(all: CorpusCase[], target: number): CorpusCase[] {
  const seen = new Set<string>();
  const unique = all.filter((c) => {
    const key = c.question.trim().toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const byCategory = new Map<string, CorpusCase[]>();
  for (const c of unique) {
    const list = byCategory.get(c.category) ?? [];
    list.push(c);
    byCategory.set(c.category, list);
  }
  for (const list of byCategory.values()) {
    list.sort((a, b) => b.freq - a.freq || b.confidence - a.confidence || a.question.localeCompare(b.question));
  }

  const total = unique.length;
  const quotas = [...byCategory.entries()].map(([category, list]) => {
    const exact = (list.length * target) / total;
    return { category, list, base: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });

  let assigned = quotas.reduce((s, q) => s + q.base, 0);
  const byRemainder = [...quotas].sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; assigned < Math.min(target, total); i++) {
    const q = byRemainder[i % byRemainder.length];
    if (q.base < q.list.length) {
      q.base++;
      assigned++;
    }
  }

  return quotas.flatMap((q) => q.list.slice(0, q.base));
}

interface JudgeVerdict {
  answers_question?: string;
  contradicts?: boolean;
  contradiction_detail?: string;
  missing_essential?: string;
  verdict: 'OK' | 'WEAK' | 'WRONG';
  reason?: string;
}

async function judge(question: string, bot: string, operator: string): Promise<JudgeVerdict> {
  const raw = await createChatCompletion({
    messages: [
      { role: 'system', content: JUDGE_PROMPT },
      {
        role: 'user',
        content: `ВОПРОС КЛИЕНТА:\n${question}\n\nОТВЕТ БОТА:\n${bot}\n\nОТВЕТ ОПЕРАТОРА (эталон):\n${operator}`,
      },
    ],
    temperature: 0,
  });
  return JSON.parse(normalizeJsonResponse(raw ?? '{}')) as JudgeVerdict;
}

interface Row {
  n: number;
  category: string;
  question: string;
  operator: string;
  freq: number;
  priceDependent: boolean;
  status: 'engine_failed' | 'measured';
  error?: string;
  delivery?: string;
  withheld?: boolean;
  answer?: string;
  outbound?: string;
  confidence?: number;
  confidenceLevel?: string;
  answerSource?: string;
  requiresHumanReview?: boolean;
  chunks?: number;
  priceCheckFired?: boolean;
  priceContradictions?: unknown;
  verdict?: string;
  judgeReason?: string;
  contradictionDetail?: string;
  missingEssential?: string;
}

function loadDone(): Map<number, Row> {
  const done = new Map<number, Row>();
  if (!existsSync(RESULTS)) return done;
  for (const line of readFileSync(RESULTS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Row;
      done.set(row.n, row);
    } catch {
      // Оборванная последняя строка после Ctrl-C — просто переспросим этот кейс.
    }
  }
  return done;
}

async function main() {
  if (process.env.FRESH === '1') {
    writeFileSync(RESULTS, '', 'utf8');
    writeFileSync(PROGRESS, '', 'utf8');
  }
  const all = JSON.parse(readFileSync(CORPUS, 'utf8')) as CorpusCase[];
  const cases = selectCases(all, TARGET);

  const done = loadDone();
  note(`\n=== ЗАМЕР АВТОНОМНОСТИ ===`);
  note(`корпус: ${all.length}, отобрано: ${cases.length}, уже измерено: ${done.size}`);
  const dist = new Map<string, number>();
  for (const c of cases) dist.set(c.category, (dist.get(c.category) ?? 0) + 1);
  note(`распределение: ${[...dist].map(([k, v]) => `${k}=${v}`).join(', ')}\n`);

  for (const [i, c] of cases.entries()) {
    const n = i + 1;
    if (n < RANGE_FROM || n > RANGE_TO) continue;
    if (done.has(n)) continue;

    note(`[${n}/${cases.length}] (${c.category}) ${c.question.slice(0, 70)}…`);
    await sleep(PACE_MS);

    const base = {
      n,
      category: c.category,
      question: c.question,
      operator: c.answer,
      freq: c.freq,
      priceDependent: c.price_dependent,
    };

    let result;
    try {
      result = await withRetry(() => answerQuestionEnhanced({ question: c.question, audience: 'client' }));
    } catch (e) {
      const row: Row = { ...base, status: 'engine_failed', error: String(e).slice(0, 300) };
      appendFileSync(RESULTS, `${JSON.stringify(row)}\n`, 'utf8');
      note(`      ДВИЖОК НЕ ОТВЕТИЛ после ${RETRIES} попыток`);
      continue;
    }

    const delivery = await resolveDelivery(result, 'client');
    const price = checkCertificationPriceAttribution(result.answer);

    const row: Row = {
      ...base,
      status: 'measured',
      delivery: delivery.decision,
      withheld: delivery.withheld,
      answer: result.answer,
      outbound: delivery.outboundAnswer,
      confidence: result.confidence,
      confidenceLevel: result.confidenceLevel,
      answerSource: result.answerSource,
      requiresHumanReview: result.requiresHumanReview,
      chunks: result.debug?.chunks?.length,
      priceCheckFired: !price.consistent,
      priceContradictions: price.consistent ? undefined : price.contradictions,
    };

    if (delivery.decision === 'answer') {
      try {
        const v = await withRetry(() => judge(c.question, result.answer, c.answer));
        row.verdict = v.verdict;
        row.judgeReason = v.reason;
        row.contradictionDetail = v.contradiction_detail;
        row.missingEssential = v.missing_essential;
      } catch {
        row.verdict = 'JUDGE_FAILED';
      }
    }

    appendFileSync(RESULTS, `${JSON.stringify(row)}\n`, 'utf8');
    note(
      `      ${row.verdict ?? '—'} · ${row.delivery} · ${Math.round((row.confidence ?? 0) * 100)}% ${row.confidenceLevel} · review=${row.requiresHumanReview} · src=${row.answerSource} · price=${row.priceCheckFired ? 'СРАБОТАЛА' : 'тихо'}`
    );
  }

  // Итог считается по фактически записанным строкам, а не по задуманному числу.
  const rows = [...loadDone().values()].filter(
    (r) => r.n <= cases.length && r.n >= RANGE_FROM && r.n <= RANGE_TO
  );
  const failed = rows.filter((r) => r.status === 'engine_failed').length;
  const measured = rows.filter((r) => r.status === 'measured');
  const sent = measured.filter((r) => r.delivery === 'answer');
  const wrong = sent.filter((r) => r.verdict === 'WRONG').length;
  const weak = sent.filter((r) => r.verdict === 'WEAK').length;
  const ok = sent.filter((r) => r.verdict === 'OK').length;
  const judgeFailed = sent.filter((r) => r.verdict === 'JUDGE_FAILED').length;

  note(`\n=== ИТОГ (по факту записанных строк) ===`);
  note(`отобрано: ${cases.length}, строк в файле: ${rows.length}`);
  note(`движок не ответил: ${failed}`);
  note(`измерено: ${measured.length}`);
  note(`delivery=answer: ${sent.length} · clarify: ${measured.filter((r) => r.delivery === 'clarify').length} · escalate: ${measured.filter((r) => r.delivery === 'escalate').length}`);
  note(`среди отправленных — OK ${ok}, WEAK ${weak}, WRONG ${wrong}, судья не ответил ${judgeFailed}`);
  note(`проверка цен сработала: ${measured.filter((r) => r.priceCheckFired).length}`);
  note(`результаты: ${RESULTS}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
