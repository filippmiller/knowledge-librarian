/**
 * Чтение тарифной сетки: типы и чистые функции выборки.
 *
 * Сетка (модель `Tariff`, prisma/schema.prisma) — единственный источник правды
 * по ценам. До неё цены жили текстом в 400+ правилах базы знаний, и бот дважды
 * назвал клиенту цену чужой услуги: «нотариальное заверение перевода — 260 ₽ за
 * страницу», тогда как 260 ₽/стр — заверение КОПИИ, а перевода — 1100 ₽ за
 * документ (docs/bot-audit/06-price-table-and-source-routes.md).
 *
 * Модуль намеренно не ходит в базу и не знает про движок ответов: он описывает
 * словарь признаков, отбирает строки и печатает цену так, чтобы единица и
 * оговорка не потерялись по дороге. Подключение к движку — отдельная работа.
 */
import type { Prisma } from '@prisma/client';

export type TariffSectionKey =
  | 'TRANSLATION'
  | 'CERTIFICATION'
  | 'APOSTILLE_SPB'
  | 'APOSTILLE_EDUCATION'
  | 'APOSTILLE_MOSCOW'
  | 'CONSULAR_LEGALIZATION'
  | 'CHAMBER_OF_COMMERCE'
  | 'VITAL_RECORDS_SPB'
  | 'VITAL_RECORDS_URGENT'
  | 'CRIMINAL_RECORD'
  | 'CRIMINAL_RECORD_APOSTILLE'
  | 'NOSTRIFICATION';

export type TariffUnitKey = 'DOCUMENT' | 'PAGE' | 'CONDITIONAL_PAGE' | 'MARK' | 'VISA' | 'PERCENT';

export type TariffAmountKindKey = 'FIXED' | 'FROM' | 'PERCENT_OF_BASE' | 'PERCENT_SURCHARGE';

export type TranslationDirectionKey = 'FROM_FOREIGN' | 'TO_FOREIGN';

export type TariffTurnaroundKey = 'STANDARD' | 'IN_1_DAY' | 'NEXT_DAY' | 'SAME_DAY' | 'TWO_HOURS';

export type TariffAudienceKey = 'INTERNAL_ONLY' | 'CLIENT_SAFE';

/**
 * Строка прайса, приведённая к числам.
 *
 * `amount` — number, а не Prisma.Decimal: модуль читают и тесты, и будущий
 * движок, и Decimal здесь только мешал бы. Преобразование делает вызывающий,
 * см. `toTariffRecord`.
 */
export interface TariffRecord {
  naturalKey: string;
  section: TariffSectionKey;
  sectionTitle: string | null;
  serviceName: string;
  authority: string | null;
  termText: string | null;
  conditions: string | null;
  amount: number | null;
  amountKind: TariffAmountKindKey;
  percent: number | null;
  percentBase: string | null;
  baseFeeAmount: number | null;
  unit: TariffUnitKey;
  currency: string;
  priceText: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  audience: TariffAudienceKey;
  footnote: string | null;
  language: string | null;
  complexityCategory: number | null;
  direction: TranslationDirectionKey | null;
  turnaround: TariffTurnaroundKey | null;
  includesNotary: boolean;
  isActive: boolean;
  /**
   * Слова, которыми услугу называет клиент, а прайс — нет.
   *
   * Без них строка сетки находится только по словам официального названия:
   * «торжественное сжигание апостиля» не найдётся по вопросу «можно сжечь
   * апостиль», потому что у существительного и глагола разные корни и никакая
   * нормализация их не сведёт. Синонимы заполняет человек при добавлении
   * тарифа — это часть работы, а не необязательное поле.
   */
  synonyms: string[];
}

export interface TariffQuery {
  section?: TariffSectionKey | TariffSectionKey[];
  language?: string;
  complexityCategory?: number;
  direction?: TranslationDirectionKey;
  turnaround?: TariffTurnaroundKey;
  includesNotary?: boolean;
  /** Контур. Не задан — не фильтруем; для клиентского ответа задавать обязательно. */
  audience?: TariffAudienceKey;
  /** Дата, на которую нужен тариф. По умолчанию — сегодня. */
  effectiveOn?: Date;
  /** Подстрока в названии услуги или органе. Регистр и «ё» не важны. */
  serviceQuery?: string;
  includeInactive?: boolean;
}

