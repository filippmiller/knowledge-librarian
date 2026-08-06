import { z } from 'zod';

/**
 * Примитивы ревью — общие для unit-уровневой тройки (`ApplicabilityProfile`)
 * и для аудит-полей `FacetState.GLOBAL`.
 *
 * Живут отдельным модулем, потому что оба потребителя обязаны использовать
 * ОДИН формат: расхождение (`Date` в одном месте, строка в другом) уже было
 * найдено ревью в наброске плана. Контракт — ISO-8601 строка везде на границе
 * (JSON / JSONL / Zod); `Date` допустим только внутри рантайма после явного
 * parse и никогда в самом контракте (truth table §5.1).
 */

/** Статус процесса ревью, унитарный на весь unit (truth table §5). */
export const REVIEW_STATUSES = ['UNCLASSIFIED', 'REVIEWED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export const reviewStatusSchema = z.enum(REVIEW_STATUSES);

/**
 * Кто подтвердил. Пустая строка запрещена: «подтверждено кем-то безымянным»
 * неотличимо от «не подтверждено», а именно это различие несёт весь §5.1.
 */
export const reviewerIdSchema = z.string().min(1, 'reviewedBy не может быть пустой строкой');

/**
 * Когда подтверждено. Строго ISO-8601 с датой И временем: `2026-08-06`
 * (только дата) отклоняется, потому что аудит без времени не восстанавливает
 * порядок правок. Смещение допускается любое (`Z` или `+03:00`).
 */
export const isoTimestampSchema = z.iso.datetime({ offset: true });
