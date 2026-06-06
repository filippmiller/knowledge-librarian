/**
 * Pull real INCOMING client emails (2026) + the company's answer, cleaned,
 * so a human/model can actually READ them and decide what knowledge to extract.
 *   node scripts/email-mining/read-threads.mjs [N]
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';

const B = process.env.BITRIX24_WEBHOOK_URL;
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
  /\n>+\s/, /\nС уважением[,.]/i, /\nBest (regards|wishes)/i, /\nWith (kind |best )?regards/i,
  /\n-{4,}/, /\n--\s*\n/, /\nМногоканальный тел/i,
];
const stripHtml = (h) => (h || '')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
  // preserve structure: block-level tags become newlines BEFORE we drop tags
  .replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h[1-6]|\/blockquote)\s*\/?>/gi, '\n')
  .replace(/<blockquote/gi, '\n>')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#\d+;/g, '').replace(/&[a-z]+;/g, ' ');
const fresh = (b) => { let t = stripHtml(b), c = t.length; for (const re of MARK) { const m = t.match(re); if (m && m.index < c) c = m.index; } return t.slice(0, c).replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim(); };
const pii = (s) => s.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]').replace(/(\+?\d[\d\-\s()]{8,}\d)/g, '[phone]');
const looksLikeQuestion = (s) => s.length > 30 && (/[?？]/.test(s) || /\b(можно|нужно|нужен|нужна|как |какой|какая|сколько|когда|подскажите|возможно ли|есть ли|почему|что нужно|требуется|можете|могу ли)\b/i.test(s));

(async () => {
  const N = parseInt(process.argv[2] || '300');
  const since = '2026-01-01T00:00:00+03:00';
  let rows = [];
  for (let start = 0; start < N && start < 1000; start += 50) {
    const r = await call('crm.activity.list', {
      filter: { TYPE_ID: 4, DIRECTION: 1, '>=CREATED': since, OWNER_TYPE_ID: 2 },
      select: ['ID', 'OWNER_ID', 'CREATED', 'SUBJECT', 'DESCRIPTION'], order: { ID: 'DESC' }, start,
    });
    const got = r.result || []; rows.push(...got); if (got.length < 50) break;
  }
  // company answers per deal (outgoing), to attach
  const dealIds = [...new Set(rows.map(r => r.OWNER_ID))];
  const out = [];
  const questions = [];
  for (const r of rows) {
    const q = pii(fresh(r.DESCRIPTION));
    if (!looksLikeQuestion(q)) continue;
    questions.push({ dealId: r.OWNER_ID, id: r.ID, date: r.CREATED, subject: r.SUBJECT || '', question: q.slice(0, 700) });
  }
  mkdirSync('scratchpad', { recursive: true });
  writeFileSync('scratchpad/incoming-questions.json', JSON.stringify(questions, null, 2));
  console.log(`Incoming client emails fetched: ${rows.length}; question-like: ${questions.length}`);
  console.log(`Saved -> scratchpad/incoming-questions.json\n`);
  console.log('=== 30 REAL CLIENT QUESTIONS (verbatim, cleaned) ===');
  for (const q of questions.slice(0, 30)) {
    console.log(`\n#${q.id} · ${q.date.slice(0, 10)} · ${q.subject.slice(0, 55)}`);
    console.log('  ' + q.question.replace(/\n/g, '\n  '));
  }
})();
