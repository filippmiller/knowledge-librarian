// Измеряет две болезни против настоящей цели проекта — «отвечать из корпуса»:
//
//   1. РАЗРЫВ АТРИБУЦИИ — ответ называет сумму, которой нет в показанных
//      пользователю цитатах, хотя в корпусе она есть. Ответ верный, а
//      основание под ним — постороннее. Человек, сверяющий одно с другим,
//      решит, что бот врёт.
//   2. УКЛОНЕНИЕ — «уточню у коллеги / пришлите скан» вместо ответа, при
//      высокой уверенности и непустых цитатах.
//
// Каждое число из ответа раскладывается по ТРЁМ корзинам, и это главное:
//   OK        — сумма есть в тексте показанных цитат;
//   MISCITED  — в цитатах нет, но есть в корпусе (тарифы или debug-контекст);
//   UNGROUNDED— нет нигде. Только это — кандидат в галлюцинации.
//
// Без такого разделения «цитата не подтверждает» и «число выдумано»
// сливаются в одну цифру, а это разные болезни с разной ценой.
//
//   ADMIN_PASSWORD=... node scripts/audit-answer-attribution.mjs

import fs from 'node:fs/promises';
import https from 'node:https';

const BASE = 'https://avrora-library-production.up.railway.app';
const ADMIN_USER = process.env.ADMIN_USER || 'filipp';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) throw new Error('ADMIN_PASSWORD environment variable is required');
const AUTH = 'Basic ' + Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString('base64');

const QUESTIONS = [
  { id: 'P1', q: 'Сколько стоит нотариальное заверение перевода одного документа?' },
  { id: 'P2', q: 'Какая стоимость двуязычного нотариального заверения перевода?' },
  { id: 'P3', q: 'Сколько стоит апостиль?' },
  { id: 'P4', q: 'Сколько стоит перевод паспорта с английского языка?' },
  { id: 'P5', q: 'Сколько стоит заверение перевода печатью бюро?' },
  { id: 'P6', q: 'Сколько стоит срочный перевод?' },
  { id: 'P7', q: 'Сколько стоит консульская легализация документа?' },
  { id: 'P8', q: 'Сколько стоит истребование документа из ЗАГСа?' },
  { id: 'P9', q: 'Сколько стоит нотариальная копия одной страницы?' },
  { id: 'P10', q: 'Сколько стоит перевод диплома с приложением на немецкий язык?' },
  { id: 'R1', q: 'Нужен ли оригинал документа для нотариального заверения перевода?' },
  { id: 'R2', q: 'К чему подшивается нотариальный перевод — к оригиналу или к копии?' },
  { id: 'R3', q: 'Где ставить апостиль — на оригинал или на перевод?' },
  { id: 'R4', q: 'Сколько дней делается апостиль на свидетельство о браке в Санкт-Петербурге?' },
  { id: 'R5', q: 'Можно ли заверить перевод, сделанный другим переводчиком?' },
  { id: 'R6', q: 'Какие документы нужны для перевода водительского удостоверения?' },
];

const DODGE_MARKERS = [
  'уточню', 'вернусь с точным', 'у коллеги', 'пришлите', 'свяжется с вами',
  'напишите нам', 'позвоните', 'менеджер', 'уточните у нас',
];

function post(path, payload, timeout = 200000) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = https.request(`${BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: AUTH,
        'Content-Length': body.length,
      },
      timeout,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`bad JSON (status ${res.statusCode}): ${data.slice(0, 200)}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end(body);
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    https.get(`${BASE}${path}`, { headers: { Authorization: AUTH } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`bad JSON: ${data.slice(0, 200)}`)); }
      });
    }).on('error', reject);
  });
}

/** Числа-суммы из текста: «1 100 рублей», «**1 300**», «2500 ₽».
 *  Порог в 3 знака отсекает «2 документа» и «5 дней», которые суммами не
 *  являются и в цитатах искаться не должны. */
function extractAmounts(text) {
  const out = new Set();
  const re = /(\d[\d\s ]{1,9}\d|\d{3,})\s*(?:руб|₽|рублей|рубля)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = m[1].replace(/[\s ]/g, '');
    if (n.length >= 3) out.add(n);
  }
  // Жирные числа без валюты рядом — в этом корпусе так подают цены.
  const bold = /\*\*\s*(\d[\d\s ]{1,9}\d|\d{3,})\s*\*\*/g;
  while ((m = bold.exec(text)) !== null) {
    const n = m[1].replace(/[\s ]/g, '');
    if (n.length >= 3) out.add(n);
  }
  return [...out];
}

