/**
 * Повторный замер на ТЕХ ЖЕ вопросах, что и базовый, но через движок в процессе.
 *
 * Почему не через прод: `run-out-of-corpus.ts` бьёт по HTTP в задеплоенное
 * приложение, то есть измеряет старый код. Здесь движок импортируется напрямую
 * и работает на продовой базе через `railway run` — так измеряется РАБОЧЕЕ
 * ДЕРЕВО, и прод при этом не трогается.
 *
 * Почему те же вопросы, а не новые переформулировки: базовый замер брал
 * формулировки, сгенерированные моделью. Сгенерировать новые значит сравнивать
 * два разных набора и не узнать, что сделали правки. Вопросы и операторские
 * эталоны читаются из отчёта базового замера.
 *
 * Запуск: railway run npx tsx scripts/rerun-out-of-corpus-inprocess.ts
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { answerQuestionEnhanced } from '../src/lib/ai/enhanced-answering-engine';
import { resolveDelivery } from '../src/lib/ai/delivery';
import { createChatCompletion, normalizeJsonResponse } from '../src/lib/ai/chat-provider';
import prisma from '../src/lib/db';

const BASELINE = 'docs/bot-audit/out-of-corpus-rephrased.md';
const OUT = 'docs/bot-audit/out-of-corpus-after-containment.md';
const PROGRESS = 'docs/bot-audit/.rerun-progress.log';

/** Пауза между вопросами. Без неё прогон валит провайдера: первая версия
 *  потеряла 8 ответов из 15 на `UND_ERR_SOCKET`. */
const PACE_MS = 4000;
const RETRIES = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function note(line: string): void {
  console.log(line);
  appendFileSync(PROGRESS, `${line}\n`, 'utf8');
}

/** Сетевой сбой провайдера — не результат замера, поэтому повторяем. */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const msg = String(e).slice(0, 120).replace(/\s+/g, ' ');
      note(`      попытка ${attempt}/${RETRIES} не удалась: ${msg}`);
      if (attempt < RETRIES) await sleep(attempt * 8000);
    }
  }
  throw lastError;
}

const JUDGE_PROMPT = `Ты строгий проверяющий в бюро переводов. Сравниваешь ответ бота с ответом, который реально дал клиенту опытный оператор на тот же по смыслу вопрос.

Оператор — эталон по СМЫСЛУ, но не по полноте: бот законно может назвать цену из прайса, которой оператор не назвал. Отсутствие факта у оператора само по себе не ошибка бота.

Ошибка бота — это:
· ответ не на заданный вопрос;
· противоречие оператору по существу (разные цены за одно и то же, «делаем» против «не делаем», разные сроки);
· пропуск условия, без которого ответ вводит в заблуждение.

Ответ строго JSON:
{"answers_question":"yes"|"partial"|"no","contradicts":true|false,"contradiction_detail":"","missing_essential":"","verdict":"OK"|"WEAK"|"WRONG","reason":""}

Вердикт применяй буквально: contradicts=true → WRONG; answers_question="no" → WRONG; "partial" или есть missing_essential → WEAK; иначе OK.`;

interface BaselineCase {
  question: string;
  baselineVerdict: string;
  operator: string;
}

/** Разбор отчёта базового замера: вопрос, его вердикт и операторский эталон. */
function parseBaseline(md: string): BaselineCase[] {
  const cases: BaselineCase[] = [];
  const blocks = md.split(/^### /m).slice(1);
  for (const block of blocks) {
    const headline = block.split('\n')[0];
    const m = headline.match(/^\[([^\]]+)\]\s*(.+)$/);
    if (!m) continue;
    const [, verdict, question] = m;

    const opIdx = block.indexOf('**Оператор (эталон):**');
    if (opIdx === -1) continue;
    const operator = block
      .slice(opIdx)
      .split('\n')
      .slice(1)
      .filter((l) => l.trimStart().startsWith('>'))
      .map((l) => l.trimStart().replace(/^>\s?/, ''))
      .join('\n')
      .trim();

    cases.push({ question: question.trim(), baselineVerdict: verdict.trim(), operator });
  }
  return cases;
}

async function judge(question: string, bot: string, operator: string) {
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
  return JSON.parse(normalizeJsonResponse(raw ?? '{}')) as {
    verdict: 'OK' | 'WEAK' | 'WRONG';
    reason?: string;
    contradiction_detail?: string;
    missing_essential?: string;
  };
}

