/**
 * Ворота перед записью синонимов в сетку.
 * Запуск:  npx tsx scripts/verify-tariff-synonyms.ts
 * Со сверкой с продовой базой:  railway run npx tsx scripts/verify-tariff-synonyms.ts --online
 *
 * ЗАЧЕМ ПРОВЕРКА ДО ЗАПИСИ, А НЕ ПОСЛЕ. Синоним — это данные, которые меняют
 * маршрутизацию ответа. Ошибка в них не падает и не логируется: бот просто
 * начинает называть цену чужой услуги, и узнать об этом можно только от
 * клиента. Прошлый замер потерял на такой ошибке всё — «Перевод виз» с ценой
 * 100 ₽ отвечала на шесть разных вопросов про перевод
 * (docs/bot-audit/15-tariff-shadow-run.md §4.1). Поэтому предложенный набор
 * прогоняется по полной сетке ДО того, как попадёт в базу.
 *
 * ПОЧЕМУ СЕТКА ВШИТА В ФАЙЛ. Проверка обязана работать без доступа к базе:
 * сессия Railway истекает, а ворота должны стоять всегда. Снимок 62 плоских
 * услуг снят с продовой базы 2026-07-31; флаг `--online` сверяет снимок с
 * базой и ругается на расхождение — так снимок не сможет устареть молча.
 * Матрица перевода в снимок не входит намеренно: детерминированно она не
 * отвечается вовсе (`tariff-lookup.ts` отбрасывает секцию TRANSLATION), и её
 * 1560 строк в проверке специфичности ничего не решают.
 */
import { readFileSync } from 'node:fs';
import {
  lookupTariffForQuestion,
  questionAsksPrice,
  type TariffLookupVerdict,
} from '../src/lib/knowledge/tariff-lookup';
import type { TariffRecord } from '../src/lib/knowledge/tariffs';
import { TARIFF_SYNONYMS, allProposedSynonyms } from './seed-tariff-synonyms';

const ONLINE = process.argv.includes('--online');
const CORPUS = 'docs/email-bot/may2026-knowledge-base-final.json';

interface Snapshot {
  section: string;
  serviceName: string;
  priceText: string;
  amount: number | null;
  unit: string;
  amountKind: string;
}

