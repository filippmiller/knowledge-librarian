/**
 * Proper knowledge extraction: feed a FULL per-Deal email thread to a smart
 * model (gpt-4o) and pull REUSABLE knowledge (capabilities, requirements,
 * process, policy, pricing-policy) — NOT transactional pairs.
 *
 *   node scripts/email-mining/extract-knowledge.mjs [numDeals]
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';

const B = process.env.BITRIX24_WEBHOOK_URL;
const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.EXTRACT_MODEL || 'gpt-4o';
if (!B || !KEY) { console.error('Need BITRIX24_WEBHOOK_URL + OPENAI_API_KEY'); process.exit(1); }

const call = async (m, p = {}) => {
  const r = await fetch(B + m + '.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  return r.json();
};

// ── cleaning (preserve structure, cut quotes/signatures) ──────────────────────
const MONTHS = 'январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр';
const MARK = [
  /\n[^\n]*\bwrote:/i, /\n[^\n]*\bписал[аи]?\)?:/i,
  new RegExp('\\n[^\\n]{0,40}\\d{1,2}\\s+(' + MONTHS + ')[а-я]*\\s+\\d{4}', 'i'),
  /\n[^\n]{0,30}\d{1,2}\.\d{2}\.\d{4},?\s+\d{1,2}:\d{2}/,
  /\n\s*(From|Sent|To|Subject|Reply-To|Кому|Тема|Дата|Отправлено):/i,
  /\nБудьте осторожны/i, /\nПисьмо с внешнего/i, /\nОтправлено из /i, /\nSent from my /i,
  /\n>+\s/, /\nС уважением[,.]/i, /\nBest (regards|wishes)/i, /\nWith (kind |best )?regards/i,
  /\n-{4,}/, /\n--\s*\n/, /\nМногоканальный тел/i,
];
const stripHtml = (h) => (h || '')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#\d+;/g, '').replace(/&[a-z]+;/g, ' ');
const fresh = (b) => { let t = stripHtml(b), c = t.length; for (const re of MARK) { const m = t.match(re); if (m && m.index < c) c = m.index; } return t.slice(0, c).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim(); };
const pii = (s) => s.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]').replace(/(\+?\d[\d\-\s()]{8,}\d)/g, '[phone]');

// ── extraction prompt ─────────────────────────────────────────────────────────
const SYSTEM = `Ты — аналитик базы знаний агентства ПЕРЕВОДОВ и ЛЕГАЛИЗАЦИИ документов (Санкт-Петербург, «Аврора»). На вход — переписка оператора с клиентом по ОДНОЙ сделке (КЛИЕНТ/КОМПАНИЯ, по времени). Твоя задача — извлечь ТОЛЬКО переиспользуемые ЗНАНИЯ, которые помогут отвечать БУДУЩИМ клиентам.

ИЗВЛЕКАЙ (это знания):
- capability — что компания делает/не делает: нотариальная копия, апостиль, легализация для страны X, доверенность в офисе, выезд, заверение чужого перевода и т.п.
- requirement — что нужно для услуги: оригинал, скан полного разворота паспорта, подписанный бланк, личное присутствие, согласие на обработку и т.п.
- process — как устроена услуга: перевод между двумя иностранными языками идёт через русский; «копия с копии»; стадии апостиля; где ставится апостиль (ЗАГС/Минюст/МВД); что делать с документом из другого региона.
- policy — правила: предоплата (%), кто может забрать документы (по доверенности), рабочие часы, обмен закрывающими по ЭДО, способы оплаты.
- location — офисы, самовывоз, доставка как услуга.
- pricing_policy — КАК считается цена (по знакам готового перевода, заверение +за документ, срочность), но НЕ конкретные суммы.

НЕ ИЗВЛЕКАЙ (выбрось полностью):
- Статус конкретного заказа: «когда готово», «оплату произвёл», «документ получил», «на какой стадии».
- Разовые факты: конкретные суммы, даты готовности, имена людей, номера заказов, ссылки на оплату.
- Благодарности, согласования, приветствия, «принято/ок».
- Всё, что нельзя переиспользовать для ДРУГОГО клиента.

ПРАВИЛА ОБОБЩЕНИЯ:
1. Убери имена, номера заказов, конкретные суммы и даты.
2. Вопрос сформулируй как ОБЩИЙ (как будущий клиент спросит), а не про конкретный заказ.
3. Ответ — переиспользуемое ПРАВИЛО компании, своими словами, кратко и точно.
4. Если ответ зависел от конкретной цены/срока — поставь price_dependent=true и в ответе опиши политику, НЕ называй сумму.
5. confidence: насколько уверенно это общее правило компании (0..1). Если знание спорное/разовое — ниже.
6. Если в треде нет переиспользуемых знаний — верни {"items":[]}.

Верни СТРОГО JSON:
{"items":[{"type":"capability|requirement|process|policy|location|pricing_policy","question":"...","answer":"...","price_dependent":bool,"confidence":0.0}]}`;

const extract = async (transcript) => {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL, temperature: 0, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: transcript }],
    }),
  });
  const j = await r.json();
  if (!j.choices) throw new Error(JSON.stringify(j).slice(0, 200));
  return JSON.parse(j.choices[0].message.content).items || [];
};

const pool = async (items, n, fn) => {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; try { out.push(...await fn(items[k])); } catch (e) { /* skip */ } }
  }));
  return out;
};

