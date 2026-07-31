/**
 * Сверка загруженной тарифной сетки с прайсом.
 *
 * Проверок четыре, и они разные по природе — одна другую не заменяет:
 *
 * 1. Контрольные точки. Семь цен, названных владельцем и разобранных глазами.
 *    Ловят разбор «вообще не тех» ячеек.
 * 2. Арифметика 1 категории: «вкл. НЗ» обязано равняться цене плюс 1100 ₽ по
 *    всем 52 языкам и всем пяти срокам. Ловит сдвиг колонок — ошибку, при
 *    которой все цены на месте, но приписаны соседнему сроку.
 * 3. Сверка с `certification-price.ts`. Та же таблица заверения уже разобрана
 *    в коде и отревьюена; расхождение означает, что одна из двух копий врёт.
 * 4. Пересчёт от документа. Прайс перечитывается из docx и сравнивается с базой
 *    построчно. Ловит расхождение базы и бумаги после ручной правки.
 *
 * Запуск: railway run npx tsx scripts/verify-tariffs.ts
 */
import { PrismaClient } from '@prisma/client';
import {
  CERTIFICATION_SERVICES,
  type PriceUnit,
} from '@/lib/knowledge/certification-price';
import {
  findTranslationTariff,
  formatTariffPrice,
  selectTariffs,
  toTariffRecord,
  type TariffRecord,
  type TariffTurnaroundKey,
  type TariffUnitKey,
} from '@/lib/knowledge/tariffs';
import { buildTariffs, TARIFF_EFFECTIVE_FROM } from './import-tariffs';

const prisma = new PrismaClient();

/**
 * Надбавка колонки «вкл. НЗ» в 1 категории — это цена заверения из той же
 * бумаги, и она зависит от срока.
 *
 * Проверено арифметикой по всем 52 языкам: на СТАНДАРТ, ЧЕРЕЗ 1 ДЕНЬ и НА СЛЕД.
 * ДЕНЬ разница ровно 1100 ₽ (440 → 1540), а на В ДЕНЬ ПРИЕМА и ДВА ЧАСА — ровно
 * 1250 ₽ (770 → 2020). 1250 ₽ — это строка «Срочное нотариальное заверение
 * перевода» из таблицы заверения того же прайса: на срочных сроках заверение
 * тоже срочное. Исключений нет ни одного, так что это правило прайса, а не
 * опечатка.
 *
 * Обе суммы берутся из самой сетки, а не вписаны числом: тогда проверка ловит и
 * сдвиг колонок в матрице, и расхождение матрицы с таблицей заверения.
 */
const NOTARY_SURCHARGE_SOURCE: Record<TariffTurnaroundKey, string> = {
  STANDARD: 'certification|notarial_translation',
  IN_1_DAY: 'certification|notarial_translation',
  NEXT_DAY: 'certification|notarial_translation',
  SAME_DAY: 'certification|notarial_urgent',
  TWO_HOURS: 'certification|notarial_urgent',
};

const UNIT_FROM_CERTIFICATION_PRICE: Record<PriceUnit, TariffUnitKey> = {
  doc: 'DOCUMENT',
  page: 'PAGE',
  mark: 'MARK',
  visa: 'VISA',
  standard_page: 'CONDITIONAL_PAGE',
};

let failures = 0;
let checks = 0;

