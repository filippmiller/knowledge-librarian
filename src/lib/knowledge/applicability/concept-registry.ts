import { assertVocabularyConsistency, type ConceptVocabulary } from './concepts';
import type { FacetKey } from './facets';

/**
 * Конкретные словари (Задача 2.2). Каждый смотрит на РЕАЛЬНЫЙ источник, а не
 * на догадку — см. комментарий на месте.
 *
 * Что НЕ подтверждено реальными данными на момент написания (полный список
 * стран/городов доставки/партнёров), в словарь не попадает: пустой словарь,
 * ловящий любое значение как "unknown", честнее выдуманного списка, который
 * либо совпадёт случайно, либо придётся тихо чинить в проде. Расширяется
 * пилотом (Задача 2.3) по факту размеченных документов — тем же способом,
 * каким `SCENARIOS` растёт по факту загруженных прайсов, а не заранее.
 */

// ────────────────────────────────────────────────────────────────────────────
// SERVICE — из `TariffSection` (prisma/schema.prisma), уже единственного
// источника истины по тому, какие услуги эта организация продаёт. Не
// изобретается заново: то же самое перечисление, в slug-форме.
// ────────────────────────────────────────────────────────────────────────────
export const SERVICE_CONCEPTS: ConceptVocabulary = {
  translation: { id: 'translation', label: 'Перевод', aliases: ['перевод', 'translate'] },
  certification: { id: 'certification', label: 'Заверение', aliases: ['заверение'] },
  apostille_spb: { id: 'apostille_spb', label: 'Апостиль в СПб' },
  apostille_education: {
    id: 'apostille_education',
    label: 'Апостиль на документы об образовании',
  },
  apostille_moscow: { id: 'apostille_moscow', label: 'Апостиль в Москве' },
  consular_legalization: {
    id: 'consular_legalization',
    label: 'Консульская легализация',
    aliases: ['консульская легализация'],
  },
  chamber_of_commerce: {
    id: 'chamber_of_commerce',
    label: 'Торгово-промышленная палата',
    aliases: ['тпп'],
  },
  vital_records_spb: { id: 'vital_records_spb', label: 'Свидетельства ЗАГС (СПб)' },
  vital_records_urgent: { id: 'vital_records_urgent', label: 'Свидетельства ЗАГС (срочно)' },
  criminal_record: {
    id: 'criminal_record',
    label: 'Справка о несудимости',
    aliases: ['справка о несудимости'],
  },
  criminal_record_apostille: {
    id: 'criminal_record_apostille',
    label: 'Апостиль справки о несудимости',
  },
  nostrification: { id: 'nostrification', label: 'Нострификация', aliases: ['нострификация'] },
};

// ────────────────────────────────────────────────────────────────────────────
// DOCUMENT TYPE — из `DocType` (src/lib/knowledge/scenarios.ts), уже
// используемого в реальных узлах SCENARIOS. Не расширяется мимо того, что уже
// доказано кодом.
// ────────────────────────────────────────────────────────────────────────────
export const DOCUMENT_TYPE_CONCEPTS: ConceptVocabulary = {
  notary: { id: 'notary', label: 'Нотариальный документ', aliases: ['нотариальный'] },
  opeka: { id: 'opeka', label: 'Документ опеки', aliases: ['опека'] },
  zags: { id: 'zags', label: 'Свидетельство ЗАГС', aliases: ['загс'] },
  translation: { id: 'translation', label: 'Перевод как документ', aliases: ['перевод'] },
};

// ────────────────────────────────────────────────────────────────────────────
// COUNTRY — намеренно минимален. Единственное подтверждённое значение — `RU`
// (сама организация; уже используется тестом B1, `kinds.test.ts`). Полный
// список стран выдачи/назначения появляется пилотом, по факту размеченных
// документов, а не списком ISO-3166 целиком — целиком означало бы принимать
// как валидные страны, с которыми организация никогда не работала.
// ────────────────────────────────────────────────────────────────────────────
export const COUNTRY_CONCEPTS: ConceptVocabulary = {
  RU: { id: 'RU', label: 'Россия', aliases: ['россия', 'рф'] },
};

