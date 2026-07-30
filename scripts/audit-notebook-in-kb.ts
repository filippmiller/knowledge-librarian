/**
 * Есть ли тетрадь стажёра среди 44 документов базы и что из неё извлеклось.
 * Проверяем по характерным фактам, которых нет больше нигде.
 */
import prisma from '../src/lib/db';

const MARKERS: Array<{ label: string; term: string }> = [
  { label: 'справка о несудимости на СИНЕМ бланке', term: 'синем бланке' },
  { label: 'образовательный комитет без территориального признака', term: 'не имеет территориального' },
  { label: 'апостиль на оригинал лучше чем на копию', term: 'лучше чем на копию' },
  { label: 'апостиль удостоверяет подпись последнего чиновника', term: 'последнего подписавшего' },
  { label: 'нотариальную копию только в стране выдачи', term: 'той страны, где документ выдан' },
  { label: 'заявка на госуслугах — не принимаем', term: 'госуслугах' },
  { label: 'обязательные вопросы при оформлении', term: 'как и где будете использовать' },
  { label: 'НЗКП — нотариально заверенная копия перевода', term: 'НЗКП' },
];

async function main() {
  const docs = await prisma.document.findMany({
    where: { OR: [{ title: { contains: 'тетрад', mode: 'insensitive' } }, { title: { contains: 'стажер', mode: 'insensitive' } }, { title: { contains: 'стажёр', mode: 'insensitive' } }] },
    select: { id: true, title: true, audience: true, parseStatus: true, rawText: true },
  });
  console.log(`=== Документ «тетрадь стажёра» в базе: ${docs.length} ===`);
  for (const d of docs) {
    const rules = await prisma.rule.count({ where: { documentId: d.id, status: 'ACTIVE' } });
    console.log(`  [${d.audience}] ${d.title} — parseStatus=${d.parseStatus}, правил=${rules}, rawText=${d.rawText?.length ?? 0} симв.`);
  }

  console.log(`\n=== Есть ли ключевые факты тетради где-либо в правилах ===`);
  for (const m of MARKERS) {
    const n = await prisma.rule.count({
      where: { status: 'ACTIVE', body: { contains: m.term, mode: 'insensitive' } },
    });
    console.log(`  [${n > 0 ? 'ЕСТЬ' : 'НЕТ '}] ${m.label} — правил: ${n}`);
  }

  console.log(`\n=== Все 44 документа ===`);
  const all = await prisma.document.findMany({ select: { title: true, audience: true }, orderBy: { title: 'asc' } });
  for (const d of all) console.log(`  [${d.audience === 'CLIENT_SAFE' ? 'КЛИЕНТ' : 'внутр.'}] ${d.title}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
