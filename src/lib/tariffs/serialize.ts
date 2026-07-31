/**
 * Строка тарифа для админки: Decimal → number, Date → ISO, цена — готовым текстом.
 *
 * Цена печатается на сервере функцией `formatTariffPrice` — той же самой, что
 * готовит цену для ответа клиенту. Второй реализации форматирования в браузере
 * нет намеренно: разойдясь, они дадут админке и клиенту разные цены одной строки.
 */
import type { Tariff } from '@prisma/client';
import {
  formatTariffPrice,
  toTariffRecord,
  type TariffAmountKindKey,
  type TariffAudienceKey,
  type TariffSectionKey,
  type TariffTurnaroundKey,
  type TariffUnitKey,
  type TranslationDirectionKey,
} from '@/lib/knowledge/tariffs';
import type { NormalizedTariff } from './validation';

export interface TariffDTO {
  id: string;
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
  /** Цена с единицей одной строкой — то, что можно показать и назвать. */
  priceLabel: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  audience: TariffAudienceKey;
  footnote: string | null;
  language: string | null;
  complexityCategory: number | null;
  direction: TranslationDirectionKey | null;
  turnaround: TariffTurnaroundKey | null;
  includesNotary: boolean;
  sourceFile: string;
  documentId: string | null;
  documentTitle: string | null;
  sortOrder: number;
  isActive: boolean;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type TariffRow = Tariff & { document?: { title: string } | null };

export function serializeTariff(row: TariffRow): TariffDTO {
  const record = toTariffRecord(row);
  return {
    id: row.id,
    naturalKey: row.naturalKey,
    section: record.section,
    sectionTitle: row.sectionTitle,
    serviceName: row.serviceName,
    authority: row.authority,
    termText: row.termText,
    conditions: row.conditions,
    amount: record.amount,
    amountKind: record.amountKind,
    percent: record.percent,
    percentBase: row.percentBase,
    baseFeeAmount: record.baseFeeAmount,
    unit: record.unit,
    currency: row.currency,
    priceText: row.priceText,
    priceLabel: formatTariffPrice(record),
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
    audience: record.audience,
    footnote: row.footnote,
    language: row.language,
    complexityCategory: row.complexityCategory,
    direction: record.direction,
    turnaround: record.turnaround,
    includesNotary: row.includesNotary,
    sourceFile: row.sourceFile,
    documentId: row.documentId,
    documentTitle: row.document?.title ?? null,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Короткая карточка конфликтующей строки — то, что показывается в предупреждении. */
export interface TariffConflictDTO {
  id: string;
  serviceName: string;
  priceText: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export function toConflictDTO(row: {
  id: string;
  serviceName: string;
  priceText: string;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}): TariffConflictDTO {
  return {
    id: row.id,
    serviceName: row.serviceName,
    priceText: row.priceText,
    effectiveFrom: row.effectiveFrom.toISOString(),
    effectiveTo: row.effectiveTo ? row.effectiveTo.toISOString() : null,
  };
}

/** Проверенный тариф в виде полей Prisma. Общий для создания и правки, чтобы
 *  поле, добавленное в одном месте, не потерялось в другом. */
export function toPrismaData(value: NormalizedTariff) {
  return {
    section: value.section,
    sectionTitle: value.sectionTitle,
    serviceName: value.serviceName,
    authority: value.authority,
    termText: value.termText,
    conditions: value.conditions,
    amount: value.amount,
    amountKind: value.amountKind,
    percent: value.percent,
    percentBase: value.percentBase,
    baseFeeAmount: value.baseFeeAmount,
    unit: value.unit,
    currency: value.currency,
    priceText: value.priceText,
    effectiveFrom: value.effectiveFrom,
    effectiveTo: value.effectiveTo,
    audience: value.audience,
    footnote: value.footnote,
    language: value.language,
    complexityCategory: value.complexityCategory,
    direction: value.direction,
    turnaround: value.turnaround,
    includesNotary: value.includesNotary,
    sourceFile: value.sourceFile,
    sortOrder: value.sortOrder,
    isActive: value.isActive,
  };
}