// ────────────────────────────────────────────────────────────────────────────
// LANGUAGE — 52 языка языковой матрицы перевода, снятые вживую с прод-эндпоинта
// `/api/tariffs/facets` (раздел TRANSLATION, 2026-08-07), плюс `ru` — сторона
// матрицы, которая в Tariff.language не хранится: `TranslationDirection`
// (FROM_FOREIGN/TO_FOREIGN) фиксирует русский как ВСЕГДА один из концов пары,
// поэтому `language`-столбец содержит только ИНОСТРАННУЮ сторону.
//
// Коды — ISO 639-1, кроме трёх языков без стабильного двухбуквенного кода:
// ДАРИ → `prs` (ISO 639-3, официального 639-1 не существует), МОЛДАВСКИЙ →
// `mo` (устаревший ISO 639-1, но прайс различает его от румынского как
// отдельную строку — сохранён отдельным кодом, а не слит с `ro`),
// ЧЕРНОГОРСКИЙ → `cnr` (не входит в ISO 639-1/639-2, общепринятое
// трёхбуквенное обозначение).
// ────────────────────────────────────────────────────────────────────────────
export const LANGUAGE_CONCEPTS: ConceptVocabulary = {
  ru: { id: 'ru', label: 'Русский', aliases: ['русский'] },
  ab: { id: 'ab', label: 'Абхазский', aliases: ['абхазский'] },
  az: { id: 'az', label: 'Азербайджанский', aliases: ['азербайджанский'] },
  en: { id: 'en', label: 'Английский', aliases: ['английский'] },
  ar: { id: 'ar', label: 'Арабский', aliases: ['арабский'] },
  hy: { id: 'hy', label: 'Армянский', aliases: ['армянский'] },
  be: { id: 'be', label: 'Белорусский', aliases: ['белорусский'] },
  bg: { id: 'bg', label: 'Болгарский', aliases: ['болгарский'] },
  hu: { id: 'hu', label: 'Венгерский', aliases: ['венгерский'] },
  vi: { id: 'vi', label: 'Вьетнамский', aliases: ['вьетнамский'] },
  el: { id: 'el', label: 'Греческий', aliases: ['греческий'] },
  ka: { id: 'ka', label: 'Грузинский', aliases: ['грузинский'] },
  prs: { id: 'prs', label: 'Дари', aliases: ['дари'] },
  da: { id: 'da', label: 'Датский', aliases: ['датский'] },
  he: { id: 'he', label: 'Иврит', aliases: ['иврит'] },
  id: { id: 'id', label: 'Индонезийский', aliases: ['индонезийский'] },
  es: { id: 'es', label: 'Испанский', aliases: ['испанский'] },
  it: { id: 'it', label: 'Итальянский', aliases: ['итальянский'] },
  kk: { id: 'kk', label: 'Казахский', aliases: ['казахский'] },
  ca: { id: 'ca', label: 'Каталонский', aliases: ['каталонский'] },
  ky: { id: 'ky', label: 'Киргизский', aliases: ['киргизский'] },
  zh: { id: 'zh', label: 'Китайский', aliases: ['китайский'] },
  ko: { id: 'ko', label: 'Корейский', aliases: ['корейский'] },
  lv: { id: 'lv', label: 'Латышский', aliases: ['латышский'] },
  lt: { id: 'lt', label: 'Литовский', aliases: ['литовский'] },
  ms: { id: 'ms', label: 'Малайский', aliases: ['малайский'] },
  mo: { id: 'mo', label: 'Молдавский', aliases: ['молдавский'] },
  mn: { id: 'mn', label: 'Монгольский', aliases: ['монгольский'] },
  de: { id: 'de', label: 'Немецкий', aliases: ['немецкий'] },
  nl: { id: 'nl', label: 'Нидерландский', aliases: ['нидерландский'] },
  no: { id: 'no', label: 'Норвежский', aliases: ['норвежский'] },
  pl: { id: 'pl', label: 'Польский', aliases: ['польский'] },
  pt: { id: 'pt', label: 'Португальский', aliases: ['португальский'] },
  ps: { id: 'ps', label: 'Пушту', aliases: ['пушту'] },
  ro: { id: 'ro', label: 'Румынский', aliases: ['румынский'] },
  sr: { id: 'sr', label: 'Сербский', aliases: ['сербский'] },
  sk: { id: 'sk', label: 'Словацкий', aliases: ['словацкий'] },
  sl: { id: 'sl', label: 'Словенский', aliases: ['словенский'] },
  tg: { id: 'tg', label: 'Таджикский', aliases: ['таджикский'] },
  th: { id: 'th', label: 'Тайский', aliases: ['тайский'] },
  tr: { id: 'tr', label: 'Турецкий', aliases: ['турецкий'] },
  tk: { id: 'tk', label: 'Туркменский', aliases: ['туркменский'] },
  uz: { id: 'uz', label: 'Узбекский', aliases: ['узбекский'] },
  uk: { id: 'uk', label: 'Украинский', aliases: ['украинский'] },
  fa: { id: 'fa', label: 'Фарси', aliases: ['фарси'] },
  fi: { id: 'fi', label: 'Финский', aliases: ['финский'] },
  fr: { id: 'fr', label: 'Французский', aliases: ['французский'] },
  hr: { id: 'hr', label: 'Хорватский', aliases: ['хорватский'] },
  cnr: { id: 'cnr', label: 'Черногорский', aliases: ['черногорский'] },
  cs: { id: 'cs', label: 'Чешский', aliases: ['чешский'] },
  sv: { id: 'sv', label: 'Шведский', aliases: ['шведский'] },
  et: { id: 'et', label: 'Эстонский', aliases: ['эстонский'] },
  ja: { id: 'ja', label: 'Японский', aliases: ['японский'] },
};

