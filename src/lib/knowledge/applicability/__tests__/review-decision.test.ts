import { describe, expect, it } from 'vitest';
import { reviewDecisionSchema, upsertReviewDecision, type ReviewDecision } from '../review-decision';

const DECISION_1: ReviewDecision = {
  unitId: 'unit-1',
  decision: 'ACCEPT',
  reviewedBy: 'anna',
  reviewedAt: '2026-08-07T10:00:00Z',
};

describe('reviewDecisionSchema', () => {
  it('валидное решение проходит', () => {
    expect(reviewDecisionSchema.safeParse(DECISION_1).success).toBe(true);
  });

  it.each(['', ' '])('пустой по смыслу reviewedBy (%j) отвергается', (blank) => {
    expect(reviewDecisionSchema.safeParse({ ...DECISION_1, reviewedBy: blank }).success).toBe(false);
  });

  it('дата без времени (только дата) отвергается', () => {
    expect(reviewDecisionSchema.safeParse({ ...DECISION_1, reviewedAt: '2026-08-07' }).success).toBe(
      false
    );
  });

  it('decision вне ACCEPT/REJECT/EDIT отвергается', () => {
    expect(reviewDecisionSchema.safeParse({ ...DECISION_1, decision: 'MAYBE' }).success).toBe(false);
  });
});

describe('upsertReviewDecision — повторный прогон не создаёт дубликат (acceptance criterion PR F)', () => {
  it('новый unitId — добавляется', () => {
    const result = upsertReviewDecision([], DECISION_1);
    expect(result).toEqual([DECISION_1]);
  });

  it('тот же unitId повторно — заменяет, не дублирует', () => {
    const updated: ReviewDecision = { ...DECISION_1, decision: 'REJECT', reviewedAt: '2026-08-07T11:00:00Z' };
    const result = upsertReviewDecision([DECISION_1], updated);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(updated);
  });

  it('решения по разным unitId сосуществуют', () => {
    const other: ReviewDecision = { ...DECISION_1, unitId: 'unit-2' };
    const result = upsertReviewDecision([DECISION_1], other);
    expect(result).toHaveLength(2);
  });
});
