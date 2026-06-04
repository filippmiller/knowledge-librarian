/**
 * Fetch + clean email threads for a date range into transcripts (NO LLM).
 * Output is read by Claude (Sonnet) / subagents for knowledge extraction.
 *
 *   node scripts/email-mining/build-threads.mjs 2026-05-01 2026-06-01
 *
 * Writes scratchpad/threads-<from>.json : [{dealId, n, transcript}]
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';

const B = process.env.BITRIX24_WEBHOOK_URL;
if (!B) { console.error('BITRIX24_WEBHOOK_URL missing'); process.exit(1); }
const from = process.argv[2] || '2026-05-01';
const to = process.argv[3] || '2026-06-01';
const ownerType = parseInt(process.argv[4] || '2'); // 1=Lead, 2=Deal
const ownerTag = ownerType === 1 ? 'lead' : 'deal';
const call = async (m, p = {}) => {
  const r = await fetch(B + m + '.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  return r.json();
};
const MONTHS = 'январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр';
const MARK = [
  /\n[^\n]*\bwrote:/i, /\n[^\n]*\bписал[аи]?\)?:/i,
  new RegExp('\\n[^\\n]{0,40}\\d{1,2}\\s+(' + MONTHS + ')[а-я]*\\s+\\d{4}', 'i'),
  /\n[^\n]{0,30}\d{1,2}\.\d{2}\.\d{4},?\s+\d{1,2}:\d{2}/,
  /\n\s*(From|Sent|To|Subject|Reply-To|Кому|Тема|Дата|Отправлено):/i,
  /\nБудьте осторожны/i, /\nПисьмо с внешнего/i, /\nОтправлено из /i, /\nSent from my /i,
  /\n>+\s/, /\nС уважением[,.]/i, /\nBR[,.]/, /\nBest (regards|wishes)/i, /\nWith (kind |best )?regards/i,
  /\n-{4,}/, /\n--\s*\n/, /\nМногоканальный тел/i,
];
const stripHtml = (h) => (h || '')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#\d+;/g, '').replace(/&[a-z]+;/g, ' ');
const fresh = (b) => { let t = stripHtml(b), c = t.length; for (const re of MARK) { const m = t.match(re); if (m && m.index < c) c = m.index; } return t.slice(0, c).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim(); };
const pii = (s) => s.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]').replace(/(\+?\d[\d\-\s()]{8,}\d)/g, '[phone]');

(async () => {
  let rows = [];
  for (let start = 0; start < 6000; start += 50) {
    const r = await call('crm.activity.list', {
      filter: { TYPE_ID: 4, '>=CREATED': from + 'T00:00:00+03:00', '<CREATED': to + 'T00:00:00+03:00', OWNER_TYPE_ID: ownerType },
      select: ['OWNER_ID', 'DIRECTION', 'CREATED', 'SUBJECT', 'DESCRIPTION'], order: { ID: 'DESC' }, start,
    });
    const got = r.result || []; rows.push(...got);
    if (got.length < 50) break;
  }
  const byDeal = {};
  for (const r of rows) (byDeal[r.OWNER_ID] ||= []).push(r);
  const threads = [];
  for (const id in byDeal) {
    const tl = byDeal[id].sort((a, b) => a.CREATED.localeCompare(b.CREATED));
    if (!tl.some(x => x.DIRECTION === '1') || !tl.some(x => x.DIRECTION === '2')) continue;
    const lines = tl.map(x => {
      const who = x.DIRECTION === '1' ? 'КЛИЕНТ' : 'КОМПАНИЯ';
      const t = pii(fresh(x.DESCRIPTION));
      return t && t.length > 2 ? `${who}: ${t}` : null;
    }).filter(Boolean);
    if (lines.length < 2) continue;
    threads.push({ dealId: id, n: lines.length, transcript: lines.join('\n').slice(0, 3500) });
  }
  mkdirSync('scratchpad', { recursive: true });
  const out = `scratchpad/threads-${ownerTag}-${from}.json`;
  writeFileSync(out, JSON.stringify(threads, null, 2));
  console.log(`Range ${from}..${to} [${ownerTag}]: ${rows.length} emails, ${Object.keys(byDeal).length} entities, ${threads.length} usable threads (>=1 in +1 out).`);
  console.log(`Saved -> ${out}`);
})();
