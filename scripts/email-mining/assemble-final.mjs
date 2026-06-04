import { readFileSync, writeFileSync, existsSync } from 'fs';

const TYPES = ['capability', 'requirement', 'process', 'pricing_policy', 'policy', 'location'];
const TITLE = {
  capability: 'Услуги и возможности', requirement: 'Требования к документам',
  process: 'Процесс', pricing_policy: 'Цены — политика расчёта',
  policy: 'Правила (оплата, хранение, ЭДО, ответственность)', location: 'Офисы, график, доставка',
};
const load = (f) => existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : [];

let all = [];
for (const t of TYPES) for (const x of load(`scratchpad/dedup/${t}.json`)) all.push({ category: t, ...x });

// price catalog reference
const catalog = load('scratchpad/price-catalog.json').filter(c => c.price);

writeFileSync('scratchpad/knowledge-base-final.json', JSON.stringify(all, null, 2));

let md = `# База знаний «Аврора» — Май 2026 (на ревью)\n\n`;
md += `Источники: письма Сделок+Лидов и чаты открытых линий (Telegram/WhatsApp/VK) за май 2026.\n`;
md += `Воронка: **406 сырых пунктов → ${all.length} канонических правил** после дедупа по типам.\n`;
md += `Цены конкретных сумм НЕ заучены — берутся из каталога услуг (ниже). \`×N\` = сколько раз правило повторилось (приоритет/надёжность).\n\n`;

md += `## 💰 Прайс-каталог (источник истины по ценам, из Битрикса)\n\n| Услуга | Цена |\n|---|---|\n`;
for (const c of catalog) md += `| ${c.name} | ${c.price} ${c.currency} |\n`;
md += `\n> Перевод (у.с.) считается под заказ: 1 у.с. = 1800 знаков с пробелами. Фиксированные услуги (заверение, апостиль, легализация, нострификация, копия, сканирование) бот берёт из этой таблицы.\n\n`;

for (const t of TYPES) {
  const items = all.filter(x => x.category === t).sort((a, b) => (b.freq || 0) - (a.freq || 0));
  md += `## ${TITLE[t]} (${items.length})\n\n`;
  for (const it of items) {
    const fr = it.freq > 1 ? ` \`×${it.freq}\`` : '';
    const pd = it.price_dependent ? ' 💰' : '';
    md += `**В:** ${it.question}${fr}${pd}\n**О:** ${it.answer}\n\n`;
  }
}

md += `## ⚠ Проверить у компании (конфликты/неясности)\n\n`;
md += `- **Часы работы офисов** расходятся в источниках: 9:00–19:00 vs 9:30–18:30 vs 10:00–19:00 — зависит от офиса, нужен точный график по каждому филиалу.\n`;
md += `- **Апостиль-маршрутизация** (Минюст / ЗАГС / Минобр) и сроки (до 14 vs до 30 раб. дней) — уточнить актуальные.\n`;
md += `- **Миграционные услуги** помечены как «сокращены» — подтвердить, что именно осталось.\n`;
md += `- Любые правила с 💰 — сверить ставки с актуальным прайсом перед заливкой.\n`;

writeFileSync('scratchpad/knowledge-base-final.md', md);
console.log(`Assembled ${all.length} canonical rules.`);
const byCat = {}; for (const x of all) byCat[x.category] = (byCat[x.category] || 0) + 1;
console.log('by category:', JSON.stringify(byCat));
console.log('-> scratchpad/knowledge-base-final.md (review) + .json (import)');
