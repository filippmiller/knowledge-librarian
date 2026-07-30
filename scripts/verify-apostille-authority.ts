/**
 * Таблица органов апостилирования: каждая клетка закрыта тестом.
 *
 * Источник истины — тетрадь стажёра, с. 10. Тесты написаны по ней, а не по
 * поведению кода: если поведение разойдётся с тетрадью, падать должен код.
 *
 * Запуск: npx tsx scripts/verify-apostille-authority.ts
 */
import {
  classifyApostilleDocument,
  detectIssuingRegion,
  resolveApostilleTerritoriality,
  APOSTILLE_AUTHORITIES,
  type ApostilleAuthorityKey,
  type IssuingRegion,
} from '../src/lib/knowledge/apostille-authority';

let failed = 0;
// Счётчик обязан считать сам, а не складываться из констант: прежняя версия
// печатала «32/32», хотя проверок было 30. Тест, который врёт о собственном
// объёме, скрывает ровно то, ради чего написан.
let total = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      ожидали ${JSON.stringify(expected)}, получили ${JSON.stringify(actual)}`);
}

console.log('=== Определение органа по типу документа ===');
const DOC_CASES: Array<[string, ApostilleAuthorityKey | null]> = [
  ['Нужен апостиль на справку о несудимости', 'mvd'],
  ['апостиль на СОН для Италии', 'mvd'],
  ['Апостиль на диплом с приложением', 'education'],
  ['апостиль на аттестат о среднем образовании', 'education'],
  ['апостиль на удостоверение о переквалификации', 'education'],
  ['Апостиль на свидетельство о рождении', 'zags'],
  ['апостиль на свидетельство о расторжении брака', 'zags'],
  ['апостиль на нотариальную доверенность', 'min_justice'],
  ['апостиль на справку из вуза', 'min_justice'],
  ['апостиль на судебный документ', 'min_justice'],
  ['Сколько стоит перевод паспорта', null],
];
for (const [q, expected] of DOC_CASES) {
  check(`«${q.slice(0, 52)}»`, classifyApostilleDocument(q), expected);
}

console.log('\n=== Определение региона выдачи ===');
const REGION_CASES: Array<[string, IssuingRegion]> = [
  ['справка выдана в Саратове', 'other'],
  ['документ из Москвы', 'other'],
  ['свидетельство выдано в другом регионе', 'other'],
  ['выдано в Санкт-Петербурге', 'local'],
  ['документ из Ленинградской области', 'local'],
  // Названы оба — по вопросу не понять, где выдан, а где подаётся.
  ['справка из Саратова, можно ли апостилировать в СПб', 'unknown'],
  ['нужен апостиль на диплом', 'unknown'],
];
for (const [q, expected] of REGION_CASES) {
  check(`«${q.slice(0, 52)}»`, detectIssuingRegion(q), expected);
}

console.log('\n=== Решение по территориальности ===');

// Ключевое исключение тетради: у образовательного комитета признака НЕТ.
const eduSaratov = resolveApostilleTerritoriality('Можно ли апостилировать диплом, выданный в Саратове, у вас в СПб?');
check('диплом из Саратова в СПб → БЕРЁМ (у комитета нет территориальности)', eduSaratov.kind, 'accept');
check('  орган определён как образовательный комитет', eduSaratov.kind === 'accept' ? eduSaratov.authority.key : null, 'education');

const sonSaratov = resolveApostilleTerritoriality('Справка о несудимости выдана в Саратовской области, нужен апостиль');
check('СОН из Саратова → оригинал здесь НЕЛЬЗЯ', sonSaratov.kind, 'reject_original');
check('  орган определён как МВД', sonSaratov.kind === 'reject_original' ? sonSaratov.authority.key : null, 'mvd');

const sonSpb = resolveApostilleTerritoriality('Справка о несудимости получена в Санкт-Петербурге, нужен апостиль');
check('СОН из СПб → БЕРЁМ', sonSpb.kind, 'accept');

const zagsMoscow = resolveApostilleTerritoriality('Апостиль на свидетельство о рождении, выдано в Москве');
check('свидетельство ЗАГС из Москвы → оригинал здесь НЕЛЬЗЯ', zagsMoscow.kind, 'reject_original');

const ambiguous = resolveApostilleTerritoriality('Справка о несудимости из Саратова, можно ли апостилировать в СПб?');
check('названы оба региона БЕЗ глагола выдачи → решения НЕТ', ambiguous.kind, 'unknown');

// Глагол выдачи снимает неоднозначность, даже когда назван второй город.
// Без этого разбора вопрос «диплом, выданный в Саратове, у вас в СПб» —
// дословная формулировка клиента — молчал, и заказ уходил в заглушку.
check(
  'место выдачи названо глаголом → регион определён, второй город не мешает',
  detectIssuingRegion('Можно ли апостилировать диплом, выданный в Саратове, у вас в СПб?'),
  'other'
);
check(
  'глагол выдачи указывает на СПб → регион местный',
  detectIssuingRegion('Диплом выдан в Санкт-Петербурге, а подавать будем в Москве'),
  'local'
);
check(
  'РЕГРЕССИЯ: «выданная Иванову» — не место выдачи',
  detectIssuingRegion('Справка о несудимости, выданная Иванову Ивану Ивановичу'),
  'unknown'
);

const noDoc = resolveApostilleTerritoriality('Сколько стоит апостиль?');
check('тип документа неизвестен → решения НЕТ', noDoc.kind, 'unknown');

console.log('\n=== Регрессии из ревью Kimi (все воспроизводились на живом коде) ===');

// Половина названий городов — ещё и русские фамилии и имена.
const surname = resolveApostilleTerritoriality('Справка о несудимости, выданная Иванову Ивану Ивановичу');
check('фамилия «Иванову» больше не читается как город Иваново', surname.kind, 'unknown');

const firstName = resolveApostilleTerritoriality('Апостиль на справку о несудимости для Владимира Петрова');
check('имя «Владимира» больше не читается как город Владимир', firstName.kind, 'unknown');

check('«в Иваново» — это всё-таки город', detectIssuingRegion('документ выдан в Иваново'), 'other');
check('«во Владимире» — это всё-таки город', detectIssuingRegion('свидетельство выдано во Владимире'), 'other');
check('«из Москвы» — предлог на месте', detectIssuingRegion('документ из Москвы'), 'other');

// Нотариальные копия и перевод апостилируются Минюстом, а не по документу,
// копией которого являются.
const notarialTranslation = resolveApostilleTerritoriality(
  'Апостиль на нотариальный перевод диплома, выданного в Саратове'
);
check('нотариальный перевод диплома → Минюст, а не образование',
  notarialTranslation.kind === 'reject_original' ? notarialTranslation.authority.key : notarialTranslation.kind,
  'min_justice');

const notarialCopy = resolveApostilleTerritoriality('Апостиль на нотариальную копию аттестата из Перми');
check('нотариальная копия аттестата → Минюст, а не образование',
  notarialCopy.kind === 'reject_original' ? notarialCopy.authority.key : notarialCopy.kind,
  'min_justice');

check('сам диплом по-прежнему идёт в образовательный комитет',
  classifyApostilleDocument('Апостиль на диплом, выданный в Саратове'), 'education');

console.log('\n=== Свойства органов по тетради ===');
check('у образовательного комитета территориальности НЕТ', APOSTILLE_AUTHORITIES.education.territorial, false);
check('у МВД территориальность ЕСТЬ', APOSTILLE_AUTHORITIES.mvd.territorial, true);
check('у Минюста территориальность ЕСТЬ', APOSTILLE_AUTHORITIES.min_justice.territorial, true);
check('у Архива ЗАГС территориальность ЕСТЬ', APOSTILLE_AUTHORITIES.zags.territorial, true);

console.log(`\n${total - failed}/${total} прошло`);
if (failed > 0) process.exit(1);
