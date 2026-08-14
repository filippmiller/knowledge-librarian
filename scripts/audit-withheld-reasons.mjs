// Почему ответ не доехал до клиента. Собирает по каждому вопросу причину
// удержания (debug.reasons.humanReview) и поля, от которых зависит политика
// доставки, — чтобы чинить преобладающую причину, а не первую попавшуюся.
//
//   ADMIN_PASSWORD=... node scripts/audit-withheld-reasons.mjs

import fs from 'node:fs/promises';
import https from 'node:https';

const BASE = 'https://avrora-library-production.up.railway.app';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD environment variable is required');
const AUTH = 'Basic ' + Buffer.from(`${process.env.ADMIN_USER || 'filipp'}:${ADMIN_PASSWORD}`).toString('base64');

const QUESTIONS = [
  ['P1', 'Сколько стоит нотариальное заверение перевода одного документа?'],
  ['P2', 'Какая стоимость двуязычного нотариального заверения перевода?'],
  ['P3', 'Сколько стоит апостиль?'],
  ['P4', 'Сколько стоит перевод паспорта с английского языка?'],
  ['P5', 'Сколько стоит заверение перевода печатью бюро?'],
  ['P6', 'Сколько стоит срочный перевод?'],
  ['P7', 'Сколько стоит консульская легализация документа?'],
  ['P8', 'Сколько стоит истребование документа из ЗАГСа?'],
  ['P9', 'Сколько стоит нотариальная копия одной страницы?'],
  ['P10', 'Сколько стоит перевод диплома с приложением на немецкий язык?'],
  ['R1', 'Нужен ли оригинал документа для нотариального заверения перевода?'],
  ['R2', 'К чему подшивается нотариальный перевод — к оригиналу или к копии?'],
  ['R3', 'Где ставить апостиль — на оригинал или на перевод?'],
  ['R4', 'Сколько дней делается апостиль на свидетельство о браке в Санкт-Петербурге?'],
  ['R5', 'Можно ли заверить перевод, сделанный другим переводчиком?'],
  ['R6', 'Какие документы нужны для перевода водительского удостоверения?'],
];

function ask(question) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ question, includeDebug: true }), 'utf8');
    const req = https.request(`${BASE}/api/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: AUTH,
        'Content-Length': body.length,
      },
      timeout: 200000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { reject(new Error(data.slice(0, 200))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

const rows = [];
for (const [id, q] of QUESTIONS) {
  process.stdout.write(`${id} ... `);
  let d;
  try { d = await ask(q); } catch (e) { process.stdout.write(`ОШИБКА ${e.message}\n`); continue; }
  const reasons = (d.debug?.reasons?.humanReview ?? []).map((r) => r.reason);
  const details = (d.debug?.reasons?.humanReview ?? []).map((r) => r.detail);
  rows.push({
    id, q,
    withheld: d.answerWithheld === true,
    confidence: d.confidence,
    confidenceLevel: d.confidenceLevel,
    requiresHumanReview: d.requiresHumanReview === true,
    answerSource: d.answerSource,
    reasons, details,
    answer: d.answer,
  });
  process.stdout.write(
    `withheld=${d.answerWithheld === true} conf=${d.confidenceLevel}/${Number(d.confidence).toFixed(2)} ` +
    `src=${d.answerSource ?? '-'} reasons=[${reasons.join(',') || '-'}]\n`
  );
}

await fs.writeFile('withheld-audit.json', JSON.stringify(rows, null, 2), 'utf8');

const withheld = rows.filter((r) => r.withheld);
const tally = new Map();
for (const r of withheld) {
  const key = r.reasons.length ? r.reasons.join('+') : `нет причин контроля (conf=${r.confidenceLevel}, src=${r.answerSource})`;
  tally.set(key, (tally.get(key) ?? 0) + 1);
}

console.log('\n' + '='.repeat(60));
console.log(`Удержано от клиента: ${withheld.length} из ${rows.length}`);
console.log('Причины:');
for (const [key, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${n}x  ${key}`);
}
console.log('='.repeat(60));
for (const r of withheld) {
  console.log(`\n${r.id} conf=${r.confidenceLevel}/${Number(r.confidence).toFixed(2)} src=${r.answerSource}`);
  r.details.forEach((d) => console.log(`   → ${String(d).slice(0, 220)}`));
}
console.log('\nПолные данные: withheld-audit.json');
