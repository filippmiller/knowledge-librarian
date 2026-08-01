/**
 * Главная метрика владельца: доля ошибок среди ОТПРАВЛЕННЫХ ответов.
 *
 * Цель поставлена так: отвечать автономно на максимум обращений при доле ошибок
 * среди отправленных не выше 2%. До сих пор её не измерял ни один инструмент.
 * Замер автономности считал ошибки среди всех ответов движка, прогон по
 * контурам — удержания. Это ДРУГИЕ величины: удержание не является ошибкой, а
 * ошибка среди отправленных — единственное, что обещано клиенту.
 *
 * Разрыв найден независимым аудитом Kimi K3.
 *
 * ЧТО ИМЕННО СЧИТАЕТСЯ. Знаменатель — ответы, которые политика доставки
 * ОТПУСТИЛА собеседнику (`delivery === 'answer'`). Удержанные и уточняющие
 * вопросы в знаменатель не входят: первые клиент не видел, вторые не являются
 * утверждением о фактах. Числитель — из отпущенных те, которые судья по ответу
 * живого оператора признал WRONG.
 *
 * WEAK (неполнота) ошибкой НЕ считается — так поставлена задача владельцем:
 * «ошибка = противоречие фактам, неполнота ошибкой не считается». Доля WEAK
 * печатается отдельно, потому что она про другое: про то, доволен ли клиент.
 *
 * Интервал считается по Уилсону: при двух-трёх ошибках нормальное приближение
 * врёт и может уйти за границы отрезка, а цель — 2%, то есть счёт идёт на
 * единицы.
 *
 * Запуск:
 *   railway run npx tsx scripts/measure-sent-error-rate.ts
 *   LIMIT=60 RANGE=1-30 SUFFIX=.a railway run npx tsx scripts/measure-sent-error-rate.ts
 *   FRESH=1 … — начать заново
 *   REPORT=1 npx tsx scripts/measure-sent-error-rate.ts — только пересчитать
 */
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { answerQuestionEnhanced } from '../src/lib/ai/enhanced-answering-engine';
import { resolveDelivery } from '../src/lib/ai/delivery';
import { createChatCompletion, normalizeJsonResponse } from '../src/lib/ai/chat-provider';
import type { AutoAnswerBlocker } from '../src/lib/ai/delivery-decision';
import prisma from '../src/lib/db';

const CORPUS = 'docs/email-bot/may2026-knowledge-base-final.json';
const SUFFIX = process.env.SUFFIX ?? '';
const RESULTS = `docs/bot-audit/.sent-error-rate${SUFFIX}.jsonl`;
const LIMIT = Number(process.env.LIMIT ?? 40);
const [RANGE_FROM, RANGE_TO] = (process.env.RANGE ?? '1-99999').split('-').map(Number);
const AUDIENCE = (process.env.AUDIENCE ?? 'client') as 'client' | 'internal';
const PACE_MS = Number(process.env.PACE_MS ?? 3000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Мерка судьи скопирована из замера автономности без изменений: сравнивать
 *  замеры можно только при одинаковой мерке. */
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
}

interface Row {
  n: number;
  head: string;
  question: string;
  operator: string;
  freq: number;
  audience: string;
  status: 'ok' | 'failed';
  error?: string;
  /** Отпущен ли ответ собеседнику. Только эти строки идут в знаменатель. */
  delivery?: string;
  blocker?: AutoAnswerBlocker | null;
  /** Текст, который РЕАЛЬНО увидел собеседник, а не черновик. */
  outbound?: string;
  confidence?: number;
  verdict?: 'OK' | 'WEAK' | 'WRONG' | 'JUDGE_FAILED';
  judgeReason?: string;
}

function currentHead(): string {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
    return dirty ? `${head}+грязное` : head;
  } catch {
    return 'неизвестна';
  }
}

/** Интервал Уилсона: при цели 2% ошибки считаются единицами. */
function wilson(successes: number, total: number): [number, number] {
  if (total === 0) return [0, 0];
  const z = 1.96;
  const p = successes / total;
  const d = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

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
  return JSON.parse(normalizeJsonResponse(raw ?? '{}')) as { verdict?: Row['verdict']; reason?: string };
}

function loadAll(): Row[] {
  const map = new Map<number, Row>();
  for (const f of readdirSync('docs/bot-audit').filter((x) => x.startsWith('.sent-error-rate') && x.endsWith('.jsonl'))) {
    for (const line of readFileSync(`docs/bot-audit/${f}`, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Row;
        const existing = map.get(row.n);
        // Успешный повтор побеждает прошлый сбой.
        if (!existing || (existing.status === 'failed' && row.status === 'ok')) map.set(row.n, row);
      } catch {
        /* оборванная строка */
      }
    }
  }
  return [...map.values()].sort((a, b) => a.n - b.n);
}

