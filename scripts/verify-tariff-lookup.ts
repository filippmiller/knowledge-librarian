/**
 * Как добавленный в сетку тариф связывается с ответом бота.
 * Запуск: npx tsx scripts/verify-tariff-lookup.ts
 *
 * Проверка на примере владельца: в сетку добавлена услуга «Торжественное
 * сжигание апостиля перед ЗАГС — 5000 ₽», клиент спрашивает «а можно сжечь
 * апостиль? сколько стоит». Показывает обе стороны связи: что работает сразу
 * после добавления строки и что требует синонимов.
 */
import {
  lookupTariffForQuestion,
  describeTariff,
} from '../src/lib/knowledge/tariff-lookup';
import type { TariffRecord } from '../src/lib/knowledge/tariffs';

function tariff(over: Partial<TariffRecord>): TariffRecord {
  return {
    naturalKey: 'test',
    section: 'APOSTILLE_SPB',
    sectionTitle: null,
    serviceName: 'Услуга',
    authority: null,
    termText: null,
    conditions: null,
    amount: 5000,
    amountKind: 'FIXED',
    percent: null,
    percentBase: null,
    baseFeeAmount: null,
    unit: 'DOCUMENT',
    currency: 'RUB',
    priceText: '5000 руб. / документ',
    effectiveFrom: new Date('2026-01-01'),
    effectiveTo: null,
    audience: 'CLIENT_SAFE',
    footnote: null,
    language: null,
    complexityCategory: null,
    direction: null,
    turnaround: null,
    includesNotary: false,
    isActive: true,
    synonyms: [],
    ...over,
  };
}

const BURNING_NO_SYN = tariff({
  serviceName: 'Торжественное сжигание апостиля перед ЗАГС',
  termText: '1 рабочий день',
  footnote: 'Пепел выдаётся в урне, урна оплачивается отдельно.',
});

const BURNING_WITH_SYN = tariff({
  ...BURNING_NO_SYN,
  synonyms: ['сжечь апостиль', 'сожжение апостиля', 'уничтожить апостиль'],
});

let failed = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'ok  ' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('══ СЦЕНАРИЙ ВЛАДЕЛЬЦА ══\n');

const asOfficialName = lookupTariffForQuestion(
  'Сколько стоит торжественное сжигание апостиля?',
  [BURNING_NO_SYN]
);
check(
  'словами прайса — находится сразу после добавления строки',
  asOfficialName.kind === 'single'
);
if (asOfficialName.kind === 'single') {
  console.log('\n       ОТВЕТ БОТА:\n       ' + describeTariff(asOfficialName.tariff).replace(/\n/g, '\n       ') + '\n');
}

const asClientSaysNoSyn = lookupTariffForQuestion(
  'А можно сжечь апостиль? Сколько стоит?',
  [BURNING_NO_SYN]
);
check(
  'словами клиента БЕЗ синонимов — НЕ находится (и это надо знать)',
  asClientSaysNoSyn.kind === 'unknown',
  `получено ${asClientSaysNoSyn.kind}`
);

const asClientSaysWithSyn = lookupTariffForQuestion(
  'А можно сжечь апостиль? Сколько стоит?',
  [BURNING_WITH_SYN]
);
check(
  'словами клиента С синонимами — находится',
  asClientSaysWithSyn.kind === 'single',
  `получено ${asClientSaysWithSyn.kind}`
);
if (asClientSaysWithSyn.kind === 'single') {
  console.log('\n       ОТВЕТ БОТА:\n       ' + describeTariff(asClientSaysWithSyn.tariff).replace(/\n/g, '\n       ') + '\n');
}

console.log('══ ГРАНИЦЫ ══\n');

check(
  'вопрос не про цену — сетку не спрашиваем',
  lookupTariffForQuestion('А вы вообще жжёте апостили?', [BURNING_WITH_SYN]).kind === 'unknown'
);

const twoServices = [
  BURNING_WITH_SYN,
  tariff({ serviceName: 'Апостиль МЮ СПб', amount: 5000, synonyms: [] }),
];
check(
  'две разные услуги в одном вопросе — молчим',
  lookupTariffForQuestion('Сколько стоит апостиль и сжечь апостиль?', twoServices).kind === 'unknown'
);

const variants = [
  tariff({ serviceName: 'СОН без апостиля', termText: '3 рабочих дня', amount: 22000, naturalKey: 'a' }),
  tariff({ serviceName: 'СОН без апостиля', termText: '5 рабочих дней', amount: 15500, naturalKey: 'b' }),
];
const v = lookupTariffForQuestion('Сколько стоит СОН без апостиля?', variants);
check('несколько сроков одной услуги — перечисляем варианты', v.kind === 'variants', `получено ${v.kind}`);

check(
  'матрица перевода детерминированно НЕ отвечается: цена зависит от языка и категории',
  lookupTariffForQuestion('Сколько стоит перевод с английского?', [
    tariff({ section: 'TRANSLATION', serviceName: 'Перевод с английского языка', language: 'английский' }),
  ]).kind === 'unknown'
);

console.log('\n══ ЧАСТНОЕ ПРОТИВ ОБЩЕГО (найдено аудитом Codex) ══\n');

// Общее название — подмножество частного: «нотариальное заверение перевода»
// целиком входит в «срочное нотариальное заверение перевода». Пока побеждало
// первое совпавшее, бот на вопрос про обычное заверение видел обе услуги,
// считал ответ неоднозначным и молчал; а на вопрос про копию отдавал цену
// общего заверения — 1100 ₽ вместо 260 ₽.
const CERT = [
  tariff({ serviceName: 'Нотариальное заверение перевода', amount: 1100, naturalKey: 'c1' }),
  tariff({ serviceName: 'Срочное нотариальное заверение перевода', amount: 1250, naturalKey: 'c2' }),
  tariff({ serviceName: 'Двуязычное нотариальное заверение перевода', amount: 1300, naturalKey: 'c3' }),
  tariff({ serviceName: 'Нотариальное заверение копии перевода/оригинала', amount: 260, unit: 'PAGE', naturalKey: 'c4' }),
  tariff({ serviceName: 'ТПП СПб', amount: 6000, section: 'CHAMBER_OF_COMMERCE', naturalKey: 'c5', synonyms: ['торгово-промышленная палата'] }),
];

const EXPECTED: Array<[string, number | null]> = [
  ['Сколько стоит нотариальное заверение перевода?', 1100],
  ['Сколько стоит срочное нотариальное заверение перевода?', 1250],
  ['Сколько стоит двуязычное нотариальное заверение перевода?', 1300],
  ['Сколько стоит нотариальное заверение копии перевода?', 260],
  // Косая черта в названии — перечисление: копия и перевода, и оригинала.
  ['Сколько стоит нотариальное заверение копии оригинала?', 260],
  // Сокращения короче пяти букв: раньше услуга не находилась ни по названию,
  // ни по синониму, потому что проверка синонимов до них не доходила.
  ['Сколько стоит ТПП?', 6000],
  ['Сколько стоит торговопромышленная палата?', 6000],
  // Одно общее слово услугой не является.
  ['Сколько стоит апостиль?', null],
];

for (const [question, want] of EXPECTED) {
  const v = lookupTariffForQuestion(question, CERT);
  const got = v.kind === 'single' ? v.tariff.amount : null;
  check(
    `${String(want ?? '—').padStart(5)} ₽ | ${question}`,
    got === want,
    got === want ? '' : `получено ${got ?? v.kind}`
  );
}

console.log(`\nпроверок: ${checks}, провалено: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
