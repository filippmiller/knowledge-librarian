/**
 * Сверка утверждений хендоффа с продовой БД. Только чтение.
 * Каждая строка вывода — проверяемое число, а не пересказ документа.
 */
import prisma from '../src/lib/db';

async function main() {
  const [
    activeRules,
    clientSafeRules,
    docs,
    clientSafeDocs,
    qaActive,
    qaClientSafe,
    chunks,
    clientSafeChunks,
  ] = await Promise.all([
    prisma.rule.count({ where: { status: 'ACTIVE' } }),
    prisma.rule.count({ where: { status: 'ACTIVE', audience: 'CLIENT_SAFE' } }),
    prisma.document.count(),
    prisma.document.count({ where: { audience: 'CLIENT_SAFE' } }),
    prisma.qAPair.count({ where: { status: 'ACTIVE' } }),
    prisma.qAPair.count({ where: { status: 'ACTIVE', audience: 'CLIENT_SAFE' } }),
    prisma.docChunk.count(),
    prisma.docChunk.count({ where: { audience: 'CLIENT_SAFE' } }),
  ]);

  console.log('--- Разметка аудитории ---');
  console.log(`Rule   ACTIVE: ${activeRules}, из них CLIENT_SAFE: ${clientSafeRules}`);
  console.log(`Document total: ${docs}, из них CLIENT_SAFE: ${clientSafeDocs}`);
  console.log(`QAPair ACTIVE: ${qaActive}, из них CLIENT_SAFE: ${qaClientSafe}`);
  console.log(`DocChunk total: ${chunks}, из них CLIENT_SAFE: ${clientSafeChunks}`);

  // Пары с авторитетом — единственный вход в canonical override.
  const authority = await prisma.qAPair.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { metadata: { path: ['authorityTag'], equals: 'VOICE_ANSWER_AUTHORITY' } },
        { metadata: { path: ['authorityTag'], equals: 'HISTORICAL_ANSWER_AUTHORITY' } },
        { metadata: { path: ['origin'], equals: 'voice-operator' } },
        { metadata: { path: ['origin'], equals: 'historical-operator' } },
      ],
    },
    select: { id: true, audience: true },
  });
  const authClient = authority.filter((q) => q.audience === 'CLIENT_SAFE').length;
  console.log(`\n--- Canonical override ---`);
  console.log(`пар с авторитетом ACTIVE: ${authority.length}, из них CLIENT_SAFE: ${authClient}`);
  console.log(`  → клиентский контур видит ${authClient} эталонов, внутренний ${authority.length}`);

  // Дубли кодов правил.
  const codes = await prisma.rule.findMany({
    where: { status: 'ACTIVE' },
    select: { ruleCode: true },
  });
  const freq = new Map<string, number>();
  for (const r of codes) {
    if (!r.ruleCode) continue;
    freq.set(r.ruleCode, (freq.get(r.ruleCode) ?? 0) + 1);
  }
  const dupes = [...freq.entries()].filter(([, n]) => n > 1);
  const maxDup = dupes.reduce((m, [, n]) => Math.max(m, n), 0);
  console.log(`\n--- Коды правил ---`);
  console.log(`уникальных кодов: ${freq.size}, кодов с дублями: ${dupes.length}, максимум копий одного кода: ${maxDup}`);

  // Сценарное покрытие.
  const withScenario = await prisma.rule.count({ where: { status: 'ACTIVE', NOT: { scenarioKey: null } } });
  console.log(`\n--- Сценарный гейт ---`);
  console.log(`правил со scenarioKey: ${withScenario} из ${activeRules} (${Math.round((withScenario / activeRules) * 100)}%)`);
  const byKey = await prisma.rule.groupBy({
    by: ['scenarioKey'],
    where: { status: 'ACTIVE', NOT: { scenarioKey: null } },
    _count: true,
  });
  for (const k of byKey.sort((a, b) => b._count - a._count)) {
    console.log(`  ${k.scenarioKey}: ${k._count}`);
  }

  // Настройки автоответа.
  const settings = await prisma.aISettings.findMany({
    select: { id: true, autoAnswerEnabled: true, autoAnswerMinConfidence: true, isActive: true },
  });
  console.log(`\n--- AISettings ---`);
  console.log(JSON.stringify(settings, null, 2));

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
