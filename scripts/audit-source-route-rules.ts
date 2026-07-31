/**
 * Разведка перед правкой правил про исходник нотариального перевода.
 *
 * Что ищем: все ACTIVE-правила, которые говорят, к чему подшивается нотариальный
 * перевод. Плюс отдельно — сколько записей отвечает каждому ruleCode (в базе
 * 104 дублирующихся кода, править вслепую по коду нельзя).
 *
 * Запуск: railway run npx tsx scripts/audit-source-route-rules.ts
 */
import prisma from '../src/lib/db';

const TERMS = [
  'подшива',
  'подшить',
  'подшив',
  'сшива',
  'оригинал',
  'нотариальную копию',
  'нотариальной копии',
  'нотариальная копия',
  'ксерокопи',
  'скан',
];

const CODES = ['R-417', 'R-333'];

function flat(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

async function main() {
  console.log('=== 1. Сколько записей на каждый интересующий код (любой статус) ===');
  for (const code of CODES) {
    const rows = await prisma.rule.findMany({
      where: { ruleCode: code },
      select: {
        id: true,
        ruleCode: true,
        title: true,
        body: true,
        status: true,
        audience: true,
        documentId: true,
        scenarioKey: true,
        version: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    console.log(`\n--- ${code}: записей ${rows.length} ---`);
    for (const r of rows) {
      console.log(
        `  id=${r.id} status=${r.status} audience=${r.audience} scenario=${r.scenarioKey ?? '-'} doc=${r.documentId ?? '-'} v${r.version} upd=${r.updatedAt.toISOString()}`
      );
      console.log(`    title: ${flat(r.title)}`);
      console.log(`    body : ${flat(r.body)}`);
    }
  }

  console.log('\n\n=== 2. Все ACTIVE-правила про исходник нотариального перевода ===');
  const candidates = await prisma.rule.findMany({
    where: {
      status: 'ACTIVE',
      AND: [
        {
          OR: [
            { body: { contains: 'подшива', mode: 'insensitive' } },
            { body: { contains: 'подшив', mode: 'insensitive' } },
            { body: { contains: 'сшива', mode: 'insensitive' } },
            { body: { contains: 'ксерокопи', mode: 'insensitive' } },
            { body: { contains: 'нотариальную копию', mode: 'insensitive' } },
            { body: { contains: 'нотариальной копии', mode: 'insensitive' } },
            { body: { contains: 'нотариальная копия', mode: 'insensitive' } },
            { body: { contains: 'оригинал', mode: 'insensitive' } },
            { title: { contains: 'подшива', mode: 'insensitive' } },
            { title: { contains: 'ксерокопи', mode: 'insensitive' } },
          ],
        },
      ],
    },
    select: {
      id: true,
      ruleCode: true,
      title: true,
      body: true,
      audience: true,
      scenarioKey: true,
      documentId: true,
      document: { select: { title: true } },
    },
    orderBy: { ruleCode: 'asc' },
  });

  // Сузим до тех, что реально про нотариальный перевод / заверение
  const NOTARIAL = /нотариальн|нотариус|завер/iu;
  const SOURCE = /подшив|сшива|ксерокопи|оригинал|скан/iu;

  const relevant = candidates.filter(
    (r) => NOTARIAL.test(r.body + ' ' + r.title) && SOURCE.test(r.body + ' ' + r.title)
  );

  console.log(`кандидатов по словам: ${candidates.length}, из них про нотариальный исходник: ${relevant.length}\n`);
  for (const r of relevant) {
    console.log(`[${r.ruleCode}] id=${r.id} audience=${r.audience} scenario=${r.scenarioKey ?? '-'}`);
    console.log(`   doc: ${r.document?.title ?? '—'}`);
    console.log(`   title: ${flat(r.title)}`);
    console.log(`   body : ${flat(r.body)}`);
    console.log('');
  }

  console.log('\n=== 3. Есть ли ХОТЬ ОДНО правило про маршрут простой ксерокопии ===');
  const photocopy = relevant.filter((r) => /ксерокопи|простой копи|обычной копи/iu.test(r.body + r.title));
  console.log(`правил, где вообще упомянута ксерокопия: ${photocopy.length}`);
  for (const r of photocopy) {
    console.log(`  [${r.ruleCode}] ${flat(r.body).slice(0, 220)}`);
  }

  console.log('\n=== 4. QAPair про исходник (эталонные пары) ===');
  const qas = await prisma.qAPair.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { question: { contains: 'оригинал', mode: 'insensitive' } },
        { question: { contains: 'подшива', mode: 'insensitive' } },
        { question: { contains: 'ксерокопи', mode: 'insensitive' } },
        { answer: { contains: 'подшива', mode: 'insensitive' } },
      ],
    },
    select: { id: true, question: true, answer: true, audience: true, ruleId: true },
    take: 40,
  });
  console.log(`пар: ${qas.length}`);
  for (const q of qas) {
    console.log(`  [${q.audience}] id=${q.id}`);
    console.log(`    Q: ${flat(q.question).slice(0, 160)}`);
    console.log(`    A: ${flat(q.answer).slice(0, 260)}`);
  }

  console.log('\n=== 5. Дубликаты ruleCode — общая картина ===');
  const dupes = await prisma.$queryRaw<Array<{ ruleCode: string; n: bigint }>>`
    SELECT "ruleCode", COUNT(*) AS n
    FROM "Rule"
    GROUP BY "ruleCode"
    HAVING COUNT(*) > 1
    ORDER BY n DESC
    LIMIT 15
  `;
  console.log(`кодов с дубликатами (top-15 показано):`);
  for (const d of dupes) console.log(`  ${d.ruleCode}: ${Number(d.n)}`);

  const total = await prisma.rule.count();
  const active = await prisma.rule.count({ where: { status: 'ACTIVE' } });
  console.log(`\nвсего правил: ${total}, ACTIVE: ${active}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