/** Приводит строку к сравнимому виду: регистр и «ё» в живых запросах не значат ничего. */
export function normalizeText(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

/**
 * Сравнение названий языков.
 *
 * В прайсе язык напечатан именительным падежом («АНГЛИЙСКИЙ»), а спрашивают
 * родительным («с английского»). Сравниваются основы: у прилагательного
 * отсекается окончание. Основы всех 52 языков прайса различаются, так что
 * отсечение не может склеить два разных языка; у несклоняемых названий
 * («ДАРИ», «ФАРСИ», «ИВРИТ», «ПУШТУ») отсекать нечего.
 */
export function languageStem(value: string): string {
  return normalizeText(value).replace(/(ого|ому|ыми|ий|ый|ая|ую|ом|им|ых|ие|ым)$/u, '');
}

export function matchesLanguage(tariffLanguage: string | null, query: string): boolean {
  if (!tariffLanguage) return false;
  return languageStem(tariffLanguage) === languageStem(query);
}

/** Тариф действует на дату: начало наступило, конец не наступил. */
export function isEffectiveOn(tariff: TariffRecord, date: Date): boolean {
  if (tariff.effectiveFrom.getTime() > date.getTime()) return false;
  if (tariff.effectiveTo && tariff.effectiveTo.getTime() < date.getTime()) return false;
  return true;
}

export function selectTariffs(all: TariffRecord[], query: TariffQuery = {}): TariffRecord[] {
  const on = query.effectiveOn ?? new Date();
  const sections = query.section === undefined ? null : Array.isArray(query.section) ? query.section : [query.section];
  const needle = query.serviceQuery ? normalizeText(query.serviceQuery) : null;

  return all.filter((t) => {
    if (!query.includeInactive && !t.isActive) return false;
    if (!isEffectiveOn(t, on)) return false;
    if (sections && !sections.includes(t.section)) return false;
    if (query.audience && t.audience !== query.audience) return false;
    if (query.language !== undefined && !matchesLanguage(t.language, query.language)) return false;
    if (query.complexityCategory !== undefined && t.complexityCategory !== query.complexityCategory) return false;
    if (query.direction !== undefined && t.direction !== query.direction) return false;
    if (query.turnaround !== undefined && t.turnaround !== query.turnaround) return false;
    if (query.includesNotary !== undefined && t.includesNotary !== query.includesNotary) return false;
    if (needle) {
      const haystack = normalizeText([t.serviceName, t.authority, t.sectionTitle].filter(Boolean).join(' '));
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

/**
 * Из нескольких подошедших строк — самая свежая по дате начала действия.
 *
 * Приоритета по дате в системе не было вовсе, и сотруднику называли
 * прошлогодний тариф из прайса 010125 (docs/bot-audit/09-price-document-priority.md).
 * Здесь он есть: побеждает та редакция, которая уже вступила в силу и вступила
 * позже остальных.
 */
export function pickCurrent(tariffs: TariffRecord[]): TariffRecord | null {
  if (tariffs.length === 0) return null;
  return [...tariffs].sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];
}

export interface TranslationTariffSpec {
  language: string;
  complexityCategory: number;
  direction: TranslationDirectionKey;
  turnaround: TariffTurnaroundKey;
  includesNotary?: boolean;
  audience?: TariffAudienceKey;
  effectiveOn?: Date;
}

/**
 * Точный лукап клетки языковой матрицы.
 *
 * Возвращает null, а не «примерно подходящую» строку: цена перевода на язык в
 * 1 категории не существует (перевод НА язык считается со 2 категории), и
 * подстановка соседней клетки здесь означала бы названную клиенту чужую цену.
 */
export function findTranslationTariff(all: TariffRecord[], spec: TranslationTariffSpec): TariffRecord | null {
  return pickCurrent(
    selectTariffs(all, {
      section: 'TRANSLATION',
      language: spec.language,
      complexityCategory: spec.complexityCategory,
      direction: spec.direction,
      turnaround: spec.turnaround,
      includesNotary: spec.includesNotary ?? false,
      audience: spec.audience,
      effectiveOn: spec.effectiveOn,
    })
  );
}

const UNIT_LABEL: Record<TariffUnitKey, string> = {
  DOCUMENT: 'за документ',
  PAGE: 'за страницу',
  CONDITIONAL_PAGE: 'за 1 условную страницу (1800 знаков с пробелами)',
  MARK: 'за отметку',
  VISA: 'за визу',
  PERCENT: '',
};

/**
 * Цена с единицей — одной строкой.
 *
 * Единица не необязательное украшение: «260» без «за страницу» уже уходило
 * клиенту как цена за документ. Поэтому число без единицы отсюда не выходит,
 * а для процентов и «от N руб.» отдаётся формулировка прайса дословно.
 */
export function formatTariffPrice(tariff: TariffRecord): string {
  if (tariff.amountKind === 'PERCENT_OF_BASE' || tariff.amountKind === 'PERCENT_SURCHARGE') {
    return tariff.priceText;
  }
  if (tariff.amount === null) return tariff.priceText;
  const money = `${tariff.amount.toLocaleString('ru-RU')} ₽`;
  const unit = UNIT_LABEL[tariff.unit];
  const base = tariff.amountKind === 'FROM' ? `от ${money}` : money;
  const withUnit = unit ? `${base} ${unit}` : base;
  return tariff.baseFeeAmount === null
    ? withUnit
    : `${tariff.baseFeeAmount.toLocaleString('ru-RU')} ₽ тариф + ${withUnit}`;
}

/** Тариф целиком: услуга, цена, срок и оговорка. Оговорка обязательна — без неё
 *  названная цена обещает клиенту больше, чем в неё входит. */
export function formatTariff(tariff: TariffRecord): string {
  const parts = [`${tariff.serviceName} — ${formatTariffPrice(tariff)}`];
  if (tariff.termText && tariff.termText !== tariff.serviceName) parts.push(`Срок: ${tariff.termText}.`);
  if (tariff.conditions) parts.push(`Условия: ${tariff.conditions}.`);
  if (tariff.footnote) parts.push(tariff.footnote);
  return parts.join(' ');
}

/** Фильтр для запроса в базу — тот же отбор, что и `selectTariffs`, но на стороне
 *  Postgres. Признаки языковой матрицы сюда не входят: сравнение языков идёт по
 *  основе слова и в SQL не выражается — отбирать язык нужно в памяти. */
export function tariffWhere(query: TariffQuery = {}): Prisma.TariffWhereInput {
  const on = query.effectiveOn ?? new Date();
  const where: Prisma.TariffWhereInput = {
    effectiveFrom: { lte: on },
    OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }],
  };
  if (!query.includeInactive) where.isActive = true;
  if (query.section !== undefined) {
    where.section = Array.isArray(query.section) ? { in: query.section } : query.section;
  }
  if (query.audience !== undefined) where.audience = query.audience;
  if (query.complexityCategory !== undefined) where.complexityCategory = query.complexityCategory;
  if (query.direction !== undefined) where.direction = query.direction;
  if (query.turnaround !== undefined) where.turnaround = query.turnaround;
  if (query.includesNotary !== undefined) where.includesNotary = query.includesNotary;
  return where;
}

/** Строка из Prisma в `TariffRecord`: Decimal → number в одном месте, а не в
 *  каждом вызывающем. */
export function toTariffRecord(row: {
  naturalKey: string;
  section: string;
  sectionTitle: string | null;
  serviceName: string;
  authority: string | null;
  termText: string | null;
  conditions: string | null;
  amount: { toNumber(): number } | null;
  amountKind: string;
  percent: { toNumber(): number } | null;
  percentBase: string | null;
  baseFeeAmount: { toNumber(): number } | null;
  unit: string;
  currency: string;
  priceText: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  audience: string;
  footnote: string | null;
  language: string | null;
  complexityCategory: number | null;
  direction: string | null;
  turnaround: string | null;
  includesNotary: boolean;
  isActive: boolean;
  synonyms?: string[];
}): TariffRecord {
  return {
    ...row,
    synonyms: row.synonyms ?? [],
    section: row.section as TariffSectionKey,
    amount: row.amount?.toNumber() ?? null,
    amountKind: row.amountKind as TariffAmountKindKey,
    percent: row.percent?.toNumber() ?? null,
    baseFeeAmount: row.baseFeeAmount?.toNumber() ?? null,
    unit: row.unit as TariffUnitKey,
    audience: row.audience as TariffAudienceKey,
    direction: row.direction as TranslationDirectionKey | null,
    turnaround: row.turnaround as TariffTurnaroundKey | null,
  };
}
