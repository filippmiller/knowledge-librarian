/**
 * Проверки тарифа перед записью — чистые функции, без базы и без сети.
 *
 * Вынесены из маршрута намеренно: цена, записанная с ошибкой, уходит клиенту как
 * обещание, поэтому проверки должны прогоняться сотнями кейсов в
 * `scripts/verify-tariff-api.ts`, а не только руками через форму.
 *
 * Главная из проверок — не арифметическая. Два действующих тарифа на одну услугу
 * («20 000 против 22 000») неотличимы для движка ответов: он возьмёт любой и
 * назовёт его уверенно. Поэтому пересечение периодов ловится здесь и требует
 * явного подтверждения человеком, а не молча создаёт вторую истину.
 */
import {
  languageStem,
  normalizeText,
  type TariffAmountKindKey,
  type TariffAudienceKey,
  type TariffSectionKey,
  type TariffTurnaroundKey,
  type TariffUnitKey,
  type TranslationDirectionKey,
} from '@/lib/knowledge/tariffs';

export const TARIFF_SECTIONS: TariffSectionKey[] = [
  'TRANSLATION',
  'CERTIFICATION',
  'APOSTILLE_SPB',
  'APOSTILLE_EDUCATION',
  'APOSTILLE_MOSCOW',
  'CONSULAR_LEGALIZATION',
  'CHAMBER_OF_COMMERCE',
  'VITAL_RECORDS_SPB',
  'VITAL_RECORDS_URGENT',
  'CRIMINAL_RECORD',
  'CRIMINAL_RECORD_APOSTILLE',
  'NOSTRIFICATION',
];

export const TARIFF_UNITS: TariffUnitKey[] = [
  'DOCUMENT',
  'PAGE',
  'CONDITIONAL_PAGE',
  'MARK',
  'VISA',
  'PERCENT',
];

export const TARIFF_AMOUNT_KINDS: TariffAmountKindKey[] = [
  'FIXED',
  'FROM',
  'PERCENT_OF_BASE',
  'PERCENT_SURCHARGE',
];

export const TARIFF_TURNAROUNDS: TariffTurnaroundKey[] = [
  'STANDARD',
  'IN_1_DAY',
  'NEXT_DAY',
  'SAME_DAY',
  'TWO_HOURS',
];

export const TRANSLATION_DIRECTIONS: TranslationDirectionKey[] = ['FROM_FOREIGN', 'TO_FOREIGN'];

export const TARIFF_AUDIENCES: TariffAudienceKey[] = ['INTERNAL_ONLY', 'CLIENT_SAFE'];

/** Верхняя граница суммы. Не бизнес-правило, а защита от опечатки на порядок:
 *  самая дорогая услуга прайса — 27 500 ₽. */
const MAX_AMOUNT = 10_000_000;

export interface ValidationIssue {
  field: string;
  message: string;
}

/** Тариф, приведённый к типам базы. Ровно то, что можно отдать в Prisma. */
export interface NormalizedTariff {
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
  sourceFile: string;
  sortOrder: number;
  isActive: boolean;
}

export type TariffValidationResult =
  | { ok: true; value: NormalizedTariff }
  | { ok: false; issues: ValidationIssue[] };