async function main() {
  writeFileSync(PROGRESS, '', 'utf8');
  const cases = parseBaseline(readFileSync(BASELINE, 'utf8'));
  note(`Кейсов из базового замера: ${cases.length}\n`);

  const rows: string[] = [];
  let sent = 0;
  let ok = 0;
  let weak = 0;
  let wrong = 0;
  let withheldGrounding = 0;

  let failedCases = 0;

  for (const [i, c] of cases.entries()) {
    note(`[${i + 1}/${cases.length}] ${c.question.slice(0, 70)}…`);
    if (i > 0) await sleep(PACE_MS);

    let result;
    try {
      result = await withRetry('engine', () =>
        answerQuestionEnhanced({ question: c.question, audience: 'client' })
      );
    } catch (e) {
      failedCases++;
      note(`      ОШИБКА ДВИЖКА после ${RETRIES} попыток`);
      rows.push(`### [ОШИБКА] ${c.question}\n\n\`${String(e).slice(0, 200)}\`\n\n---\n`);
      continue;
    }

    const delivery = await resolveDelivery(result, 'client');
    const would = delivery.decision;

    let verdictLabel: string;
    let judgeNote = '';
    if (would === 'answer') {
      sent++;
      try {
        const v = await withRetry('judge', () => judge(c.question, result.answer, c.operator));
        verdictLabel = v.verdict;
        if (v.verdict === 'OK') ok++;
        else if (v.verdict === 'WEAK') weak++;
        else wrong++;
        judgeNote = [v.reason, v.contradiction_detail, v.missing_essential].filter(Boolean).join(' | ');
      } catch {
        verdictLabel = 'СУДЬЯ НЕ ОТВЕТИЛ';
      }
    } else {
      verdictLabel = would === 'clarify' ? 'УТОЧНЕНИЕ' : 'НЕ ОТПРАВЛЕН';
      if (result.requiresHumanReview) withheldGrounding++;
    }

    note(
      `      ${verdictLabel} · ${would} · ${Math.round(result.confidence * 100)}% ${result.confidenceLevel} · review=${result.requiresHumanReview} · чанков=${result.debug?.chunks?.length ?? '?'}`
    );

    rows.push(
      [
        `### [${verdictLabel}] ${c.question}`,
        '',
        `Базовый замер: **${c.baselineVerdict}**`,
        '',
        `\`решение: ${would}\` · \`уверенность: ${Math.round(result.confidence * 100)}% ${result.confidenceLevel}\` · \`requiresHumanReview: ${result.requiresHumanReview}\``,
        '',
        judgeNote ? `**Судья:** ${judgeNote}\n` : '',
        '**Черновик движка:**',
        '',
        result.answer.split('\n').map((l) => `> ${l}`).join('\n'),
        '',
        delivery.withheld ? `**Клиенту ушло бы вместо этого:**\n\n> ${delivery.outboundAnswer}\n` : '',
        '**Оператор (эталон):**',
        '',
        c.operator.split('\n').map((l) => `> ${l}`).join('\n'),
        '',
        '---',
        '',
      ].join('\n')
    );
  }

  const header = [
    '# Замер после containment-правок (движок в процессе, продовая база)',
    '',
    `Те же 15 вопросов, что и в [базовом замере](out-of-corpus-rephrased.md). Движок импортирован напрямую из рабочего дерева, база продовая. Прод не задействован.`,
    '',
    '## Итог',
    '',
    '| показатель | базовый | после правок |',
    '|---|---|---|',
    `| бот отправил бы ответ | 12 | ${sent} |`,
    `| OK | 9 | ${ok} |`,
    `| WEAK | 2 | ${weak} |`,
    `| WRONG | 1 | ${wrong} |`,
    `| удержано с requiresHumanReview | — | ${withheldGrounding} |`,
    '',
    `Ошибок (по определению владельца — противоречие фактам): базовый **1 из 12**, после правок **${wrong} из ${sent || 1}**.`,
    '',
    '## Подробно',
    '',
  ].join('\n');

  writeFileSync(OUT, header + rows.join('\n'), 'utf8');
  note(`\n=== ИТОГ ===`);
  note(`измерено: ${cases.length - failedCases} из ${cases.length} (сбоев провайдера: ${failedCases})`);
  note(`отправлено: ${sent} (базовый: 12)`);
  note(`OK: ${ok} (базовый 9), WEAK: ${weak} (2), WRONG: ${wrong} (1)`);
  note(`удержано с requiresHumanReview: ${withheldGrounding}`);
  note(`отчёт: ${OUT}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
