/** Какие цены в базе реально привязаны к чешскому и шведскому. */
import prisma from '../src/lib/db';

async function main() {
  for (const lang of ['чешск', 'шведск', 'таджикск']) {
    const rules = await prisma.rule.findMany({
      where: {
        status: 'ACTIVE',
        OR: [
          { title: { contains: lang, mode: 'insensitive' } },
          { body: { contains: lang, mode: 'insensitive' } },
        ],
      },
      select: { ruleCode: true, title: true, body: true, audience: true },
      take: 5,
    });
    console.log(`\n=== ${lang} — правил: ${rules.length} ===`);
    for (const r of rules) {
      console.log(`[${r.ruleCode} / ${r.audience}] ${r.title}`);
      console.log(`   ${r.body.slice(0, 170).replace(/\s+/g, ' ')}`);
    }
  }

  // Где в базе вообще встречается «900 руб» и «1300 руб».
  for (const price of ['900 руб', '1300 руб']) {
    const n = await prisma.rule.findMany({
      where: { status: 'ACTIVE', body: { contains: price, mode: 'insensitive' } },
      select: { ruleCode: true, title: true },
      take: 4,
    });
    console.log(`\n=== «${price}» встречается в правилах: ${n.length} (первые) ===`);
    for (const r of n) console.log(`  [${r.ruleCode}] ${r.title}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(String(e).slice(0, 300));
  await prisma.$disconnect();
  process.exit(1);
});
