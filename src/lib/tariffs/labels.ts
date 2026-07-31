/**
 * Русские подписи для тарифной сетки.
 *
 * Названия разделов повторяют заголовки самих прайс-листов, а не пересказ:
 * владелец узнаёт свою бумагу по заголовку, и по нему же восстанавливается
 * страница, с которой снята строка.
 */
import type {
  TariffAmountKindKey,
  TariffAudienceKey,
  TariffSectionKey,
  TariffTurnaroundKey,
  TariffUnitKey,
  TranslationDirectionKey,
} from '@/lib/knowledge/tariffs';

export const SECTION_LABEL: Record<TariffSectionKey, string> = {
  TRANSLATION: 'Перевод (языковая матрица)',
  CERTIFICATION: 'Заверение и допуслуги',
  APOSTILLE_SPB: 'Апостиль в Санкт-Петербурге',
  APOSTILLE_EDUCATION: 'Апостиль на образовательные документы',
  APOSTILLE_MOSCOW: 'Апостиль в Москве',
  CONSULAR_LEGALIZATION: 'Консульская легализация',
  CHAMBER_OF_COMMERCE: 'Торгово-промышленная палата',
  VITAL_RECORDS_SPB: 'Истребование документов ЗАГС СПб',
  VITAL_RECORDS_URGENT: 'Срочное истребование документов',
  CRIMINAL_RECORD: 'Справка о несудимости',
  CRIMINAL_RECORD_APOSTILLE: 'Справка о несудимости с апостилем',
  NOSTRIFICATION: 'Нострификация',
};

export const UNIT_LABEL: Record<TariffUnitKey, string> = {
  DOCUMENT: 'за документ',
  PAGE: 'за страницу',
  CONDITIONAL_PAGE: 'за 1 условную страницу',
  MARK: 'за отметку',
  VISA: 'за визу',
  PERCENT: 'процент',
};

export const AMOUNT_KIND_LABEL: Record<TariffAmountKindKey, string> = {
  FIXED: 'Фиксированная сумма',
  FROM: 'Нижняя граница («от N руб.»)',
  PERCENT_OF_BASE: 'Процент от стоимости',
  PERCENT_SURCHARGE: 'Процентная надбавка',
};

export const TURNAROUND_LABEL: Record<TariffTurnaroundKey, string> = {
  STANDARD: 'Стандарт',
  IN_1_DAY: 'Через 1 день',
  NEXT_DAY: 'На следующий день',
  SAME_DAY: 'В день приёма',
  TWO_HOURS: 'Два часа',
};

export const DIRECTION_LABEL: Record<TranslationDirectionKey, string> = {
  FROM_FOREIGN: 'С иностранного',
  TO_FOREIGN: 'На иностранный',
};

export const AUDIENCE_LABEL: Record<TariffAudienceKey, string> = {
  INTERNAL_ONLY: 'Только внутренний',
  CLIENT_SAFE: 'Можно клиенту',
};

export const CATEGORY_LABEL: Record<number, string> = {
  1: '1 категория',
  2: '2 категория',
  3: '3 категория',
};

export function formatDateRu(value: string | Date | null): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('ru-RU', { timeZone: 'UTC' });
}

/** Дата для `<input type="date">`: поле понимает только YYYY-MM-DD. */
export function toDateInputValue(value: string | Date | null): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}