export const MANUAL_SOURCE_FILE = 'Ручной ввод в админке';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(raw: Record<string, unknown>, field: string): string | null {
  const value = raw[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Число из формы. Строка допускается: браузер отдаёт значения полей текстом, а
 * владелец пишет цену так, как привык — «1 100,50» и с неразрывным пробелом.
 */
function readNumber(
  raw: Record<string, unknown>,
  field: string,
  issues: ValidationIssue[]
): number | null {
  const value = raw[field];
  if (value === undefined || value === null || value === '') return null;
  let parsed: number;
  if (typeof value === 'number') {
    parsed = value;
  } else if (typeof value === 'string') {
    parsed = Number(value.replace(/[\s ]/g, '').replace(',', '.'));
  } else {
    issues.push({ field, message: 'Ожидалось число' });
    return null;
  }
  if (!Number.isFinite(parsed)) {
    issues.push({ field, message: 'Ожидалось число' });
    return null;
  }
  return parsed;
}

function readDate(
  raw: Record<string, unknown>,
  field: string,
  issues: ValidationIssue[]
): Date | null {
  const value = raw[field];
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      issues.push({ field, message: 'Некорректная дата' });
      return null;
    }
    return value;
  }
  if (typeof value !== 'string') {
    issues.push({ field, message: 'Некорректная дата' });
    return null;
  }
  // «2026-01-01» без времени читается как полночь UTC — так же, как это делает
  // импорт прайса, иначе граница периода уезжает на часовой пояс сервера.
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    issues.push({ field, message: 'Некорректная дата' });
    return null;
  }
  return parsed;
}

function readEnum<T extends string>(
  raw: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  issues: ValidationIssue[],
  { required, fallback }: { required: boolean; fallback?: T }
): T | null {
  const value = raw[field];
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    if (required) issues.push({ field, message: 'Поле обязательно' });
    return null;
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    issues.push({ field, message: `Недопустимое значение: ${String(value)}` });
    return null;
  }
  return value as T;
}

function readBoolean(raw: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = raw[field];
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return fallback;
}

function isPercentKind(kind: TariffAmountKindKey): boolean {
  return kind === 'PERCENT_OF_BASE' || kind === 'PERCENT_SURCHARGE';
}

/**
 * Разбор и проверка тарифа целиком.
 *
 * Частичного разбора нет намеренно: при редактировании маршрут склеивает
 * существующую строку с правкой и проверяет результат целиком. Иначе правка
 * одного поля («сделать строку процентной») оставляет строку в состоянии,
 * которое по частям выглядит законным, а вместе — нет.
 */