(async () => {
  const numDeals = parseInt(process.argv[2] || '80');
  const since = '2026-01-01T00:00:00+03:00';
  // pull recent 2026 emails (both directions), group into deal threads
  let rows = [];
  for (let start = 0; start < 800; start += 50) {
    const r = await call('crm.activity.list', {
      filter: { TYPE_ID: 4, '>=CREATED': since, OWNER_TYPE_ID: 2 },
      select: ['OWNER_ID', 'DIRECTION', 'CREATED', 'SUBJECT', 'DESCRIPTION'], order: { ID: 'DESC' }, start,
    });
    const got = r.result || []; rows.push(...got); if (got.length < 50) break;
  }
  const byDeal = {};
  for (const r of rows) (byDeal[r.OWNER_ID] ||= []).push(r);
  // keep threads with >=1 incoming + >=1 outgoing, build transcripts
  const threads = [];
  for (const id in byDeal) {
    const tl = byDeal[id].sort((a, b) => a.CREATED.localeCompare(b.CREATED));
    if (!tl.some(x => x.DIRECTION === '1') || !tl.some(x => x.DIRECTION === '2')) continue;
    const lines = tl.map(x => {
      const who = x.DIRECTION === '1' ? 'КЛИЕНТ' : 'КОМПАНИЯ';
      const t = pii(fresh(x.DESCRIPTION));
      return t ? `${who}: ${t}` : null;
    }).filter(Boolean);
    if (lines.length < 2) continue;
    threads.push({ dealId: id, transcript: lines.join('\n').slice(0, 4000) });
  }
  const sample = threads.slice(0, numDeals);
  console.log(`Threads built: ${threads.length}; extracting knowledge from ${sample.length} with ${MODEL}...`);

  const items = await pool(sample, 6, async (t) => (await extract(t.transcript)).map(it => ({ ...it, dealId: t.dealId })));

  mkdirSync('scratchpad', { recursive: true });
  writeFileSync('scratchpad/email-knowledge.json', JSON.stringify(items, null, 2));

  const byType = {};
  for (const it of items) byType[it.type] = (byType[it.type] || 0) + 1;
  console.log(`\n=== EXTRACTED ${items.length} knowledge items from ${sample.length} threads ===`);
  console.log('  by type:', JSON.stringify(byType));
  console.log('  price_dependent:', items.filter(i => i.price_dependent).length);
  console.log('  saved -> scratchpad/email-knowledge.json\n');

  // show grouped by type
  for (const type of Object.keys(byType).sort((a, b) => byType[b] - byType[a])) {
    console.log(`\n#### ${type.toUpperCase()} (${byType[type]}) ####`);
    for (const it of items.filter(i => i.type === type).slice(0, 6)) {
      console.log(`  Q: ${it.question}`);
      console.log(`  A: ${it.answer}${it.price_dependent ? '  [цена из живого расчёта]' : ''}`);
      console.log('');
    }
  }
})();
