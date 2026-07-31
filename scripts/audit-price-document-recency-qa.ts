/**
 * Дополнение к audit-price-document-recency.ts: что ещё висит на прошлогоднем
 * прайсе кроме правил и чанков. Только чтение.
 */
import prisma from '../src/lib/db';

const STALE_DOC = 'cmq264iih0002d7yzgh213ulf'; // Прайс внутренний апостиль ... 010125
const FRESH_DOC = 'cmq264t310004d7yz8hyfk337'; // Прайс клиентский апостиль ... 010126

async function main() {
  for (const [label, id] of [['010125 внутренний', STALE_DOC], ['010126 клиентский', FRESH_DOC]] as const) {
    const qa = await prisma.qAPair.findMany({
      where: { documentId: id },
      select: { id: true, question: true, answer: true, status: true, audience: true, metadata: true },
    });
    console.log(`\n=== ${label}: QAPair ${qa.length} ===`);
    for (const q of qa) {
      console.log(`  [${q.status}/${q.audience}] ${q.question.slice(0, 90)}`);
      console.log(`      → ${q.answer.replace(/\s+/g, ' ').slice(0, 140)}`);
    }
  }

  // Сколько правил прошлогоднего прайса вообще содержат клиентскую цену —
  // то есть могут быть названы клиенту как действующий тариф.
  const staleRules = await prisma.rule.findMany({
    where: { documentId: STALE_DOC, status: 'ACTIVE' },
    select: { ruleCode: true, body: true },
  });
  const withClientPrice = staleRules.filter((r) => /[Кк]лиентская цена/.test(r.body));
  console.log(`\n=== 010125: правил ACTIVE ${staleRules.length}, из них с «Клиентская цена» ${withClientPrice.length} ===`);

  // Правила прошлогоднего прайса, где цена исполнителя/себестоимость — это
  // знание, которого НЕТ в клиентском 010126. Оценка того, что теряется при архиве.
  const withCost = staleRules.filter((r) => /[Цц]ена исполнителя|себес|Исполнитель:/.test(r.body));
  console.log(`=== 010125: правил с внутренними данными (исполнитель/себестоимость) ${withCost.length} ===`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
