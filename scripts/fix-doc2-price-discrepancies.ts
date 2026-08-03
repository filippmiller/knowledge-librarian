/**
 * Гасит 5 правил «внутреннего» прайса апостиль/истребование (010125.docx,
 * прошлогодний), чья КЛИЕНТСКАЯ цена противоречит текущей тарифной сетке —
 * не дубликат, а устаревшая цифра. Найдено при разборе документа:
 * `probe-doc2-vs-grid.ts` (сравнение всех 50 ценовых правил документа с
 * сеткой), проверено вручную по полному тексту каждого правила и перепроверено
 * против сеток `APOSTILLE_MOSCOW`/`CONSULAR_LEGALIZATION`/`CRIMINAL_RECORD`.
 *
 * Подтверждено ТРЕМЯ источниками разом:
 *   1. Tariff-сетка (`/admin/tariffs`) — действующая, сверена с бумагой;
 *   2. более новый документ «Прайс клиентский... 010126» — те же услуги,
 *      те же сроки, числа совпадают с сеткой день в день (спот-проверка
 *      R-1409/R-1410 против R-1466/R-1467);
 *   3. живой прогон бота: вопрос про «СОН без апостиля, 3 дня» отвечен верно
 *      (22 000 ₽), хотя устаревшее R-1468 (7-дневный тир, для сверки не
 *      входил в эту пятёрку) всё ещё попадало в контекст синтеза рядом с
 *      верным источником — при уверенности 58% это не гарантия на будущее.
 *
 * НЕ ПЕРЕПИСЫВАЕТ текст правила на верное число: документ 010125 ДЕЙСТВИТЕЛЬНО
 * говорит 20 000 — переписать значило бы соврать про источник, ровно то, что
 * чинилось в PR #44 сегодня утром (только в другую сторону). Гасит правило
 * целиком: факт остаётся доступен из сетки и из более нового документа.
 *
 * НЕ ТРОГАЕТ R-1482 (15 000, «при стандартном сроке», без второго числа —
 * непонятно, к чему относится) и R-1483 (12 500, «при оптовом заказе» — это
 * другое измерение цены, опт, а не срок, сеткой не покрыто вовсе). Оба
 * подозрительны, но не ПОДТВЕРЖДЕНЫ как ошибка — не гашу без проверки.
 *
 * Запуск:
 *   railway run npx tsx scripts/fix-doc2-price-discrepancies.ts            — сухой прогон
 *   railway run npx tsx scripts/fix-doc2-price-discrepancies.ts --apply    — гасит подтверждённые
 */
import prisma from '../src/lib/db';

const APPLY = process.argv.includes('--apply');
const DOC_FILENAME_CONTAINS = 'Прайс_внутренний_апостиль';

interface Discrepancy {
  ruleCode: string;
  wrongAmount: number;
  correctAmount: number;
  gridRow: string;
  note: string;
}

const DISCREPANCIES: Discrepancy[] = [
  {
    ruleCode: 'R-1444',
    wrongAmount: 17500,
    correctAmount: 25000,
    gridRow: 'APOSTILLE_MOSCOW · Апостиль ЗАГС МСК (1-2 р.д.)',
    note: 'Апостиль ЗАГС МСК срочный 1-2 рабочих дня',
  },
  {
    ruleCode: 'R-1449',
    wrongAmount: 12500,
    correctAmount: 9000,
    gridRow: 'CONSULAR_LEGALIZATION · МЮ + МИД без подачи в Посольство (10–12 рабочих дней)',
    note: 'Консульская легализация без подачи в Посольство 10-12 рабочих дней',
  },
  {
    ruleCode: 'R-1466',
    wrongAmount: 20000,
    correctAmount: 22000,
    gridRow: 'CRIMINAL_RECORD · СОН без апостиля — 3 рабочих дня',
    note: 'СОН справка без апостиля 3 рабочих дня — тот самый инцидент из докстринга stale-price-check.ts',
  },
  {
    ruleCode: 'R-1467',
    wrongAmount: 13500,
    correctAmount: 15500,
    gridRow: 'CRIMINAL_RECORD · СОН без апостиля — 5 рабочих дней',
    note: 'СОН справка без апостиля 5 рабочих дней',
  },
  {
    ruleCode: 'R-1489',
    wrongAmount: 13500,
    correctAmount: 15500,
    gridRow: 'CRIMINAL_RECORD · СОН без апостиля — 5 рабочих дней',
    note: 'Та же ошибка, вторая параллельная серия правил документа (Цена справки СОН без апостиля за 5 рабочих дней)',
  },
];

