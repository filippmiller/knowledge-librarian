import { z } from 'zod';
import { isoTimestampSchema, reviewerIdSchema } from './review';
import { nonBlankString } from './text';

/**
 * Явное человеческое решение по одному `unitId` (PR F, план §3). Три
 * значения, не boolean accept/reject: `EDIT` — человек изменил содержание
 * unit'а перед принятием, и это отдельный факт от простого accept.
 */
export const REVIEW_DECISION_TYPES = ['ACCEPT', 'REJECT', 'EDIT'] as const;
export type ReviewDecisionType = (typeof REVIEW_DECISION_TYPES)[number];

export interface ReviewDecision {
  readonly unitId: string;
  readonly decision: ReviewDecisionType;
  readonly reviewedBy: string;
  readonly reviewedAt: string;
  readonly notes?: string;
}

export const reviewDecisionSchema = z.strictObject({
  unitId: nonBlankString('unitId не может быть пустым'),
  decision: z.enum(REVIEW_DECISION_TYPES),
  reviewedBy: reviewerIdSchema,
  reviewedAt: isoTimestampSchema,
  notes: nonBlankString('notes не может быть пустой строкой').optional(),
});

/**
 * Повторный прогон по неизменному документу НЕ создаёт дубликат
 * review-решения для одного и того же `unitId` (acceptance criterion PR F) —
 * last-write-wins upsert, а не append. Новое решение по тому же `unitId`
 * заменяет старое целиком (включая `reviewedAt`) — это осознанная РЕ-ревизия,
 * не два параллельных мнения по одному unit'у.
 */
export function upsertReviewDecision(
  existing: readonly ReviewDecision[],
  decision: ReviewDecision
): ReviewDecision[] {
  return [...existing.filter((d) => d.unitId !== decision.unitId), decision];
}