function report(): void {
  const rows = loadAll();
  const measured = rows.filter((r) => r.status === 'ok');
  const sent = measured.filter((r) => r.delivery === 'answer');
  const judged = sent.filter((r) => r.verdict && r.verdict !== 'JUDGE_FAILED');
  const wrong = judged.filter((r) => r.verdict === 'WRONG');
  const weak = judged.filter((r) => r.verdict === 'WEAK');

  const [lo, hi] = wilson(wrong.length, judged.length);
  const freqTotal = measured.reduce((s, r) => s + r.freq, 0);
  const freqSent = sent.reduce((s, r) => s + r.freq, 0);

  console.log(`\n=== ДОЛЯ ОШИБОК СРЕДИ ОТПРАВЛЕННЫХ ===`);
  console.log(`ревизия: ${rows[0]?.head ?? '—'} · контур: ${rows[0]?.audience ?? '—'}`);
  console.log(`\nизмерено вопросов: ${measured.length}${rows.length - measured.length ? ` (сбоев ${rows.length - measured.length})` : ''}`);
  console.log(`ОТПРАВЛЕНО собеседнику: ${sent.length} (${pct(sent.length / Math.max(1, measured.length))}), по частоте ${pct(freqSent / Math.max(1, freqTotal))}`);
  console.log(`из них оценено судьёй:   ${judged.length}`);
  console.log(`\nОШИБОК среди отправленных: ${wrong.length} — ${judged.length ? pct(wrong.length / judged.length) : '—'} (ДИ ${pct(lo)}–${pct(hi)})`);
  console.log(`ЦЕЛЬ: не выше 2,0%  →  ${judged.length === 0 ? 'нет данных' : hi <= 0.02 ? 'ДОСТИГНУТА' : lo > 0.02 ? 'НЕ достигнута' : 'НЕ ДОКАЗАНА (интервал накрывает цель)'}`);
  console.log(`\nнеполных (WEAK, ошибкой не считаются): ${weak.length} — ${judged.length ? pct(weak.length / judged.length) : '—'}`);

  if (wrong.length > 0) {
    console.log(`\n--- ОШИБКИ, УШЕДШИЕ СОБЕСЕДНИКУ (разбирать глазами) ---`);
    for (const r of wrong) {
      console.log(`\n[${r.n}] ×${r.freq} ${r.question.slice(0, 88)}`);
      console.log(`   судья: ${(r.judgeReason ?? '').slice(0, 200)}`);
      console.log(`   ответ: ${(r.outbound ?? '').slice(0, 200).replace(/\n/g, ' ')}`);
    }
  }
  console.log(`\nсырые строки: ${RESULTS}`);
}

async function main() {
  if (process.env.REPORT === '1') {
    report();
    return;
  }
  if (process.env.FRESH === '1') writeFileSync(RESULTS, '', 'utf8');

  const head = currentHead();
  const all = (JSON.parse(readFileSync(CORPUS, 'utf8')) as CorpusCase[])
    .slice()
    .sort((a, b) => b.freq - a.freq || a.question.localeCompare(b.question))
    .slice(0, LIMIT);

  const done = new Set(loadAll().filter((r) => r.status === 'ok').map((r) => r.n));
  console.log(`\n=== ЗАМЕР ДОЛИ ОШИБОК СРЕДИ ОТПРАВЛЕННЫХ ===`);
  console.log(`ревизия: ${head} · кейсов: ${all.length} · уже измерено: ${done.size} · контур: ${AUDIENCE}`);

  for (const [i, c] of all.entries()) {
    const n = i + 1;
    if (n < RANGE_FROM || n > RANGE_TO) continue;
    if (done.has(n)) continue;

    await sleep(PACE_MS);
    const base: Row = {
      n,
      head,
      question: c.question,
      operator: c.answer,
      freq: c.freq,
      audience: AUDIENCE,
      status: 'ok',
    };

    let row: Row;
    try {
      const result = await answerQuestionEnhanced({ question: c.question, audience: AUDIENCE });
      const delivery = await resolveDelivery(result, AUDIENCE);
      row = {
        ...base,
        delivery: delivery.decision,
        blocker: delivery.blocker,
        outbound: delivery.outboundAnswer,
        confidence: result.confidence,
      };

      // Судья спрашивается ТОЛЬКО про отправленное. Судить удержанный черновик
      // здесь незачем: он собеседнику не показывался, и в метрику не входит.
      if (delivery.decision === 'answer') {
        try {
          const v = await judge(c.question, delivery.outboundAnswer, c.answer);
          row.verdict = v.verdict ?? 'JUDGE_FAILED';
          row.judgeReason = v.reason;
        } catch {
          row.verdict = 'JUDGE_FAILED';
        }
      }
    } catch (e) {
      row = { ...base, status: 'failed', error: String(e).slice(0, 300) };
    }

    appendFileSync(RESULTS, `${JSON.stringify(row)}\n`, 'utf8');
    console.log(
      `[${n}/${all.length}] ×${c.freq} ${row.status === 'failed' ? 'СБОЙ' : `${row.delivery} ${row.verdict ?? ''}`} · ${c.question.slice(0, 54)}…`
    );
  }

  report();
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
