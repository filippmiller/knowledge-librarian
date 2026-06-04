/**
 * Build open-line CHAT transcripts (Telegram/WhatsApp/VK/Avito) for a month.
 *   node scripts/email-mining/build-chats.mjs 2026-05
 * Writes scratchpad/chats-<month>.json : [{sessionId, channel, n, transcript}]
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';

const B = process.env.BITRIX24_WEBHOOK_URL;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const call = async (m, p = {}, tries = 4) => {
  for (let a = 0; a < tries; a++) {
    try {
      const r = await fetch(B + m + '.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
      return await r.json();
    } catch (e) {
      if (a === tries - 1) return {};
      await sleep(500 * (a + 1)); // backoff on transient socket errors
    }
  }
  return {};
};
const month = process.argv[2] || '2026-05';
const from = `${month}-01T00:00:00+03:00`;
const to = `${month}-31T23:59:59+03:00`;

const cleanBB = (s) => (s || '')
  .replace(/\[USER=[^\]]*\][^\[]*\[\/USER\]/gi, '').replace(/\[URL=[^\]]*\]([^\[]*)\[\/URL\]/gi, '$1')
  .replace(/\[\/?[a-z][^\]]*\]/gi, '').replace(/\s+/g, ' ').trim();
const isSystem = (t) => !t || /^Начат новый диалог|завершил[аи]? (работу|диалог)|перевёл диалог|оценка|^Сессия/i.test(t);
const pii = (s) => s.replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[email]').replace(/(\+?\d[\d\-\s()]{8,}\d)/g, '[phone]');

// 1) company staff ids (everything else in a chat = client)
const staff = new Set();
for (let s = 0; s < 500; s += 50) {
  const u = await call('user.get', { start: s, ADMIN_MODE: 'Y' });
  const got = u.result || []; for (const x of got) staff.add(String(x.ID));
  if (got.length < 50) break;
}

// 2) May open-line sessions
let acts = [];
for (let s = 0; s < 2000; s += 50) {
  const a = await call('crm.activity.list', {
    filter: { PROVIDER_ID: 'IMOPENLINES_SESSION', '>=CREATED': from, '<=CREATED': to },
    select: ['ID', 'SUBJECT', 'PROVIDER_PARAMS'], order: { ID: 'DESC' }, start: s,
  });
  const got = a.result || []; acts.push(...got);
  if (got.length < 50) break;
}
console.log(`staff ids: ${staff.size}; May open-line sessions: ${acts.length}`);

const channelOf = (uc) => (uc || '').split('|')[0].replace(/^ank_/, '').replace(/chats_app24_/, 'chatapp_') || '?';

const threads = [];
let i = 0;
for (const a of acts) {
  const uc = a.PROVIDER_PARAMS?.USER_CODE || '';
  const sessionId = uc.split('|').pop();
  const channel = channelOf(uc);
  const h = await call('imopenlines.session.history.get', { SESSION_ID: sessionId });
  if (h.error || !h.result?.message) { continue; }
  const msgs = Object.values(h.result.message).sort((x, y) => String(x.date).localeCompare(String(y.date)));
  const lines = [];
  for (const m of msgs) {
    const t = pii(cleanBB(m.text));
    if (isSystem(t) || t.length < 2) continue;
    const who = staff.has(String(m.senderid)) ? 'КОМПАНИЯ' : 'КЛИЕНТ';
    lines.push(`${who}: ${t}`);
  }
  if (lines.filter(l => l.startsWith('КЛИЕНТ')).length && lines.filter(l => l.startsWith('КОМПАНИЯ')).length)
    threads.push({ sessionId, channel, n: lines.length, transcript: lines.join('\n').slice(0, 3500) });
  if (++i % 40 === 0) console.log(`  processed ${i}/${acts.length}...`);
}

mkdirSync('scratchpad', { recursive: true });
const out = `scratchpad/chats-${month}.json`;
writeFileSync(out, JSON.stringify(threads, null, 2));
const ch = {}; for (const t of threads) ch[t.channel] = (ch[t.channel] || 0) + 1;
console.log(`Usable chat threads: ${threads.length}. Channels: ${JSON.stringify(ch)}`);
console.log(`Saved -> ${out}`);