export function validateTariffInput(input: unknown): TariffValidationResult {
  const issues: ValidationIssue[] = [];

  if (!isRecord(input)) {
    return { ok: false, issues: [{ field: '_', message: 'Ожидался объект с полями тарифа' }] };
  }
  const raw = input;

  const section = readEnum(raw, 'section', TARIFF_SECTIONS, issues, { required: true });
  const amountKind =
    readEnum(raw, 'amountKind', TARIFF_AMOUNT_KINDS, issues, {
      required: false,
      fallback: 'FIXED',
    }) ?? 'FIXED';
  const unit = readEnum(raw, 'unit', TARIFF_UNITS, issues, { required: true });
  const audience =
    readEnum(raw, 'audience', TARIFF_AUDIENCES, issues, {
      required: false,
      fallback: 'INTERNAL_ONLY',
    }) ?? 'INTERNAL_ONLY';
  const direction = readEnum(raw, 'direction', TRANSLATION_DIRECTIONS, issues, { required: false });
  const turnaround = readEnum(raw, 'turnaround', TARIFF_TURNAROUNDS, issues, { required: false });

  const serviceName = readString(raw, 'serviceName');
  if (!serviceName) {
    issues.push({ field: 'serviceName', message: 'Название услуги обязательно' });
  }

  const priceText = readString(raw, 'priceText');
  if (!priceText) {
    issues.push({
      field: 'priceText',
      message: 'Цена текстом обязательна: клиенту уходит именно эта формулировка',
    });
  }

  const amount = readNumber(raw, 'amount', issues);
  const percent = readNumber(raw, 'percent', issues);
  const baseFeeAmount = readNumber(raw, 'baseFeeAmount', issues);
  const percentBase = readString(raw, 'percentBase');

  if (amount !== null) {
    if (amount <= 0) {
      issues.push({ field: 'amount', message: 'Сумма должна быть больше нуля' });
    } else if (amount > MAX_AMOUNT) {
      issues.push({
        field: 'amount',
        message: `Сумма больше ${MAX_AMOUNT.toLocaleString('ru-RU')} ₽ — похоже на опечатку`,
      });
    }
  }

  if (baseFeeAmount !== null && baseFeeAmount <= 0) {
    issues.push({ field: 'baseFeeAmount', message: 'Разовый тариф должен быть больше нуля' });
  }

  if (isPercentKind(amountKind)) {
    if (percent === null) {
      issues.push({ field: 'percent', message: 'Для процентной строки нужен процент' });
    } else if (percent <= 0) {
      issues.push({ field: 'percent', message: 'Процент должен быть больше нуля' });
    } else if (percent > 1000) {
      issues.push({ field: 'percent', message: 'Процент больше 1000 — похоже на опечатку' });
    }
    if (amount !== null) {
      issues.push({
        field: 'amount',
        message: 'У процентной строки заполняется процент, а не сумма',
      });
    }
    if (amountKind === 'PERCENT_OF_BASE' && !percentBase) {
      issues.push({ field: 'percentBase', message: 'Укажите, от чего считается процент' });
    }
  } else {
    if (amount === null) {
      issues.push({ field: 'amount', message: 'Сумма обязательна' });
    }
    if (percent !== null) {
      issues.push({
        field: 'percent',
        message: 'Процент заполняется только у процентных строк',
      });
    }
  }

  const language = readString(raw, 'language');
  const complexityCategory = readNumber(raw, 'complexityCategory', issues);
  const includesNotary = readBoolean(raw, 'includesNotary', false);

  if (section === 'TRANSLATION') {
    if (!language) {
      issues.push({ field: 'language', message: 'Для строки матрицы обязателен язык' });
    }
    if (complexityCategory === null) {
      issues.push({
        field: 'complexityCategory',
        message: 'Для строки матрицы обязательна категория сложности',
      });
    } else if (![1, 2, 3].includes(complexityCategory)) {
      issues.push({ field: 'complexityCategory', message: 'Категория сложности — 1, 2 или 3' });
    }
    if (!direction) {
      issues.push({ field: 'direction', message: 'Для строки матрицы обязательно направление' });
    }
    if (!turnaround) {
      issues.push({ field: 'turnaround', message: 'Для строки матрицы обязателен срок' });
    }
  } else if (section !== null) {
    // Признаки матрицы у плоской услуги означают, что строку завели не в тот
    // раздел: отбор по языку молча вернёт её вместе с ценами перевода.
    const stray: string[] = [];
    if (language) stray.push('язык');
    if (complexityCategory !== null) stray.push('категория сложности');
    if (direction) stray.push('направление');
    if (turnaround) stray.push('срок из матрицы');
    if (includesNotary) stray.push('признак «вкл. НЗ»');
    if (stray.length > 0) {
      issues.push({
        field: 'section',
        message: `Признаки языковой матрицы (${stray.join(', ')}) заполняются только в разделе «Перевод»`,
      });
    }
  }

  const effectiveFrom = readDate(raw, 'effectiveFrom', issues);
  if (effectiveFrom === null && !issues.some((i) => i.field === 'effectiveFrom')) {
    issues.push({ field: 'effectiveFrom', message: 'Дата начала действия обязательна' });
  }
  const effectiveTo = readDate(raw, 'effectiveTo', issues);
  if (effectiveFrom && effectiveTo && effectiveTo.getTime() <= effectiveFrom.getTime()) {
    issues.push({
      field: 'effectiveTo',
      message: 'Дата окончания должна быть строго позже даты начала',
    });
  }

  const currencyRaw = readString(raw, 'currency') ?? 'RUB';
  const currency = currencyRaw.toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    issues.push({ field: 'currency', message: 'Валюта — три латинские буквы, например RUB' });
  }

  const sortOrderRaw = readNumber(raw, 'sortOrder', issues);
  if (sortOrderRaw !== null && !Number.isInteger(sortOrderRaw)) {
    issues.push({ field: 'sortOrder', message: 'Порядок — целое число' });
  }

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    value: {
      section: section as TariffSectionKey,
      sectionTitle: readString(raw, 'sectionTitle'),
      serviceName: serviceName as string,
      authority: readString(raw, 'authority'),
      termText: readString(raw, 'termText'),
      conditions: readString(raw, 'conditions'),
      amount,
      amountKind,
      percent,
      percentBase,
      baseFeeAmount,
      unit: unit as TariffUnitKey,
      currency,
      priceText: priceText as string,
      effectiveFrom: effectiveFrom as Date,
      effectiveTo,
      audience,
      footnote: readString(raw, 'footnote'),
      language,
      complexityCategory,
      direction,
      turnaround,
      includesNotary,
      sourceFile: readString(raw, 'sourceFile') ?? MANUAL_SOURCE_FILE,
      sortOrder: sortOrderRaw === null ? 0 : sortOrderRaw,
      isActive: readBoolean(raw, 'isActive', true),
    },
  };
}

