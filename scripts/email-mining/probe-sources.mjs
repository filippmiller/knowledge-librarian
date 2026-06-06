import 'dotenv/config';
const B = process.env.BITRIX24_WEBHOOK_URL;
const call = async (m, p = {}) => {
  const r = await fetch(B + m + '.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  return r.json().catch(() => ({}));
};
const t = async (m, p = {}) => { const j = await call(m, p); console.log(j.error ? `  X ${m} — ${j.error}` : `  OK ${m} — total=${j.total ?? 'n/a'}`); return j; };

console.log('== PRICE / CATALOG (source of truth for prices) ==');
const pr = await t('crm.product.list', { select: ['ID', 'NAME', 'PRICE', 'CURRENCY_ID'] });
for (const p of (pr.result || []).slice(0, 12)) console.log(`     - ${(p.NAME || '').slice(0, 55)} = ${p.PRICE} ${p.CURRENCY_ID || ''}`);
await t('crm.productsection.list', {});

console.log('== OTHER CHANNELS (May 2026) ==');
const may = { '>=CREATED': '2026-05-01T00:00:00+03:00', '<CREATED': '2026-06-01T00:00:00+03:00' };
const ol = await call('crm.activity.list', { filter: { PROVIDER_ID: 'IMOPENLINES_SESSION', ...may }, select: ['ID'] });
console.log('  open-line sessions:', ol.total ?? '?');
const ca = await call('crm.activity.list', { filter: { PROVIDER_ID: 'VOXIMPLANT_CALL', ...may }, select: ['ID'] });
console.log('  calls:', ca.total ?? '?');
const em = await call('crm.activity.list', { filter: { TYPE_ID: 4, ...may }, select: ['ID'] });
console.log('  all emails:', em.total ?? '?');
