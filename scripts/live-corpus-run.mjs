/**
 * Гоняет выборку реальных клиентских вопросов из корпуса Bitrix через живой
 * продовый движок и сравнивает ответ бота с историческим ответом оператора.
 *
 * Источник вопросов: docs/email-bot/may2026-knowledge-base-final.json
 * (180 кейсов, добытых из переписки Bitrix за май 2026).
 *
 * Запуск: node scripts/live-corpus-run.mjs [N] [internal|client]
 * По умолчанию N=30, контур client. Пейсинг 3.5 с — лимит /api/ask 20 запросов
 * в минуту (src/lib/rate-limiter.ts:117).
 *
 * Внутренний контур эндпоинт отдаёт только по сессии сотрудника, поэтому без
 * cookie запрос всегда обслуживается как клиентский — это и есть проверяемое
 * поведение.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.ASK_URL ?? 'https://avrora-library-production.up.railway.app/api/ask';
const SAMPLE_SIZE = Number(process.argv[2] ?? 30);
const AUDIENCE = process.argv[3] === 'internal' ? 'internal' : 'client';
const PACE_MS = 3500;

const corpus = JSON.parse(readFileSync('docs/email-bot/may2026-knowledge-base-final.json', 'utf8'));

// Стратифицированная выборка: доля каждой категории сохраняется, внутри
// категории берём самые частотные вопросы — то, что реально спрашивают чаще.
function pickSample(items, size) {
  const byCategory = new Map();
  for (const item of items) {
    const list = byCategory.get(item.category) ?? [];
    list.push(item);
    byCategory.set(item.category, list);
  }
  // Квоты по методу наибольшего остатка: независимое округление давало сумму
  // больше size, и последующий slice() молча выбрасывал самые мелкие категории
  // (в первом прогоне так потерялась половина категории location).
  const entries = [...byCategory.entries()];
  const exact = entries.map(([c, l]) => ({ c, l, share: (l.length / items.length) * size }));
  const quotas = exact.map((e) => ({ ...e, base: Math.max(1, Math.floor(e.share)) }));
  let allocated = quotas.reduce((sum, q) => sum + q.base, 0);
  const byRemainder = [...quotas].sort(
    (a, b) => (b.share - Math.floor(b.share)) - (a.share - Math.floor(a.share))
  );
  let i = 0;
  while (allocated < size && byRemainder.length > 0) {
    const q = byRemainder[i % byRemainder.length];
    if (q.base < q.l.length) {
      q.base++;
      allocated++;
    }
    i++;
    if (i > size * 4) break;
  }
  const picked = [];
  for (const q of quotas) {
    const sorted = [...q.l].sort((a, b) => (b.freq ?? 0) - (a.freq ?? 0));
    picked.push(...sorted.slice(0, q.base).map((item) => ({ ...item, category: q.c })));
  }
  return picked;
}

async function ask(question) {
  const started = Date.now();
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ question, includeDebug: true, audience: AUDIENCE }),
  });
  const ms = Date.now() - started;
  if (!res.ok) return { error: `HTTP ${res.status}`, ms };
  const json = await res.json();
  return { ...json, ms };
}

// Зеркало продовой политики доставки (src/lib/telegram/auto-answer-policy.ts).
// Держим здесь копию осознанно: скрипт бьёт по HTTP и не может импортировать
// серверный модуль, тянущий prisma.
const MIN_CONFIDENCE = 0.5;
function decideDelivery(r) {
  if (r.scenarioClarification) return 'clarify';
  if (r.requiresHumanReview) return 'escalate';
  if (r.answerSource === 'general_ai') return 'escalate';
  if (r.confidenceLevel === 'low' || r.confidenceLevel === 'insufficient') return 'escalate';
  return (r.confidence ?? 0) >= MIN_CONFIDENCE ? 'answer' : 'escalate';
}

const sample = pickSample(corpus, SAMPLE_SIZE);
const rows = [];

for (const [i, item] of sample.entries()) {
  process.stdout.write(`[${i + 1}/${sample.length}] ${item.question.slice(0, 60)}… `);
  const r = await ask(item.question);
  if (r.error) {
    console.log(r.error);
    rows.push({ item, error: r.error });
  } else {
    const decision = decideDelivery(r);
    console.log(`${decision} ${Math.round((r.confidence ?? 0) * 100)}% ${r.answerSource ?? '-'} ${r.ms}ms`);
    rows.push({ item, result: r, decision });
  }
  if (i < sample.length - 1) await new Promise((res) => setTimeout(res, PACE_MS));
}

// ---- агрегаты ----
const ok = rows.filter((r) => r.result);
const count = (fn) => ok.filter(fn).length;
const tally = (fn) => {
  const m = new Map();
  for (const r of ok) {
    const k = fn(r) ?? '—';
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

const lines = [];
lines.push(`# Прогон реальных вопросов клиентов через живой прод — контур ${AUDIENCE}`);
lines.push('');
lines.push(`Источник вопросов: \`docs/email-bot/may2026-knowledge-base-final.json\` (${corpus.length} кейсов из переписки Bitrix, май 2026).`);
lines.push(`Эндпоинт: \`${BASE}\`. Выборка стратифицирована по категориям, внутри категории — самые частотные вопросы.`);
lines.push(`Успешных прогонов: ${ok.length} из ${rows.length}.`);
lines.push('');
lines.push('## Агрегаты');
lines.push('');
lines.push('### Что бот сделал бы с вопросом (политика auto-answer, порог 50%)');
lines.push('');
lines.push('| решение | вопросов | доля |');
lines.push('|---|---|---|');
for (const [k, v] of tally((r) => r.decision)) {
  lines.push(`| ${k} | ${v} | ${Math.round((v / ok.length) * 100)}% |`);
}
lines.push('');
lines.push('### Источник ответа');
lines.push('');
lines.push('| answerSource | вопросов |');
lines.push('|---|---|');
for (const [k, v] of tally((r) => r.result.answerSource)) lines.push(`| ${k} | ${v} |`);
lines.push('');
lines.push('### Уровень уверенности');
lines.push('');
lines.push('| confidenceLevel | вопросов |');
lines.push('|---|---|');
for (const [k, v] of tally((r) => r.result.confidenceLevel)) lines.push(`| ${k} | ${v} |`);
lines.push('');
lines.push('### По категориям корпуса');
lines.push('');
lines.push('| категория | всего | answer | clarify | escalate |');
lines.push('|---|---|---|---|---|');
for (const [cat] of tally((r) => r.item.category)) {
  const inCat = ok.filter((r) => r.item.category === cat);
  const c = (d) => inCat.filter((r) => r.decision === d).length;
  lines.push(`| ${cat} | ${inCat.length} | ${c('answer')} | ${c('clarify')} | ${c('escalate')} |`);
}
lines.push('');
lines.push(`Вопросов, помеченных в корпусе как зависящие от цены: ${count((r) => r.item.price_dependent)} из ${ok.length}.`);
lines.push(`Среднее время ответа: ${Math.round(ok.reduce((s, r) => s + r.result.ms, 0) / ok.length)} мс.`);
lines.push('');
lines.push('---');
lines.push('');
lines.push('## Подробно по каждому вопросу');
lines.push('');

for (const [i, row] of rows.entries()) {
  lines.push(`### ${i + 1}. ${row.item.question}`);
  lines.push('');
  lines.push(`\`категория: ${row.item.category}\` · \`частота в корпусе: ${row.item.freq ?? '—'}\` · \`price_dependent: ${row.item.price_dependent}\``);
  lines.push('');
  if (row.error) {
    lines.push(`**ОШИБКА:** ${row.error}`);
    lines.push('');
    continue;
  }
  const r = row.result;
  lines.push(`**Решение политики: \`${row.decision}\`** · уверенность ${Math.round((r.confidence ?? 0) * 100)}% (${r.confidenceLevel}) · источник \`${r.answerSource ?? '—'}\` · review: ${r.requiresHumanReview ?? '—'}${r.scenarioKey ? ` · сценарий \`${r.scenarioKey}\`` : ''}`);
  lines.push('');
  if (r.scenarioClarification) {
    lines.push(`**Уточнение @ \`${r.scenarioClarification.atNodeKey}\`:** ${r.scenarioClarification.prompt} → ${r.scenarioClarification.options.map((o) => o.label).join(' | ')}`);
    lines.push('');
  }
  lines.push('**Ответ бота:**');
  lines.push('');
  lines.push('> ' + (r.answer ?? '').split('\n').join('\n> '));
  lines.push('');
  if (r.citations?.length) {
    lines.push('**Цитаты, на которые сослался движок:**');
    lines.push('');
    for (const c of r.citations.slice(0, 4)) {
      lines.push(`- \`${c.ruleCode ?? c.documentTitle ?? '?'}\` (${(c.relevanceScore ?? 0).toFixed(2)}): ${(c.quote ?? '').slice(0, 180)}`);
    }
    lines.push('');
  }
  lines.push('**Исторический ответ оператора:**');
  lines.push('');
  lines.push('> ' + (row.item.answer ?? '').split('\n').join('\n> '));
  lines.push('');
  lines.push('---');
  lines.push('');
}

mkdirSync('docs/bot-audit', { recursive: true });
writeFileSync('docs/bot-audit/live-30-sample-run.md', lines.join('\n'), 'utf8');
console.log('\nОтчёт: docs/bot-audit/live-30-sample-run.md');