/** Снимок плоских услуг (section !== 'TRANSLATION') с продовой базы 2026-07-31. */
const FLAT_SERVICES: Snapshot[] = [
  { section: "APOSTILLE_MOSCOW", serviceName: "Апостиль ЗАГС МСК (10 р.д.)", priceText: "7 000 руб./док", amount: 7000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CONSULAR_LEGALIZATION", serviceName: "МЮ + МИД + Посольство (от 1,5 мес. + сроки Посольства)", priceText: "7500 руб./док", amount: 7500, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CONSULAR_LEGALIZATION", serviceName: "Услуга подачи в Посольство (сроки по запросу)", priceText: "6000 руб./док", amount: 6000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CHAMBER_OF_COMMERCE", serviceName: "ТПП МСК (от 2-х дней)", priceText: "8000 руб./док", amount: 8000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "VITAL_RECORDS_URGENT", serviceName: "Истребование ЗАГС Великий Новгород + апостиль (3 – 5 рабочих дней) Свидетельства, Справки По скану доверенности РФ", priceText: "16 000 руб./док", amount: 16000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "VITAL_RECORDS_URGENT", serviceName: "Истребование ЗАГС Великий Новгород + апостиль (3 – 5 рабочих дней) Свидетельства, Справки По скану доверенности, составленной в другой стране Перевод доверенности не входит в стоимость", priceText: "19 000 руб./док", amount: 19000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "VITAL_RECORDS_URGENT", serviceName: "Истребование ЗАГС МСК + апостиль (до 6 рабочих дней) Без доверенности Свидетельства, Справки", priceText: "50 000 руб./док", amount: 50000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CRIMINAL_RECORD", serviceName: "СОН без апостиля — 10 рабочих дней", priceText: "9000 руб./док", amount: 9000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "APOSTILLE_SPB", serviceName: "МЮ СПб (1 – 1,5 недели)", priceText: "5000 руб./док", amount: 5000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CHAMBER_OF_COMMERCE", serviceName: "ТПП СПб (от 2-х дней)", priceText: "6000 руб./док", amount: 6000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CERTIFICATION", serviceName: "Нотариальное заверение копии перевода/оригинала", priceText: "260 руб. / стр.", amount: 260, unit: "PAGE", amountKind: "FIXED" },
  { section: "CERTIFICATION", serviceName: "Срочное нотариальное заверение копии перевода/оригинала", priceText: "300 руб. / стр.", amount: 300, unit: "PAGE", amountKind: "FIXED" },
  { section: "CERTIFICATION", serviceName: "Нотариальное заверение копии оригиналов УСТАВА и ИЗМЕНЕНИЯ К УСТАВУ", priceText: "1000 руб. тариф + 260 руб. / стр.", amount: 260, unit: "PAGE", amountKind: "FIXED" },
  { section: "CERTIFICATION", serviceName: "Нотариальное заверение тождественности", priceText: "300 руб. / стр.", amount: 300, unit: "PAGE", amountKind: "FIXED" },
  { section: "CERTIFICATION", serviceName: "Перевод печатей и штампов, редакция перевода", priceText: "70% от стоимости 1 у.с.", amount: null, unit: "PERCENT", amountKind: "PERCENT_OF_BASE" },
  { section: "CERTIFICATION", serviceName: "Оформление повторного экземпляра перевода", priceText: "150 руб. / док. + НЗ", amount: 150, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CERTIFICATION", serviceName: "Перевод отметок", priceText: "20 руб. / отметка", amount: 20, unit: "MARK", amountKind: "FIXED" },
  { section: "CERTIFICATION", serviceName: "Перевод виз", priceText: "100 руб. / виза", amount: 100, unit: "VISA", amountKind: "FIXED" },
  { section: "CERTIFICATION", serviceName: "Редакция перевода", priceText: "70% от стоимости 1 у.с.", amount: null, unit: "PERCENT", amountKind: "PERCENT_OF_BASE" },
  { section: "CERTIFICATION", serviceName: "Вычитка чужого перевода", priceText: "70% от стоимости 1 у.с.", amount: null, unit: "PERCENT", amountKind: "PERCENT_OF_BASE" },
  { section: "CERTIFICATION", serviceName: "Набор текста на русском языке", priceText: "180 руб. / 1 у.с.", amount: 180, unit: "CONDITIONAL_PAGE", amountKind: "FIXED" },
  { section: "CERTIFICATION", serviceName: "Набор текстов на английском, французском, немецком, испанском, итальянском языках", priceText: "220 руб. / 1 у.с.", amount: 220, unit: "CONDITIONAL_PAGE", amountKind: "FIXED" },
  { section: "CERTIFICATION", serviceName: "Набор текстов на арабском, турецком, армянском, грузинском, греческом языках", priceText: "300 руб. / 1 у.с.", amount: 300, unit: "CONDITIONAL_PAGE", amountKind: "FIXED" },
  { section: "CERTIFICATION", serviceName: "Оформление таблицы (2-я и 3-я категории)", priceText: "+10% от стоимости", amount: null, unit: "PERCENT", amountKind: "PERCENT_SURCHARGE" },
  { section: "CERTIFICATION", serviceName: "Нечеткий текст (факсы, нечеткие ксерокопии, рукописный текст)", priceText: "+20% от стоимости", amount: null, unit: "PERCENT", amountKind: "PERCENT_SURCHARGE" },
  { section: "CERTIFICATION", serviceName: "Верстка документа", priceText: "от 60 руб. за страницу А4", amount: 60, unit: "PAGE", amountKind: "FROM" },
  { section: "CERTIFICATION", serviceName: "Сканирование", priceText: "40 руб. / стр.", amount: 40, unit: "PAGE", amountKind: "FIXED" },
  { section: "CERTIFICATION", serviceName: "Ксерокопия", priceText: "30 руб. / стр.", amount: 30, unit: "PAGE", amountKind: "FIXED" },
  { section: "CERTIFICATION", serviceName: "Заверение перевода подписью переводчика и штампом БП", priceText: "250 руб. / док.", amount: 250, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CERTIFICATION", serviceName: "Нотариальное заверение перевода (включая тех. работы)", priceText: "1100 руб. / док.", amount: 1100, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CERTIFICATION", serviceName: "Срочное нотариальное заверение перевода (включая тех. работы)", priceText: "1250 руб. / док.", amount: 1250, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CERTIFICATION", serviceName: "Двуязычное нотариальное заверение перевода (включая тех. работы)", priceText: "1300 руб. / док.", amount: 1300, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CERTIFICATION", serviceName: "Срочное двуязычное нотариальное заверение перевода (включая тех. работы)", priceText: "1450 руб. / док.", amount: 1450, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "APOSTILLE_SPB", serviceName: "СРОЧНЫЙ АПОСТИЛЬ ЗАГС СПБ (2-3 рабочих дня)", priceText: "27 500 руб./док", amount: 27500, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "APOSTILLE_SPB", serviceName: "ЗАГС СПб (2 недели)", priceText: "5000 руб./док", amount: 5000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "APOSTILLE_SPB", serviceName: "ЗАГС ЛО (1 – 1,5 недели)", priceText: "5000 руб./док", amount: 5000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "APOSTILLE_SPB", serviceName: "МВД СПб (5 рабочих дней)", priceText: "5000 руб./док", amount: 5000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "APOSTILLE_EDUCATION", serviceName: "Стандартный срок (45 рабочих дней) (Доверенность + скан паспорта владельца + скан документов на смену фамилии (при наличии))", priceText: "12 000 руб./док", amount: 12000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "APOSTILLE_EDUCATION", serviceName: "Стандартный срок (45 рабочих дней) БЕЗ ДОВЕРЕННОСТИ", priceText: "18 000 руб./док.", amount: 18000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "APOSTILLE_MOSCOW", serviceName: "Апостиль ЗАГС МО (8-9 р.д.)", priceText: "7 000 руб./док", amount: 7000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "APOSTILLE_MOSCOW", serviceName: "Апостиль ЗАГС МО (1-2 р.д.)", priceText: "20 500 руб./док", amount: 20500, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "APOSTILLE_MOSCOW", serviceName: "Апостиль ЗАГС МСК (1-2 р.д.)", priceText: "25 000 руб./док", amount: 25000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "APOSTILLE_MOSCOW", serviceName: "Апостиль МЮ МСК (6-8 р.д.)", priceText: "7 000 руб./док", amount: 7000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "APOSTILLE_MOSCOW", serviceName: "Апостиль МЮ МО (1 р.д.)", priceText: "17 000 руб./док", amount: 17000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CONSULAR_LEGALIZATION", serviceName: "МЮ + МИД + Посольство (10 – 12 рабочих дней + сроки Посольства)", priceText: "15 300 руб./док", amount: 15300, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CONSULAR_LEGALIZATION", serviceName: "МЮ + МИД без подачи в Посольство (10 – 12 рабочих дней)", priceText: "9000 руб./док", amount: 9000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "VITAL_RECORDS_SPB", serviceName: "ЗАГС СПб (до 5 рабочих дней при наличии доверенности) Свидетельства, справки", priceText: "3000 руб./док", amount: 3000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "VITAL_RECORDS_URGENT", serviceName: "Истребование ЗАГС Великий Новгород (2 – 3 рабочих дня) Свидетельства, Справки По скану доверенности РФ", priceText: "9 000 руб./док.", amount: 9000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "VITAL_RECORDS_URGENT", serviceName: "Истребование ЗАГС МСК + апостиль (до 12 рабочих дней) Без доверенности Свидетельства, Справки", priceText: "38 500 руб./док", amount: 38500, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "VITAL_RECORDS_URGENT", serviceName: "Истребование ЗАГС МСК без апостиля (2 – 5 рабочих дней) Без доверенности Свидетельства, Справки", priceText: "32 000 руб./док", amount: 32000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CRIMINAL_RECORD", serviceName: "СОН без апостиля — 1 рабочий день", priceText: "27 900 руб./док", amount: 27900, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CRIMINAL_RECORD", serviceName: "СОН без апостиля — 2 рабочих дня", priceText: "24 900 руб./док", amount: 24900, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CRIMINAL_RECORD", serviceName: "СОН без апостиля — 3 рабочих дня", priceText: "22 000 руб./док", amount: 22000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CRIMINAL_RECORD", serviceName: "СОН без апостиля — 5 рабочих дней", priceText: "15 500 руб./док", amount: 15500, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CRIMINAL_RECORD", serviceName: "СОН без апостиля — 7 рабочих дней", priceText: "11 000 руб./док", amount: 11000, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CRIMINAL_RECORD_APOSTILLE", serviceName: "СОН с апостилем — 3 рабочих дня", priceText: "35 400 руб./док", amount: 35400, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CRIMINAL_RECORD_APOSTILLE", serviceName: "СОН с апостилем — 4 рабочих дня", priceText: "30 400 руб./док", amount: 30400, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CRIMINAL_RECORD_APOSTILLE", serviceName: "СОН с апостилем — 6 рабочих дней", priceText: "23 750 руб./док", amount: 23750, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CRIMINAL_RECORD_APOSTILLE", serviceName: "СОН с апостилем — 8 рабочих дней", priceText: "20 750 руб./док", amount: 20750, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "CRIMINAL_RECORD_APOSTILLE", serviceName: "СОН с апостилем — 10 рабочих дней", priceText: "17 750 руб./док", amount: 17750, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "NOSTRIFICATION", serviceName: "Нострификация (пошлина включена в стоимость)", priceText: "18 500 руб./док.", amount: 18500, unit: "DOCUMENT", amountKind: "FIXED" },
  { section: "APOSTILLE_SPB", serviceName: "МЮ СПб (3 – 4 рабочих дня)", priceText: "10 000 руб./док", amount: 10000, unit: "DOCUMENT", amountKind: "FIXED" },
];

function toRecord(s: Snapshot, i: number, synonyms: string[]): TariffRecord {
  return {
    naturalKey: `snapshot-${i}`,
    section: s.section as TariffRecord['section'],
    sectionTitle: null,
    serviceName: s.serviceName,
    authority: null,
    termText: null,
    conditions: null,
    amount: s.amount,
    amountKind: s.amountKind as TariffRecord['amountKind'],
    percent: null,
    percentBase: null,
    baseFeeAmount: null,
    unit: s.unit as TariffRecord['unit'],
    currency: 'RUB',
    priceText: s.priceText,
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
    synonyms,
  };
}

const proposedBy = new Map(TARIFF_SYNONYMS.map((p) => [p.serviceName, p.synonyms]));

/** Сетка как она есть сейчас: синонимов нет ни у одной из 62 плоских услуг. */
const BEFORE = FLAT_SERVICES.map((s, i) => toRecord(s, i, []));
/** Сетка с предложенным набором. */
const AFTER = FLAT_SERVICES.map((s, i) => toRecord(s, i, proposedBy.get(s.serviceName) ?? []));

let checks = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'ok  ' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function verdictService(v: TariffLookupVerdict): string | null {
  if (v.kind === 'single') return v.tariff.serviceName;
  if (v.kind === 'variants') return v.service;
  return null;
}

console.log('\n══ ВОРОТА 1: КАЖДЫЙ СИНОНИМ ПОДХОДИТ РОВНО ОДНОЙ УСЛУГЕ ══\n');

// Синоним, который на своём же вопросе даёт неоднозначность, негоден: он не
// добавляет покрытия, зато расширяет поверхность будущих промахов. Проверяется
// на ПОЛНОЙ сетке из 62 услуг — на выборке специфичность недоказуема.
const bad: string[] = [];
for (const { serviceName, synonym } of allProposedSynonyms()) {
  const v = lookupTariffForQuestion(`сколько стоит ${synonym}`, AFTER);
  const got = verdictService(v);
  const ok = v.kind === 'single' && got === serviceName;
  if (!ok) bad.push(`${synonym} → ${got ?? v.kind}`);
  check(`«${synonym}»`, ok, ok ? '' : `получено ${got ?? v.kind}, ожидалось «${serviceName}»`);
}

console.log('\n══ ВОРОТА 2: НИ ОДНА УСЛУГА НЕ ПОТЕРЯЛА НАХОДИМОСТЬ ══\n');

// Синоним частной услуги способен перебить общую и отобрать у неё вопрос.
// Поэтому сравнивается поведение ВСЕХ 62 услуг на вопрос их собственным
// названием — до набора и после. Потерь быть не должно ни одной.
let lost = 0;
let gained = 0;
let moved = 0;
for (const s of FLAT_SERVICES) {
  const q = `Сколько стоит ${s.serviceName}?`;
  const before = verdictService(lookupTariffForQuestion(q, BEFORE));
  const after = verdictService(lookupTariffForQuestion(q, AFTER));
  if (before && !after) {
    lost += 1;
    console.log(`[FAIL] ПОТЕРЯНО: «${s.serviceName}» находилась, перестала`);
  } else if (!before && after) {
    gained += 1;
  } else if (before && after && before !== after) {
    moved += 1;
    console.log(`[FAIL] ПЕРЕЕХАЛО: «${s.serviceName}» → теперь «${after}»`);
  }
}
const foundBefore = FLAT_SERVICES.filter(
  (s) => verdictService(lookupTariffForQuestion(`Сколько стоит ${s.serviceName}?`, BEFORE)) !== null
).length;
const foundAfter = FLAT_SERVICES.filter(
  (s) => verdictService(lookupTariffForQuestion(`Сколько стоит ${s.serviceName}?`, AFTER)) !== null
).length;
check('ни одна услуга не потеряла находимость по своему названию', lost === 0, `потеряно ${lost}`);
check('ни одна услуга не переехала в чужую строку', moved === 0, `переехало ${moved}`);
console.log(
  `       находимых по собственному названию: было ${foundBefore}, стало ${foundAfter} (прибавка ${gained})`
);

console.log('\n══ ВОРОТА 3: СЕМЬИ УСЛУГ — ЦЕНА ИМЕННО ТОЙ СТРОКИ ══\n');

// Самый дорогой класс ошибок здесь — не молчание, а подмена внутри семьи:
// «срочное» и «двуязычное» заверение отличаются от базового только одним
// словом, а ценой — на 15–35%. Каждый признак проверяется отдельно, и рядом
// стоят случаи, где правильный ответ — молчание.
const FAMILY: Array<[string, number | null]> = [
  ['Сколько стоит нотариальное заверение перевода?', 1100],
  ['Сколько стоит срочное нотариальное заверение перевода?', 1250],
  ['Сколько стоит двуязычное нотариальное заверение перевода?', 1300],
  ['Сколько стоит срочное двуязычное нотариальное заверение перевода?', 1450],
  ['Сколько стоит заверить перевод у нотариуса?', 1100],
  ['Сколько стоит срочно заверить перевод у нотариуса?', 1250],
  ['Сколько стоит двуязычное заверение?', 1300],
  ['Сколько стоит срочное двуязычное заверение?', 1450],
  ['Сколько стоит заверение штампами бюро переводов?', 250],
  ['Сколько стоит заверение перевода штампами компании?', 250],
  ['Сколько стоит нотариальная копия?', 260],
  ['Сколько стоит нотариальное заверение копии?', 260],
  ['Сколько стоит срочная нотариальная копия?', 300],
  ['Сколько стоит электронная тождественность?', 300],
  ['Сколько стоит нострификация?', 18500],
  ['Сколько стоит вёрстка?', 60],
  ['Сколько стоит форматирование документа?', 60],
  ['Сколько стоит дубликат перевода?', 150],
  ['Сколько стоит набор текста на турецком?', 300],
  ['Сколько стоит набор текста на немецком?', 220],
  ['Сколько стоит набор текста на русском?', 180],
  ['Сколько стоит торгово-промышленная палата спб?', 6000],
  ['Сколько стоит торгово-промышленная палата в москве?', 8000],
  // Молчание здесь — верное поведение, а не недоработка.
  ['Сколько стоит апостиль?', null],
  ['Сколько стоит справка о несудимости?', null],
  ['Сколько стоит консульская легализация?', null],
  ['Сколько стоит торгово-промышленная палата?', null],
  ['Сколько стоит перевод?', null],
  ['Сколько стоит заверение?', null],
  // Вопрос про две услуги сразу: выбрать одну нельзя.
  ['Сколько стоит нотариальная копия и тождественность?', null],
];
for (const [question, want] of FAMILY) {
  const v = lookupTariffForQuestion(question, AFTER);
  const got = v.kind === 'single' ? v.tariff.amount : null;
  const name = verdictService(v);
  check(
    `${String(want ?? 'молчим').padStart(7)} | ${question}`,
    got === want,
    got === want ? '' : `получено ${got ?? v.kind}${name ? ` («${name}»)` : ''}`
  );
}

console.log('\n══ ВОРОТА 4: КОРПУС 180 ВОПРОСОВ — ЧТО ИЗМЕНИЛОСЬ ══\n');

// Замер того же вида, что и теневой прогон, но в памяти и без судьи: он
// отвечает на единственный вопрос, ради которого делается набор, — сколько
// вопросов корпуса сетка закрывает и не появилось ли срабатываний невпопад.
// Каждое НОВОЕ срабатывание печатается целиком: его обязан прочитать человек.
interface CorpusCase {
  question: string;
  answer: string;
  freq: number;
  price_dependent: boolean;
}
let corpus: CorpusCase[] = [];
try {
  corpus = JSON.parse(readFileSync(CORPUS, 'utf8')) as CorpusCase[];
} catch {
  console.log('Корпус не найден — раздел пропущен.');
}

if (corpus.length > 0) {
  const firedBefore = new Map<string, string>();
  const firedAfter = new Map<string, string>();
  let priceQuestions = 0;
  for (const c of corpus) {
    if (questionAsksPrice(c.question) || c.price_dependent) priceQuestions += 1;
    const b = verdictService(lookupTariffForQuestion(c.question, BEFORE));
    const a = verdictService(lookupTariffForQuestion(c.question, AFTER));
    if (b) firedBefore.set(c.question, b);
    if (a) firedAfter.set(c.question, a);
  }
  console.log(`корпус: ${corpus.length} вопросов, из них ценовых ${priceQuestions}`);
  console.log(`срабатываний ДО:    ${firedBefore.size}`);
  console.log(`срабатываний ПОСЛЕ: ${firedAfter.size}`);

  const isNew = [...firedAfter].filter(([q]) => !firedBefore.has(q));
  const isGone = [...firedBefore].filter(([q]) => !firedAfter.has(q));
  const isChanged = [...firedAfter].filter(
    ([q, s]) => firedBefore.has(q) && firedBefore.get(q) !== s
  );

  if (isNew.length > 0) {
    console.log('\n--- НОВЫЕ СРАБАТЫВАНИЯ (проверить глазами каждое) ---');
    for (const [q, s] of isNew) {
      const freq = corpus.find((c) => c.question === q)?.freq ?? 0;
      console.log(`  freq=${freq} «${q}»\n     → ${s}`);
    }
  }
  for (const [q, s] of isGone) console.log(`  ПРОПАЛО: «${q}» (было ${s})`);
  for (const [q, s] of isChanged) console.log(`  СМЕНИЛОСЬ: «${q}» → ${s}`);

  check('ни одно прежнее срабатывание не пропало', isGone.length === 0);
  check('ни одно прежнее срабатывание не сменило услугу', isChanged.length === 0);
}

console.log('\n══ ВОРОТА 5: СНИМОК СЕТКИ НЕ УСТАРЕЛ ══\n');

async function verifyAgainstDatabase(): Promise<void> {
  const { default: prisma } = await import('../src/lib/db');
  const rows = await prisma.tariff.findMany({
    where: { isActive: true, NOT: { section: 'TRANSLATION' } },
    select: { serviceName: true, section: true },
  });
  const inDb = new Set(rows.map((r) => `${r.section}|${r.serviceName}`));
  const inSnapshot = new Set(FLAT_SERVICES.map((s) => `${s.section}|${s.serviceName}`));
  const onlyDb = [...inDb].filter((k) => !inSnapshot.has(k));
  const onlySnapshot = [...inSnapshot].filter((k) => !inDb.has(k));
  for (const k of onlyDb) console.log(`  только в базе:   ${k}`);
  for (const k of onlySnapshot) console.log(`  только в файле:  ${k}`);
  check('снимок совпадает с базой', onlyDb.length === 0 && onlySnapshot.length === 0);
  check(
    'каждое предложение привязано к существующей строке',
    TARIFF_SYNONYMS.every((p) => inDb.has([...inDb].find((k) => k.endsWith(`|${p.serviceName}`)) ?? '')),
    TARIFF_SYNONYMS.filter((p) => ![...inDb].some((k) => k.endsWith(`|${p.serviceName}`)))
      .map((p) => p.serviceName)
      .join('; ')
  );
  await prisma.$disconnect();
}

async function main(): Promise<void> {
  if (ONLINE) {
    await verifyAgainstDatabase();
  } else {
    // Без базы сверить снимок не с чем — и это надо сказать вслух, а не
    // промолчать: молчаливо устаревший снимок доказывал бы специфичность на
    // прайсе, которого больше нет.
    console.log('пропущено: нужен доступ к базе (--online). Снимок снят 2026-07-31.');
    const missing = TARIFF_SYNONYMS.filter(
      (p) => !FLAT_SERVICES.some((s) => s.serviceName === p.serviceName)
    );
    check(
      'каждое предложение привязано к строке снимка',
      missing.length === 0,
      missing.map((p) => p.serviceName).join('; ')
    );
  }

  console.log(`\nпроверок: ${checks}, провалено: ${failed}`);
  if (bad.length > 0) {
    console.log('\nНЕГОДНЫЕ СИНОНИМЫ — выбросить из scripts/seed-tariff-synonyms.ts:');
    for (const b of bad) console.log(`  · ${b}`);
  }
  process.exit(failed > 0 ? 1 : 0);
}

void main();
