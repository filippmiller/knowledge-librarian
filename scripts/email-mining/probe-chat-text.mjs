import 'dotenv/config';
const B = process.env.BITRIX24_WEBHOOK_URL;
const call = async (m, p = {}) => {
  const r = await fetch(B + m + '.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  return r.json().catch(() => ({}));
};

// get a recent Telegram open-line session activity, dump all keys to find the chat id
const act = await call('crm.activity.list', {
  filter: { PROVIDER_ID: 'IMOPENLINES_SESSION' }, order: { ID: 'DESC' },
  select: ['*'],
});
const r0 = (act.result || [])[0];
console.log('activity keys:', Object.keys(r0 || {}).join(', '));
console.log('ASSOCIATED_ENTITY_ID:', r0?.ASSOCIATED_ENTITY_ID);
const full = await call('crm.activity.get', { id: r0.ID });
const fr = full.result || {};
console.log('full keys:', Object.keys(fr).join(', '));

// USER_CODE -> session id is the last segment; chat dialog for OL is often chat<ID>
const uc = fr.PROVIDER_PARAMS?.USER_CODE || '';
console.log('USER_CODE:', uc);
const sessionId = uc.split('|').pop();

// try session history by session id
let h = await call('imopenlines.session.history.get', { SESSION_ID: sessionId });
console.log('\nimopenlines.session.history.get(', sessionId, '):', h.error ? ('X ' + h.error) : 'ok');
if (!h.error) console.log(JSON.stringify(h.result).slice(0, 400));

// try reading the chat messages directly via the bound chat id, if present
for (const key of ['ASSOCIATED_ENTITY_ID']) {
  const cid = fr[key];
  if (!cid) continue;
  for (const did of [`chat${cid}`, cid]) {
    const msgs = await call('im.dialog.messages.get', { DIALOG_ID: did, LIMIT: 6 });
    if (!msgs.error && msgs.result?.messages?.length) {
      console.log(`\n=== messages via ${did} ===`);
      for (const m of msgs.result.messages.slice(-6)) console.log(`  author ${m.author_id}: ${(m.text || '').replace(/\n/g, ' ').slice(0, 80)}`);
    } else {
      console.log(`\n${did}: ${msgs.error || 'no messages'}`);
    }
  }
}