// ────────────────────────────────────────────────────────────────────────────
// CITY — только регионы, уже доказанные `SCENARIOS` (`apostille.zags.spb` /
// `apostille.zags.lo`). Не расширяется примером из комментария facets.ts
// («nizhny_novgorod») — это была иллюстрация формата, не подтверждённые
// данные.
// ────────────────────────────────────────────────────────────────────────────
export const CITY_CONCEPTS: ConceptVocabulary = {
  spb: { id: 'spb', label: 'Санкт-Петербург', aliases: ['спб', 'санкт-петербург', 'питер'] },
  lo: { id: 'lo', label: 'Ленинградская область', aliases: ['ло', 'ленинградская область'] },
};

// ────────────────────────────────────────────────────────────────────────────
// PARTNER — пуст: ни одного партнёра не подтверждено реальными данными на
// момент написания. `partnerIdSchema.refine` отвергнет ЛЮБОЕ значение, пока
// пилот не внесёт первое реальное — это правильное поведение, не недоделка.
// ────────────────────────────────────────────────────────────────────────────
export const PARTNER_CONCEPTS: ConceptVocabulary = {};

/**
 * Фасеты, чьи значения живут в `ConceptVocabulary` — резолвятся через
 * `resolveConceptAlias`, а не точным совпадением формы. `scenario` (дерево
 * `SCENARIOS`) и `documentForm` (закрытый enum без алиасов) сюда не входят —
 * у них нет словаря синонимов, обрабатываются отдельно на месте
 * использования. Единственное место этой карты — использовалась бы третий
 * раз (query-frame-builder.ts, теперь и retrieval-text.ts), значит место ей
 * здесь, рядом с самими словарями, а не копией в каждом потребителе.
 */
export const CONCEPT_VOCABULARY_BY_FACET: Partial<Record<FacetKey, ConceptVocabulary>> = {
  service: SERVICE_CONCEPTS,
  documentType: DOCUMENT_TYPE_CONCEPTS,
  issuingCountry: COUNTRY_CONCEPTS,
  destinationCountry: COUNTRY_CONCEPTS,
  languageFrom: LANGUAGE_CONCEPTS,
  languageTo: LANGUAGE_CONCEPTS,
  deliveryCity: CITY_CONCEPTS,
  partner: PARTNER_CONCEPTS,
};

// ────────────────────────────────────────────────────────────────────────────
// Проверка на ИМПОРТЕ модуля, а не только в тестах: битый словарь (дрейф
// ключа от id, алиас на двух концептах или на чужом id, пустая метка/алиас)
// обязан ронять приложение при загрузке, а не ждать, пока кто-то запустит
// именно этот тестовый файл. `scenarios.ts`, для сравнения, оставляет
// `assertTaxonomyConsistency()` вызываемой только вручную из скриптов —
// здесь это осознанно строже.
// ────────────────────────────────────────────────────────────────────────────
assertVocabularyConsistency(SERVICE_CONCEPTS, 'SERVICE_CONCEPTS');
assertVocabularyConsistency(DOCUMENT_TYPE_CONCEPTS, 'DOCUMENT_TYPE_CONCEPTS');
assertVocabularyConsistency(COUNTRY_CONCEPTS, 'COUNTRY_CONCEPTS');
assertVocabularyConsistency(LANGUAGE_CONCEPTS, 'LANGUAGE_CONCEPTS');
assertVocabularyConsistency(CITY_CONCEPTS, 'CITY_CONCEPTS');
assertVocabularyConsistency(PARTNER_CONCEPTS, 'PARTNER_CONCEPTS');
