/**
 * Гасит правила, дублирующие ДРУГОЕ ПРАВИЛО того же документа — не внешний
 * источник (сетку, CERTIFICATION_SERVICES), а друг друга. Обнаружено при
 * разборе остатка после двух предыдущих проходов: «1 условная страница =
 * 1800 знаков» и «минимальный объём — 1 усл. страница» извлечены трижды
 * каждое — документ восстанавливает эти определения перед КАЖДОЙ из трёх
 * таблиц категорий (1/2/3), и извлечение честно создало по правилу на
 * каждое повторение. `locationHint` подтверждает разные места документа —
 * это не баг пайплайна и не повторный прогон, источник действительно
 * повторяется сам.
 *
 * СТАТУС — НЕ `SUPERSEDED`. Поле `supersedesRuleId` в схеме — String? на
 * ОДНОГО предшественника (см. `api/rules/[id]/route.ts`, ручное редактирование
 * создаёт новую версию взамен старой). Здесь связь N:1 (два дубля → один
 * выживший), FK для этого не годится — сила связи была бы обманчивой:
 * «R-1876 создан НАРОЧНО взамен R-1883» неверно, они извлечены НЕЗАВИСИМО и
 * СОВПАЛИ. Поэтому `DEPRECATED`, а выживший ruleCode — текстом в `reason`.
 *
 * КОГО ОСТАВЛЯТЬ: качество цитаты (`locateQuote`) одинаковое у всех копий
 * каждого кластера (дословное совпадение, coverage 1.0) — сигнала для выбора
 * это не даёт. Остаётся младший `ruleCode` — самое раннее место в документе.
 *
 * НЕ ТРОГАЕТ R-1878/R-1882 — общее предложение («расчёт начинается со 2
 * категории»), но у каждого есть и своё: R-1878 говорит про категорию 1,
 * R-1882 — про перевод С иностранного любой категории. Частичное пересечение
 * — решение о слиянии текста, не механическое гашение дубля.
 *
 * Запуск:
 *   railway run npx tsx scripts/retire-internal-duplicate-rules.ts            — сухой прогон
 *   railway run npx tsx scripts/retire-internal-duplicate-rules.ts --apply    — гасит подтверждённые
 */
import prisma from '../src/lib/db';

const APPLY = process.argv.includes('--apply');

/** Каждая группа — [выживший, ...гасимые]. Прочитано и сверено глазами. */
const CLUSTERS: [string, string[]][] = [
  ['R-1876', ['R-1883', 'R-1990']], // «1 условная страница = 1800 знаков»
  ['R-1877', ['R-1884', 'R-1991']], // «минимальный объём перевода = 1 усл. страница»
];

async function main() {
  const allCodes = CLUSTERS.flatMap(([survivor, dups]) => [survivor, ...dups]);
  const rules = await prisma.rule.findMany({
    where: { ruleCode: { in: allCodes } },
    select: { id: true, ruleCode: true, status: true, title: true, body: true },
  });
  const byCode = new Map(rules.map((r) => [r.ruleCode, r]));

  console.log('=== КЛАСТЕРЫ ВНУТРЕННИХ ДУБЛЕЙ ===\n');
  const toDeprecate: { ruleId: string; ruleCode: string; reason: string }[] = [];

  for (const [survivorCode, dupCodes] of CLUSTERS) {
    const survivor = byCode.get(survivorCode);
    if (!survivor) {
      console.log(`ПРОПУСК кластера: выживший ${survivorCode} не найден в базе`);
      continue;
    }
    console.log(`выживает ${survivor.ruleCode} [${survivor.status}] :: ${survivor.title}`);
    console.log(`  ${survivor.body}`);

    for (const dupCode of dupCodes) {
      const dup = byCode.get(dupCode);
      if (!dup) {
        console.log(`  ПРОПУСК: ${dupCode} не найден в базе`);
        continue;
      }
      if (dup.status !== 'ACTIVE') {
        console.log(`  ПРОПУСК: ${dupCode} уже не ACTIVE (${dup.status})`);
        continue;
      }
      console.log(`  гасится ${dup.ruleCode} :: ${dup.title}`);
      console.log(`    ${dup.body}`);
      toDeprecate.push({
        ruleId: dup.id,
        ruleCode: dup.ruleCode,
        reason:
          `Дублирует ${survivor.ruleCode} («${survivor.title}»), который остаётся активным. ` +
          `Документ повторяет это определение перед несколькими таблицами категорий сложности — ` +
          `извлечение корректно создало правило на каждое повторение, но для ответов достаточно одного. ` +
          `Качество цитаты (locateQuote) одинаковое у обеих копий, выбор — по более раннему ruleCode. ` +
          `Проверено скриптом scripts/retire-internal-duplicate-rules.ts, решение подтверждено владельцем устно в сессии 2026-08-01.`,
      });
    }
    console.log('');
  }

  console.log(`к гашению: ${toDeprecate.length} правил`);
  if (!APPLY) {
    console.log(`\nСУХОЙ ПРОГОН. Ничего не изменено. Запусти с --apply, чтобы применить.`);
    await prisma.$disconnect();
    return;
  }

  for (const d of toDeprecate) {
    await prisma.$transaction([
      prisma.rule.update({ where: { id: d.ruleId }, data: { status: 'DEPRECATED' } }),
      prisma.knowledgeChange.create({
        data: {
          targetType: 'RULE',
          targetId: d.ruleId,
          changeType: 'DEPRECATE',
          oldValue: { status: 'ACTIVE' },
          newValue: { status: 'DEPRECATED' },
          reason: d.reason,
          initiatedBy: 'AI',
          approvedBy: 'Filipp Miller (устно, в сессии 2026-08-01)',
          status: 'APPROVED',
          reviewedAt: new Date(),
        },
      }),
    ]);
  }
  console.log(`Готово: погашено ${toDeprecate.length} правил.`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