const norm = (s) => (s || '').replace(/[\s ]/g, '');

async function main() {
  process.stdout.write('Загружаю тарифы...\n');
  const tariffRaw = JSON.stringify(await get('/api/tariffs?limit=1000'));
  const tariffNums = new Set((tariffRaw.match(/\d+/g) || []));

  const results = [];
  for (const t of QUESTIONS) {
    process.stdout.write(`${t.id} ... `);
    let d;
    try {
      d = await post('/api/ask', { question: t.q, includeDebug: true });
    } catch (e) {
      process.stdout.write(`ОШИБКА ${e.message}\n`);
      results.push({ ...t, error: e.message });
      continue;
    }

    const answer = d.answer || '';
    const citationText = norm((d.citations || []).map((c) => c.quote || '').join(' | '));
    const contextText = norm(JSON.stringify(d.debug || {}) + JSON.stringify(d.primarySource || {}) +
      JSON.stringify(d.supplementarySources || []));

    const amounts = extractAmounts(answer);
    const buckets = { ok: [], miscited: [], ungrounded: [] };
    for (const a of amounts) {
      if (citationText.includes(a)) buckets.ok.push(a);
      else if (contextText.includes(a) || tariffNums.has(a)) buckets.miscited.push(a);
      else buckets.ungrounded.push(a);
    }

    const lower = answer.toLowerCase();
    const dodgeHits = DODGE_MARKERS.filter((m) => lower.includes(m));
    const dodge = dodgeHits.length > 0 && amounts.length === 0;

    results.push({
      ...t,
      answer,
      confidence: d.confidence,
      confidenceLevel: d.confidenceLevel,
      needsClarification: d.needsClarification,
      answerWithheld: d.answerWithheld,
      citations: (d.citations || []).map((c) => ({ code: c.ruleCode, quote: c.quote })),
      citationCount: (d.citations || []).length,
      maxSimilarity: d.debug?.searchStats?.maxSimilarity ?? null,
      ungroundedValuesReported: d.debug?.reasons?.ungroundedValues ?? null,
      amounts, buckets, dodge, dodgeHits,
    });
    process.stdout.write(
      `conf=${d.confidenceLevel} cites=${(d.citations || []).length} ` +
      `суммы=${amounts.length} ok=${buckets.ok.length} miscited=${buckets.miscited.length} ` +
      `ungrounded=${buckets.ungrounded.length}${dodge ? ' DODGE' : ''}\n`
    );
  }

  await fs.writeFile('attribution-audit.json', JSON.stringify(results, null, 2), 'utf8');

  const ok = results.filter((r) => !r.error);
  const withAmounts = ok.filter((r) => r.amounts.length > 0);
  const miscited = ok.filter((r) => r.buckets.miscited.length > 0);
  const ungrounded = ok.filter((r) => r.buckets.ungrounded.length > 0);
  const dodges = ok.filter((r) => r.dodge);
  const highConfDodge = dodges.filter((r) => r.confidenceLevel === 'high');

  console.log('\n' + '='.repeat(64));
  console.log(`Отвечено:                       ${ok.length}/${QUESTIONS.length}`);
  console.log(`Ответов с суммами:              ${withAmounts.length}`);
  console.log(`  из них с MISCITED-суммой:     ${miscited.length}  <- разрыв атрибуции`);
  console.log(`  из них с UNGROUNDED-суммой:   ${ungrounded.length}  <- кандидаты в галлюцинации`);
  console.log(`Уклонений (без единой суммы):   ${dodges.length}, из них при confidence=high: ${highConfDodge.length}`);
  console.log('='.repeat(64));
  console.log('\nПодробно:');
  for (const r of ok) {
    const flags = [];
    if (r.buckets.miscited.length) flags.push(`MISCITED:${r.buckets.miscited.join(',')}`);
    if (r.buckets.ungrounded.length) flags.push(`UNGROUNDED:${r.buckets.ungrounded.join(',')}`);
    if (r.dodge) flags.push('DODGE');
    console.log(
      `  ${r.id.padEnd(4)} conf=${String(r.confidenceLevel).padEnd(6)} cites=${String(r.citationCount).padEnd(2)} ` +
      `sim=${r.maxSimilarity === null ? 'n/a' : r.maxSimilarity.toFixed(4)} ${flags.join(' ') || '—'}`
    );
  }
  console.log('\nПолные ответы: attribution-audit.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
