import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const load = (f) => existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];
let all = [];
// deal emails (already lightly deduped earlier run)
for (const x of load('scratchpad/may-knowledge-all.json')) all.push({ ...x, src_type: 'email-deal' });
for (let i = 1; i <= 5; i++) for (const x of load(`scratchpad/kn-lead-${i}.json`)) all.push({ ...x, src_type: 'email-lead' });
for (let i = 1; i <= 3; i++) for (const x of load(`scratchpad/kn-chat-${i}.json`)) all.push({ ...x, src_type: 'chat' });

writeFileSync('scratchpad/all-raw-knowledge.json', JSON.stringify(all, null, 2));
const byType = {}, bySrc = {};
for (const x of all) { byType[x.type] = (byType[x.type] || 0) + 1; bySrc[x.src_type] = (bySrc[x.src_type] || 0) + 1; }
console.log('TOTAL raw items:', all.length);
console.log('by source:', JSON.stringify(bySrc));
console.log('by type:', JSON.stringify(byType));

// price catalog -> file for the synthesizer
const B = process.env.BITRIX24_WEBHOOK_URL;
const call = async (m, p = {}) => { const r = await fetch(B + m + '.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }); return r.json(); };
const pr = await call('crm.product.list', { select: ['ID', 'NAME', 'PRICE', 'CURRENCY_ID'] });
const catalog = (pr.result || []).map(p => ({ name: p.NAME, price: Number(p.PRICE) || null, currency: p.CURRENCY_ID }));
writeFileSync('scratchpad/price-catalog.json', JSON.stringify(catalog, null, 2));
console.log('price catalog services:', catalog.length, '-> scratchpad/price-catalog.json');
