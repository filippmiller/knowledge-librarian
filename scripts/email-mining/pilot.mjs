/**
 * PILOT: mine Q->A pairs from 2026 Bitrix CRM emails — script only, no LLM.
 * Proves the thread-reconstruction + cleaning logic before we invest in the
 * full pipeline. Reads env from .env (BITRIX24_WEBHOOK_URL).
 *
 *   node scripts/email-mining/pilot.mjs
 *
 * Output: scratchpad/email-pilot-pairs.json + console sample.
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';

const B = process.env.BITRIX24_WEBHOOK_URL;
if (!B) { console.error('BITRIX24_WEBHOOK_URL missing'); process.exit(1); }
const call = async (m, p = {}) => {
  const r = await fetch(B + m + '.json', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p),
  });
  return r.json();
};

// ── Cleaning: strip HTML, then cut everything from the first quote/signature marker.
const MONTHS = 'январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр';
const QUOTE_MARKERS = [
  /\n[^\n]*\bwrote:/i,                       // "On ... John wrote:"
  /\n[^\n]*\bписал\([аи]?\):/i,             // "X писал(а):"
  /\n[^\n]*\bписал[аи]?:/i,
  // Russian date-quote header, e.g. "Четверг, 28 мая 2026, 06:14 +03:00 от ..."
  new RegExp('\\n[^\\n]{0,40}\\d{1,2}\\s+(' + MONTHS + ')[а-я]*\\s+\\d{4}', 'i'),
  /\n[^\n]{0,30}\d{1,2}\.\d{2}\.\d{4},?\s+\d{1,2}:\d{2}/,  // "27.05.2026, 12:19,"
  /\n\s*(From|Sent|To|Subject|Reply-To|Кому|Тема|Дата|Отправлено):/i,
  /\nБудьте осторожны/i,                      // external-server banner
  /\nПисьмо с внешнего/i,
  /\nОтправлено из /i,
  /\nSent from my /i,
  /\n>+\s/,                                   // ">" quoted lines
  /\nС уважением[,.]/i,
  /\nBR[,.]/,
  /\nBest (regards|wishes)/i,
  /\nWith (kind |best )?regards/i,
  /\n-{4,}/,                                  // "----------------" quote divider
  /\n--\s*\n/,                                // signature delimiter
  /\nМногоканальный тел/i,
];
const stripHtml = (h) => (h || '')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#x[0-9a-f]+;/gi, '').replace(/&[a-z]+;/g, ' ');

const freshText = (body) => {
  let t = stripHtml(body);
  let cut = t.length;
  for (const re of QUOTE_MARKERS) { const m = t.match(re); if (m && m.index < cut) cut = m.index; }
  t = t.slice(0, cut);
  // PII scrub (pilot): emails, phones
  t = t.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]')
       .replace(/(\+?\d[\d\-\s()]{8,}\d)/g, '[phone]');
  return t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
};
const trivial = (s) => {
  const x = s.toLowerCase().replace(/[^a-zа-яё]/gi, '');
  if (s.length < 12) return true;
  return /^(спасибо|благодарю|оквсё|принято|хорошо|ок|thanks|thankyou|gotit)$/.test(x);
};

(async () => {
  const since = '2026-01-01T00:00:00+03:00';
  // Pull recent 2026 emails (both directions) WITH body, paginated to ~400.
  let rows = [];
  for (let start = 0; start < 400; start += 50) {
    const r = await call('crm.activity.list', {
      filter: { TYPE_ID: 4, '>=CREATED': since, OWNER_TYPE_ID: 2 }, // Deals only
      select: ['ID', 'OWNER_ID', 'DIRECTION', 'CREATED', 'SUBJECT', 'DESCRIPTION'],
      order: { ID: 'DESC' }, start,
    });
    const got = r.result || [];
    rows.push(...got);
    if (got.length < 50) break;
  }
  console.log(`Fetched ${rows.length} email activities (2026, Deals).`);

  // Group by Deal, sort ascending by time.
  const byDeal = {};
  for (const r of rows) (byDeal[r.OWNER_ID] ||= []).push(r);
  for (const id in byDeal) byDeal[id].sort((a, b) => a.CREATED.localeCompare(b.CREATED));

  // Pair incoming(client, DIRECTION=1) -> next outgoing(operator, DIRECTION=2).
  const pairs = [];
  for (const id in byDeal) {
    const tl = byDeal[id];
    for (let i = 0; i < tl.length - 1; i++) {
      if (tl[i].DIRECTION === '1') {
        // Answer = the NEXT message, only if it's outgoing. If the next message
        // is another incoming, this client message went unanswered directly —
        // skip it (prevents one reply mapping to several questions).
        const next = tl[i + 1];
        if (next.DIRECTION !== '2') continue;
        const ans = next;
        const q = freshText(tl[i].DESCRIPTION), a = freshText(ans.DESCRIPTION);
        if (trivial(q) || trivial(a)) continue;
        pairs.push({
          dealId: id, date: tl[i].CREATED, subject: tl[i].SUBJECT || '',
          question: q.slice(0, 800), answer: a.slice(0, 800),
        });
      }
    }
  }
  // Dedup exact-ish by first 60 chars of question
  const seen = new Set(); const uniq = [];
  for (const p of pairs) { const k = p.question.slice(0, 60).toLowerCase(); if (seen.has(k)) continue; seen.add(k); uniq.push(p); }

  mkdirSync('scratchpad', { recursive: true });
  writeFileSync('scratchpad/email-pilot-pairs.json', JSON.stringify(uniq, null, 2));
  console.log(`Built ${pairs.length} raw pairs, ${uniq.length} after near-dedup.`);
  console.log(`Saved -> scratchpad/email-pilot-pairs.json\n`);
  console.log('=== SAMPLE (first 12) ===');
  for (const p of uniq.slice(0, 12)) {
    console.log('\n— Deal ' + p.dealId + ' | ' + p.date.slice(0, 10) + ' | ' + p.subject.slice(0, 50));
    console.log('  Q: ' + p.question.replace(/\n/g, ' ').slice(0, 220));
    console.log('  A: ' + p.answer.replace(/\n/g, ' ').slice(0, 220));
  }
})();
