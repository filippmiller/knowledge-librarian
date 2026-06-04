import 'dotenv/config';
const B = process.env.BITRIX24_WEBHOOK_URL;
const call = async (m, p = {}) => {
  const r = await fetch(B + m + '.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  return r.json().catch(() => ({}));
};

// 1) Recent dialogs the webhook user can see — find OPEN LINE chats and their channel
const rec = await call('im.recent.get', {});
const items = rec.result?.items || [];
console.log(`im.recent.get items: ${items.length}`);

const lines = items.filter(it => (it.chat?.entity_type === 'LINES') || it.type === 'lines' || it.type === 'open');
console.log(`open-line chats in recent: ${lines.length}\n`);

// connector code is encoded in chat.entity_id like "imol|<connector>|<line>|<user>"
const channelOf = (it) => {
  const eid = it.chat?.entity_id || '';
  const parts = String(eid).split('|');
  return parts[1] || it.chat?.entity_type || '?';
};
const byChannel = {};
for (const it of lines) { const c = channelOf(it); (byChannel[c] ||= []).push(it); }
console.log('=== CHANNELS SEEN (open lines) ===');
for (const c in byChannel) console.log(`  ${c}: ${byChannel[c].length} chats`);

console.log('\n=== SAMPLE: latest message per open-line chat (channel | name | last msg) ===');
for (const it of lines.slice(0, 12)) {
  const last = (it.message?.text || '').replace(/\[[^\]]+\]/g, '').replace(/\n/g, ' ').slice(0, 60);
  console.log(`  [${channelOf(it)}] ${(it.title || it.chat?.name || '').slice(0, 28)} | ${last}`);
}

// 2) Pull actual incoming messages from one open-line dialog to prove we read inbound text
const first = lines[0];
if (first) {
  const did = first.chat?.dialog_id || first.dialog_id;
  const msgs = await call('im.dialog.messages.get', { DIALOG_ID: did, LIMIT: 8 });
  const arr = msgs.result?.messages || [];
  console.log(`\n=== messages from ${did} (${channelOf(first)}) ===`);
  for (const m of arr.slice(-6)) console.log(`  author ${m.author_id}: ${(m.text || '').replace(/\n/g, ' ').slice(0, 70)}`);
}

// 3) Check Wazzup / connector list capability
const conn = await call('imconnector.connector.list.get', {});
console.log('\nimconnector.connector.list.get:', conn.error ? ('X ' + conn.error) : JSON.stringify(conn.result).slice(0, 300));
