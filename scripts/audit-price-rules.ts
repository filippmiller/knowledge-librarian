/**
 * Во что превратились прайсы после извлечения правил.
 *
 * В исходном docx «Прайс на перевод» три тарифные таблицы по ~50 языков,
 * в каждой строке по 10 цен (5 сроков × 2 направления/варианта заверения).
 * То есть порядка 1500 ценовых значений. Скрипт печатает, сколько правил
 * реально извлечено и как они выглядят.
 */
import prisma from '../src/lib/db';

async function main() {
  const docs = await prisma.document.findMany({
    where: { title: { contains: 'Прайс', mode: 'insensitive' } },
    select: { id: true, title: true, audience: true, parseStatus: true, rawText: true },
  });

  console.log('=== Документы-прайсы в базе ===');
  for (const d of docs) {
    const rules = await prisma.rule.count({ where: { documentId: d.id, status: 'ACTIVE' } });
    const chunks = await prisma.docChunk.count({ where: { documentId: d.id } });
    console.log(`\n[${d.audience}] ${d.title}`);
    console.log(`   parseStatus=${d.parseStatus} правил=${rules} чанков=${chunks} rawText=${d.rawText?.length ?? 0} симв.`);
  }

  // Как выглядят правила из прайса на перевод — берём те, где есть язык и цифры.
  const translationPrice = docs.find((d) => /перевод и заверение/i.test(d.title) && !/Наливайко/i.test(d.title));
  if (translationPrice) {
    console.log(`\n\n=== Образцы правил из «${translationPrice.title}» ===`);
    const samples = await prisma.rule.findMany({
      where: { documentId: translationPrice.id, status: 'ACTIVE' },
      select: { ruleCode: true, body: true },
      take: 12,
    });
    for (const s of samples) {
      console.log(`\n[${s.ruleCode}] ${s.body.slice(0, 300).replace(/\s+/g, ' ')}`);
    }

    // Ключевая проверка: сохранилась ли привязка язык × срок × направление.
    console.log(`\n\n=== Проверка: есть ли правила про английский с ценами ===`);
    const eng = await prisma.rule.findMany({
      where: {
        documentId: translationPrice.id,
        status: 'ACTIVE',
        body: { contains: 'англ', mode: 'insensitive' },
      },
      select: { ruleCode: true, body: true },
    });
    console.log(`правил про английский: ${eng.length}`);
    for (const e of eng.slice(0, 8)) {
      console.log(`  [${e.ruleCode}] ${e.body.slice(0, 260).replace(/\s+/g, ' ')}`);
    }

    console.log(`\n=== Проверка: правила, где встречается «категория» ===`);
    const cat = await prisma.rule.count({
      where: { documentId: translationPrice.id, status: 'ACTIVE', body: { contains: 'категори', mode: 'insensitive' } },
    });
    console.log(`правил со словом «категория»: ${cat}`);

    console.log(`\n=== Проверка: правила, где встречается «у.с.» (тарифная ступень) ===`);
    const us = await prisma.rule.findMany({
      where: { documentId: translationPrice.id, status: 'ACTIVE', body: { contains: 'у.с.', mode: 'insensitive' } },
      select: { ruleCode: true, body: true },
      take: 5,
    });
    console.log(`правил с «у.с.»: ${us.length}`);
    for (const u of us) console.log(`  [${u.ruleCode}] ${u.body.slice(0, 240).replace(/\s+/g, ' ')}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