async function main() {
  const doc = await prisma.document.findFirst({
    where: { filename: { contains: DOC_FILENAME_CONTAINS } },
    select: { id: true, filename: true },
  });
  if (!doc) {
    console.error('документ не найден');
    process.exit(1);
  }
  console.log(`документ: ${doc.filename}\n`);

  // ruleCode не уникален глобально (найдено сегодня: 104 коллизии среди
  // активных правил) — каждый запрос обязан быть в рамках ЭТОГО documentId,
  // иначе легко погасить чужое правило из другого документа с тем же кодом.
  const codes = DISCREPANCIES.map((d) => d.ruleCode);
  const rules = await prisma.rule.findMany({
    where: { ruleCode: { in: codes }, documentId: doc.id, status: 'ACTIVE' },
    select: { id: true, ruleCode: true, title: true, body: true },
  });
  const byCode = new Map(rules.map((r) => [r.ruleCode, r]));

  const toDeprecate: { ruleId: string; ruleCode: string; reason: string }[] = [];

  for (const d of DISCREPANCIES) {
    const rule = byCode.get(d.ruleCode);
    if (!rule) {
      console.log(`ПРОПУСК ${d.ruleCode}: не найдено ACTIVE в этом документе (уже погашено или переименовано?)`);
      continue;
    }
    // Числа в тексте разделены пробелом-тысячником — не всегда ASCII-пробелом
    // (может быть U+00A0/U+202F из DOCX). Собираем группы цифр, схлопывая
    // внутренние пробелы, и сверяем как единое число.
    const numbers = [...rule.body.matchAll(/\d[\d\s  ]*\d|\d/g)].map((m) =>
      Number(m[0].replace(/[\s  ]/g, ''))
    );
    const hasWrongAmount = numbers.includes(d.wrongAmount);
    console.log(`${rule.ruleCode} :: ${rule.title}`);
    console.log(`  ${rule.body}`);
    console.log(`  ожидаемая неверная сумма ${d.wrongAmount} в тексте: ${hasWrongAmount ? 'да' : 'НЕ НАЙДЕНА — проверь вручную!'}`);
    console.log('');

    toDeprecate.push({
      ruleId: rule.id,
      ruleCode: rule.ruleCode,
      reason:
        `Клиентская цена в правиле (${d.wrongAmount} ₽) противоречит текущей тарифной сетке ` +
        `(${d.gridRow} = ${d.correctAmount} ₽). ${d.note}. Документ «${doc.filename}» — прошлогодний ` +
        `внутренний прайс; актуальный источник — сетка /admin/tariffs и документ «Прайс клиентский ` +
        `апостиль, истребование и КЛ СПб и МСК 010126». Текст правила не переписан на верное число: ` +
        `документ 010125 действительно называет ${d.wrongAmount} ₽, переписывать значило бы исказить ` +
        `источник. Проверено скриптом scripts/fix-doc2-price-discrepancies.ts, решение подтверждено ` +
        `владельцем устно в сессии 2026-08-02.`,
    });
  }

  console.log(`к гашению: ${toDeprecate.length} из ${DISCREPANCIES.length}`);
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
          approvedBy: 'Filipp Miller (устно, в сессии 2026-08-02)',
          status: 'APPROVED',
          reviewedAt: new Date(),
        },
      }),
    ]);
    console.log(`  погашено: ${d.ruleCode}`);
  }
  console.log(`\nГотово: погашено ${toDeprecate.length} правил.`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
