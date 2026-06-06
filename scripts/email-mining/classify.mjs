/**
 * Classify + canonicalize mined email pairs with a cheap LLM (gpt-4o-mini).
 * Reads scratchpad/email-pilot-pairs.json, decides keep/drop, and rewrites each
 * kept pair into a clean reusable Q->A. Writes scratchpad/email-pilot-clean.json.
 *
 *   node scripts/email-mining/classify.mjs
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';

const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error('OPENAI_API_KEY missing'); process.exit(1); }
const MODEL = 'gpt-4o-mini';

const SYSTEM = `Ты обрабатываешь пары "письмо клиента -> ответ компании" для агентства переводов и легализации документов (Россия). Задача: решить, годится ли пара как переиспользуемое знание для обучения бота-помощника оператора, и очистить её.

ОСТАВЛЯЙ (keep=true) любую пару, где клиент задаёт реальный вопрос/запрос, а компания даёт содержательный ответ: цена, срок, требования к документам, процесс подачи/доставки, нотариат/апостиль/легализация, инструкции по оплате/счетам.

ОТБРАСЫВАЙ (keep=false): пустое/битое извлечение (вопрос = подпись типа "Sent from my iPhone"); чистые подтверждения без сути ("спасибо", "ок", "согласовано", "принято", "ждём"); внутреннюю логистику без переиспользуемой информации; случаи, где ответ целиком зависит от невидимого вложения.

Для keep=true ОЧИСТИ и ОБОБЩИ:
- question_clean: чистый вопрос клиента в общей форме (убери имена, подписи, цитаты, контакты; сохрани суть и конкретику типа вида документа/страны).
- answer_clean: только содержательный ответ компании (убери подписи, цитаты, баннеры; сохрани цифры, сроки, условия).
- topic: одна из [price, deadline, requirements, process, notary, apostille, legalization, payment, delivery, other].

Верни СТРОГО JSON: {"keep":bool,"reason":"кратко","topic":"...","question_clean":"...","answer_clean":"..."}`;

const classify = async (pair) => {
  const body = {
    model: MODEL, temperature: 0, response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `ВОПРОС КЛИЕНТА:\n${pair.question}\n\nОТВЕТ КОМПАНИИ:\n${pair.answer}` },
    ],
  };
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.choices) throw new Error(JSON.stringify(j).slice(0, 200));
  return JSON.parse(j.choices[0].message.content);
};

// simple concurrency pool
const pool = async (items, n, fn) => {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: String(e) }; } }
  }));
  return out;
};

(async () => {
  const pairs = JSON.parse(readFileSync('scratchpad/email-pilot-pairs.json', 'utf8'));
  console.log(`Classifying ${pairs.length} pairs with ${MODEL}...`);
  const res = await pool(pairs, 6, async (p) => ({ src: p, cls: await classify(p) }));

  const kept = res.filter((x) => x.cls && x.cls.keep && !x.cls.error);
  const dropped = res.filter((x) => x.cls && !x.cls.keep && !x.cls.error);
  const errors = res.filter((x) => !x.cls || x.cls.error);

  const clean = kept.map((x) => ({
    dealId: x.src.dealId, date: x.src.date, topic: x.cls.topic,
    question: x.cls.question_clean, answer: x.cls.answer_clean,
  }));
  writeFileSync('scratchpad/email-pilot-clean.json', JSON.stringify(clean, null, 2));

  // topic distribution
  const topics = {};
  for (const k of kept) topics[k.cls.topic] = (topics[k.cls.topic] || 0) + 1;

  console.log(`\n=== RESULT ===`);
  console.log(`  kept:    ${kept.length} (${Math.round(kept.length / pairs.length * 100)}%)`);
  console.log(`  dropped: ${dropped.length}`);
  console.log(`  errors:  ${errors.length}`);
  console.log(`  topics:  ${JSON.stringify(topics)}`);
  console.log(`  saved -> scratchpad/email-pilot-clean.json\n`);

  console.log('=== 10 CLEAN KEPT PAIRS ===');
  for (const c of clean.slice(0, 10)) {
    console.log(`\n━━━ [${c.topic}] Deal ${c.dealId} · ${c.date.slice(0, 10)} ━━━`);
    console.log('  Q: ' + c.question.replace(/\n/g, ' '));
    console.log('  A: ' + c.answer.replace(/\n/g, ' '));
  }
  console.log('\n=== 5 DROPPED (why) ===');
  for (const d of dropped.slice(0, 5)) console.log(`  ✗ ${d.cls.reason} | Q="${(d.src.question || '').replace(/\n/g, ' ').slice(0, 50)}"`);
})();
