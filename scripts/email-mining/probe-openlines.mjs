import 'dotenv/config';
const B = process.env.BITRIX24_WEBHOOK_URL;
const call = async (m, p = {}) => {
  const r = await fetch(B + m + '.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  return r.json().catch(() => ({}));
};

// 1) Configured open lines (names often reveal the channel)
const cfg = await call('imopenlines.config.list.get', {});
console.log('=== CONFIGURED OPEN LINES ===');
if (cfg.error) console.log('  X', cfg.error);
else for (const l of (cfg.result || [])) console.log(`  line ${l.ID}: "${l.LINE_NAME || l.NAME || ''}" active=${l.ACTIVE}`);

// 2) Recent open-line session activities → inspect one fully for channel + chat link
const act = await call('crm.activity.list', {
  filter: { PROVIDER_ID: 'IMOPENLINES_SESSION' }, order: { ID: 'DESC' },
  select: ['ID', 'SUBJECT', 'PROVIDER_TYPE_ID', 'CREATED', 'SETTINGS', 'PROVIDER_PARAMS', 'ASSOCIATED_ENTITY_ID'],
});
const rows = act.result || [];
console.log(`\n=== recent IMOPENLINES_SESSION activities: ${rows.length} ===`);
for (const r of rows.slice(0, 10)) {
  console.log(`  #${r.ID} ${r.CREATED?.slice(0,10)} type=${r.PROVIDER_TYPE_ID} subj="${(r.SUBJECT||'').slice(0,40)}"`);
}
// full dump of one
if (rows[0]) {
  const full = await call('crm.activity.get', { id: rows[0].ID });
  console.log('\n=== FULL activity (channel hints in SETTINGS/PROVIDER_PARAMS/SUBJECT) ===');
  const r = full.result || {};
  console.log('  SUBJECT:', r.SUBJECT);
  console.log('  PROVIDER_TYPE_ID:', r.PROVIDER_TYPE_ID);
  console.log('  SETTINGS:', JSON.stringify(r.SETTINGS).slice(0, 400));
  console.log('  PROVIDER_PARAMS:', JSON.stringify(r.PROVIDER_PARAMS).slice(0, 500));
}

// 3) Distinct channel/source across many sessions via SUBJECT/PROVIDER_TYPE_ID
const byType = {};
for (const r of rows) byType[r.PROVIDER_TYPE_ID || '?'] = (byType[r.PROVIDER_TYPE_ID || '?'] || 0) + 1;
console.log('\n  PROVIDER_TYPE_ID distribution:', JSON.stringify(byType));
