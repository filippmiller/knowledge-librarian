/**
 * Что говорят СОБСТВЕННЫЕ документы «Авроры» про маршрут «подшивка к простой
 * ксерокопии». Юридическая часть вопроса решается законом, а вот предлагает ли
 * компания этот маршрут фактически — вопрос к её базе, не к владельцу.
 */
import prisma from '../src/lib/db';

const PROBES: Array<{ label: string; terms: string[] }> = [
  { label: 'простая/обычная ксерокопия как исходник', terms: ['обычная ксерокопия', 'обычной ксерокопии', 'простой копии', 'простая копия'] },
  { label: 'нотариальная копия', terms: ['нотариальную копию', 'нотариальной копии', 'нотариальная копия'] },
  { label: 'подшивка к оригиналу', terms: ['к оригиналу', 'оригинал документа'] },
  { label: 'удалённо по скану', terms: ['по скану', 'достаточно скана', 'удалённо'] },
  { label: 'апостиль требует нотариальной копии', terms: ['апостиль на нотариальную копию', 'нотариальную копию для апостил'] },
];

async function main() {
  for (const probe of PROBES) {
    const rules = await prisma.rule.findMany({
      where: {
        status: 'ACTIVE',
        OR: probe.terms.map((t) => ({ body: { contains: t, mode: 'insensitive' as const } })),
      },
      select: { ruleCode: true, body: true, audience: true },
      take: 6,
    });
    console.log(`\n=== ${probe.label} — правил: ${rules.length} ===`);
    for (const r of rules) {
      console.log(`  [${r.ruleCode} / ${r.audience}] ${r.body.slice(0, 190).replace(/\s+/g, ' ')}`);
    }
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