function ok(label: string, detail = '') {
  checks++;
  console.log(`  OK    ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, detail: string) {
  checks++;
  failures++;
  console.log(`  ПРОВАЛ ${label} — ${detail}`);
}

function expectOne(label: string, matches: TariffRecord[], amount: number, unit: TariffUnitKey) {
  if (matches.length !== 1) {
    fail(label, `подошло строк: ${matches.length}, ожидалась ровно одна`);
    return;
  }
  const t = matches[0];
  if (t.amount !== amount || t.unit !== unit) {
    fail(label, `в базе ${formatTariffPrice(t)} (${t.amount} ${t.unit}), ожидалось ${amount} ${unit}`);
    return;
  }
  ok(label, formatTariffPrice(t));
}

async function main() {
  const rows = await prisma.tariff.findMany({ where: { isActive: true } });
  const all: TariffRecord[] = rows.map(toTariffRecord);
  const byKey = new Map(all.map((t) => [t.naturalKey, t]));

  console.log(`Активных строк в сетке: ${all.length}`);
  console.log('');

  // ---- 1. Контрольные точки ------------------------------------------------
  console.log('1. КОНТРОЛЬНЫЕ ТОЧКИ');

  const notarial = byKey.get('certification|notarial_translation');
  expectOne('нотариальное заверение перевода', notarial ? [notarial] : [], 1100, 'DOCUMENT');

  const copy = byKey.get('certification|notarial_copy');
  expectOne('нотариальное заверение копии', copy ? [copy] : [], 260, 'PAGE');

  expectOne(
    'апостиль МЮ СПб (стандартный срок)',
    selectTariffs(all, { section: 'APOSTILLE_SPB' }).filter(
      (t) => t.authority === 'МЮ СПб' && (t.termText ?? '').includes('1,5')
    ),
    5000,
    'DOCUMENT'
  );

  expectOne(
    'срочный апостиль ЗАГС СПб',
    selectTariffs(all, { section: 'APOSTILLE_SPB', serviceQuery: 'СРОЧНЫЙ АПОСТИЛЬ ЗАГС СПБ' }),
    27500,
    'DOCUMENT'
  );

  expectOne(
    'консульская легализация без подачи в Посольство',
    selectTariffs(all, { section: 'CONSULAR_LEGALIZATION', serviceQuery: 'без подачи в Посольство' }),
    9000,
    'DOCUMENT'
  );

  // Через модуль чтения и в родительном падеже — заодно проверяется сравнение
  // языков по основе слова.
  const en = findTranslationTariff(all, {
    language: 'английского',
    complexityCategory: 1,
    direction: 'FROM_FOREIGN',
    turnaround: 'STANDARD',
  });
  expectOne('перевод, 1 категория, английский, стандарт', en ? [en] : [], 440, 'CONDITIONAL_PAGE');

  const enNotary = findTranslationTariff(all, {
    language: 'английского',
    complexityCategory: 1,
    direction: 'FROM_FOREIGN',
    turnaround: 'STANDARD',
    includesNotary: true,
  });
  expectOne('то же, включая нотариальное заверение', enNotary ? [enNotary] : [], 1540, 'CONDITIONAL_PAGE');

  // ---- 2. Арифметика 1 категории ------------------------------------------
  console.log('');
  console.log('2. АРИФМЕТИКА 1 КАТЕГОРИИ: «вкл. НЗ» = цена + заверение');
  const cat1 = all.filter((t) => t.section === 'TRANSLATION' && t.complexityCategory === 1);
  const base = cat1.filter((t) => !t.includesNotary);
  const mismatches: string[] = [];
  const surchargeSeen = new Map<string, number>();
  let paired = 0;
  for (const b of base) {
    const withNotary = cat1.find(
      (t) => t.includesNotary && t.language === b.language && t.turnaround === b.turnaround && t.direction === b.direction
    );
    if (!withNotary) {
      mismatches.push(`${b.language} / ${b.termText}: нет парной строки «вкл. НЗ»`);
      continue;
    }
    paired++;
    if (b.amount === null || withNotary.amount === null || b.turnaround === null) {
      mismatches.push(`${b.language} / ${b.termText}: пустая цена или срок`);
      continue;
    }
    const expected = byKey.get(NOTARY_SURCHARGE_SOURCE[b.turnaround])?.amount ?? null;
    if (expected === null) {
      mismatches.push(`${b.language} / ${b.termText}: не найдена цена заверения для сверки`);
      continue;
    }
    const actual = withNotary.amount - b.amount;
    surchargeSeen.set(`${b.termText} → ${actual}`, (surchargeSeen.get(`${b.termText} → ${actual}`) ?? 0) + 1);
    if (actual !== expected) {
      mismatches.push(
        `${b.language} / ${b.termText}: ${b.amount} + ${expected} ≠ ${withNotary.amount} (разница ${actual})`
      );
    }
  }
  for (const [label, n] of [...surchargeSeen.entries()].sort()) console.log(`         надбавка ${label} ₽ — строк ${n}`);
  if (mismatches.length === 0) {
    ok(`пар проверено: ${paired}`, `${base.length} строк 1 категории, расхождений нет`);
  } else {
    fail(`пар проверено: ${paired}`, `расхождений ${mismatches.length}`);
    for (const m of mismatches.slice(0, 20)) console.log(`         ${m}`);
  }

  // ---- 3. Сверка с certification-price.ts ---------------------------------
  console.log('');
  console.log('3. СВЕРКА С certification-price.ts');
  const certRows = all.filter((t) => t.section === 'CERTIFICATION');
  if (certRows.length !== CERTIFICATION_SERVICES.length) {
    fail('число строк заверения', `в сетке ${certRows.length}, в коде ${CERTIFICATION_SERVICES.length}`);
  } else {
    ok('число строк заверения', String(certRows.length));
  }
  let certChecked = 0;
  for (const service of CERTIFICATION_SERVICES) {
    const t = byKey.get(`certification|${service.key}`);
    if (!t) {
      fail(service.key, 'нет строки в сетке');
      continue;
    }
    // price === null — процент, «от N» или составная цена: сверять нечего,
    // сравниваем только текст прайса.
    if (service.price === null) {
      if (!t.priceText) fail(service.key, 'нет текста цены');
      continue;
    }
    certChecked++;
    const expectedUnit = UNIT_FROM_CERTIFICATION_PRICE[service.price.unit];
    if (t.amount !== service.price.amount || t.unit !== expectedUnit) {
      fail(service.key, `сетка ${t.amount} ${t.unit}, код ${service.price.amount} ${expectedUnit}`);
    }
  }
  ok('строк сверено с кодом', `${certChecked} из ${CERTIFICATION_SERVICES.length} (остальные — процент, «от N» или составная цена)`);

  // ---- 4. Пересчёт от документа -------------------------------------------
  console.log('');
  console.log('4. ПЕРЕСЧЁТ ОТ ДОКУМЕНТА');
  const { rows: fromDoc, unparsed } = await buildTariffs(prisma);
  if (unparsed.length) {
    fail('разбор документа', `не разобрано строк: ${unparsed.length}`);
    for (const u of unparsed.slice(0, 10)) console.log(`         [${u.where}] "${u.text}" — ${u.reason}`);
  } else {
    ok('разбор документа', 'не разобранных строк нет');
  }

  const diffs: string[] = [];
  for (const r of fromDoc) {
    const t = byKey.get(r.naturalKey);
    if (!t) {
      diffs.push(`нет в базе: ${r.naturalKey}`);
      continue;
    }
    if (t.amount !== r.price.amount) diffs.push(`${r.naturalKey}: сумма база ${t.amount} / документ ${r.price.amount}`);
    if (t.unit !== r.price.unit) diffs.push(`${r.naturalKey}: единица база ${t.unit} / документ ${r.price.unit}`);
    if (t.amountKind !== r.price.amountKind) diffs.push(`${r.naturalKey}: вид цены база ${t.amountKind} / документ ${r.price.amountKind}`);
    if (t.percent !== r.price.percent) diffs.push(`${r.naturalKey}: процент база ${t.percent} / документ ${r.price.percent}`);
    if (t.baseFeeAmount !== r.price.baseFeeAmount) diffs.push(`${r.naturalKey}: тариф база ${t.baseFeeAmount} / документ ${r.price.baseFeeAmount}`);
    if (t.priceText !== r.priceText) diffs.push(`${r.naturalKey}: текст цены база "${t.priceText}" / документ "${r.priceText}"`);
    if (t.effectiveFrom.getTime() !== TARIFF_EFFECTIVE_FROM.getTime()) {
      diffs.push(`${r.naturalKey}: дата начала ${t.effectiveFrom.toISOString().slice(0, 10)}`);
    }
  }
  const docKeys = new Set(fromDoc.map((r) => r.naturalKey));
  for (const t of all) if (!docKeys.has(t.naturalKey)) diffs.push(`активна в базе, но нет в документе: ${t.naturalKey}`);

  if (diffs.length === 0) {
    ok('база сходится с документом', `${fromDoc.length} строк`);
  } else {
    fail('база сходится с документом', `расхождений ${diffs.length}`);
    for (const d of diffs.slice(0, 20)) console.log(`         ${d}`);
  }

  // ---- Покрытие ------------------------------------------------------------
  console.log('');
  console.log('ПОКРЫТИЕ ПО РАЗДЕЛАМ');
  const bySection = new Map<string, number>();
  for (const t of all) bySection.set(t.section, (bySection.get(t.section) ?? 0) + 1);
  for (const [s, n] of [...bySection.entries()].sort()) console.log(`  ${s.padEnd(28)}${String(n).padStart(6)}`);

  console.log('');
  console.log(`ИТОГ: проверок ${checks}, провалов ${failures}`);
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('FAILED', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