// ---------------------------------------------------------------------------
// Пересечение периодов
// ---------------------------------------------------------------------------

/** Признаки, по которым две строки считаются ценой одной и той же услуги. */
export interface TariffIdentity {
  section: TariffSectionKey;
  audience: TariffAudienceKey;
  serviceName: string;
  authority: string | null;
  termText: string | null;
  language: string | null;
  complexityCategory: number | null;
  direction: TranslationDirectionKey | null;
  turnaround: TariffTurnaroundKey | null;
  includesNotary: boolean;
}

export interface TariffPeriod {
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface ExistingTariff extends TariffIdentity, TariffPeriod {
  id: string;
  priceText: string;
  isActive: boolean;
}

/**
 * Ключ услуги.
 *
 * У матрицы — признаки клетки: название услуги там собрано из шапок таблицы и
 * может быть напечатано по-разному, а клетка одна. Язык сравнивается по основе
 * слова, потому что «АНГЛИЙСКИЙ» из прайса и «английского» из формы — один язык.
 *
 * Контур входит в ключ: клиентская и внутренняя цена одной услуги живут
 * одновременно законно, это не противоречие.
 */
export function tariffIdentityKey(t: TariffIdentity): string {
  if (t.section === 'TRANSLATION') {
    return [
      'TRANSLATION',
      t.audience,
      languageStem(t.language ?? ''),
      t.complexityCategory ?? '',
      t.direction ?? '',
      t.turnaround ?? '',
      t.includesNotary ? 'nz' : 'net',
    ].join('|');
  }
  return [
    t.section,
    t.audience,
    normalizeText(t.serviceName),
    normalizeText(t.authority ?? ''),
    normalizeText(t.termText ?? ''),
  ].join('|');
}

/** Два периода перекрываются хотя бы одним днём. Открытый конец — бесконечность. */
export function periodsOverlap(a: TariffPeriod, b: TariffPeriod): boolean {
  const aTo = a.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY;
  const bTo = b.effectiveTo?.getTime() ?? Number.POSITIVE_INFINITY;
  return a.effectiveFrom.getTime() <= bTo && b.effectiveFrom.getTime() <= aTo;
}

/**
 * Действующие тарифы на ту же услугу с пересекающимся периодом.
 *
 * Архивные строки конфликтом не считаются: снятая с публикации цена — это
 * история, ради которой архивирование и сделано вместо удаления.
 */
export function findOverlappingTariffs(
  candidate: TariffIdentity & TariffPeriod & { isActive?: boolean },
  existing: ExistingTariff[],
  options: { excludeId?: string } = {}
): ExistingTariff[] {
  if (candidate.isActive === false) return [];
  const key = tariffIdentityKey(candidate);
  return existing.filter(
    (row) =>
      row.isActive &&
      row.id !== options.excludeId &&
      tariffIdentityKey(row) === key &&
      periodsOverlap(candidate, row)
  );
}
