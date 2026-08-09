import { describe, expect, it } from 'vitest';
import {
  EVALUATION_REVIEWER_ID,
  buildEvaluatedCandidate,
  buildEvaluationApplicabilityProfile,
  buildEvaluationKnowledgeUnitLike,
} from '../knowledge-unit-adapter';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';
import { UNKNOWN_QUERY_FACETS, UNKNOWN_TRIGGER_FACTS, type QueryFrame } from '@/lib/knowledge/applicability/query-frame';
import type { RequestContext } from '@/lib/knowledge/applicability/eligibility';

/**
 * pre-retrieval hardening -> benchmark goal shift (2026-08-09). No adapter
 * from PersistedKnowledgeUnit to ApplicabilityProfile/KnowledgeUnitLike/
 * EvaluatedCandidate exists anywhere in the codebase (confirmed by repo-wide
 * search before writing this). Two decisions, both confirmed with the user
 * (AskUserQuestion, 2026-08-09) before implementation:
 *
 * 1. reviewStatus='REVIEWED' with a clearly-fake reviewedBy
 *    (EVALUATION_HARNESS_UNREVIEWED) — otherwise eligibility.ts's
 *    review_unclassified_for_internal unconditionally sets
 *    requiresHumanReview=true, which resolution.ts propagates into a forced
 *    HOLD on every single case, regardless of retrieval/synthesis quality.
 * 2. Every applicable facet (in practice, only `scenario` for this fixture's
 *    kinds — PROCEDURE_STEP/EXCEPTION_RULE/TERM_DEFINITION) is GLOBAL, not
 *    SCOPED from real extracted values — this training document has no
 *    scenario/service/document-routing concept at all (confirmed: 0/41 real
 *    extracted units populate any production facet), so forcing SCOPED
 *    values would be inventing data. GLOBAL scope requires
 *    reviewStatus='REVIEWED', already true from decision 1, and honestly
 *    means "this rule was never meant to be partitioned by scenario" rather
 *    than pretending a UNKNOWN was actually decided.
 */

const REVIEWED_AT = '2026-08-09T00:00:00Z';

const span = (anchor: string, quote: string) => ({ anchor, quote });

function unit(overrides: Partial<PersistedKnowledgeUnit> = {}): PersistedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'заполнитель',
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    parentRuleRef: null,
    sourceSpan: span('anchor-1', 'заполнитель'),
    evidenceByField: { statement: span('anchor-1', 'заполнитель') },
    uncertainties: [],
    sourceBlockAnchor: 'block-1',
    unitId: 'u1',
    contentHash: 'hash-1',
    ...overrides,
  };
}

function emptyQueryFrame(overrides: Partial<QueryFrame> = {}): QueryFrame {
  return {
    concepts: [],
    facets: UNKNOWN_QUERY_FACETS,
    triggerFacts: UNKNOWN_TRIGGER_FACTS,
    questionAspects: [],
    ambiguities: [],
    ...overrides,
  };
}

const INTERNAL_CONTEXT: RequestContext = { audience: 'internal', now: REVIEWED_AT };

describe('buildEvaluationApplicabilityProfile', () => {
  it('reviewStatus=REVIEWED, reviewedBy=EVALUATION_HARNESS_UNREVIEWED — unmistakably synthetic, never a real human decision', () => {
    const profile = buildEvaluationApplicabilityProfile(unit(), REVIEWED_AT);
    expect(profile.reviewStatus).toBe('REVIEWED');
    expect(profile.reviewedBy).toBe(EVALUATION_REVIEWER_ID);
    expect(profile.reviewedAt).toBe(REVIEWED_AT);
  });

  it('каждая применимая для kind фасета — GLOBAL (PROCEDURE_STEP: только scenario)', () => {
    const profile = buildEvaluationApplicabilityProfile(unit({ kind: 'PROCEDURE_STEP' }), REVIEWED_AT);
    expect(profile.facets.scenario).toMatchObject({ state: 'GLOBAL' });
  });

  it('TERM_DEFINITION — ноль применимых facets, facets map пуст (не изобретаем оси, которых у kind нет)', () => {
    const profile = buildEvaluationApplicabilityProfile(unit({ kind: 'TERM_DEFINITION' }), REVIEWED_AT);
    expect(Object.keys(profile.facets)).toEqual([]);
  });

  it('audience всегда INTERNAL_ONLY — бенчмарк не изображает клиентский канал', () => {
    expect(buildEvaluationApplicabilityProfile(unit(), REVIEWED_AT).audience).toBe('INTERNAL_ONLY');
  });
});

describe('buildEvaluationKnowledgeUnitLike', () => {
  it('status=ACTIVE, validFrom/validUntil/sourceRevision=null — свежая экстракция без lifecycle-истории', () => {
    const like = buildEvaluationKnowledgeUnitLike(unit({ unitId: 'x1' }), REVIEWED_AT);
    expect(like.unitId).toBe('x1');
    expect(like.status).toBe('ACTIVE');
    expect(like.validFrom).toBeNull();
    expect(like.validUntil).toBeNull();
    expect(like.sourceRevision).toBeNull();
  });
});

describe('buildEvaluatedCandidate', () => {
  it('PROCEDURE_STEP без triggerCondition -> eligible=true, autoAnswerAllowed=true, scope MATCH (через GLOBAL), trigger=null', () => {
    const candidate = buildEvaluatedCandidate(
      unit({ kind: 'PROCEDURE_STEP' }),
      emptyQueryFrame(),
      INTERNAL_CONTEXT,
      REVIEWED_AT
    );
    expect(candidate.eligibility.eligible).toBe(true);
    expect(candidate.eligibility.autoAnswerAllowed).toBe(true);
    expect(candidate.scope.verdict).toBe('MATCH');
    expect(candidate.trigger).toBeNull();
  });

  it('EXCEPTION_RULE С triggerCondition -> trigger вычислен реальным evaluateTrigger, не заглушкой', () => {
    const candidate = buildEvaluatedCandidate(
      unit({ kind: 'EXCEPTION_RULE', triggerCondition: { all: [{ fact: 'helperPresent', equals: true }] } }),
      emptyQueryFrame(),
      INTERNAL_CONTEXT,
      REVIEWED_AT
    );
    expect(candidate.trigger).not.toBeNull();
    expect(candidate.trigger?.verdict).toBe('UNKNOWN'); // triggerFacts.helperPresent неизвестен в пустом QueryFrame
  });

  it('EXCEPTION_RULE БЕЗ triggerCondition -> trigger=null (реальный дефект экстракции, не маскируется адаптером)', () => {
    const candidate = buildEvaluatedCandidate(
      unit({ kind: 'EXCEPTION_RULE', triggerCondition: null }),
      emptyQueryFrame(),
      INTERNAL_CONTEXT,
      REVIEWED_AT
    );
    expect(candidate.trigger).toBeNull();
  });

  it('numericConstraint и parentRuleRef переносятся из unit как есть, supersedes всегда [] (ничто в extraction не производит эту связь)', () => {
    const candidate = buildEvaluatedCandidate(
      unit({ numericConstraint: { factKey: 'x', value: 15, unit: 'секунда' }, parentRuleRef: 'parent-1' }),
      emptyQueryFrame(),
      INTERNAL_CONTEXT,
      REVIEWED_AT
    );
    expect(candidate.numericConstraint).toEqual({ factKey: 'x', value: 15, unit: 'секунда' });
    expect(candidate.parentRuleRef).toBe('parent-1');
    expect(candidate.supersedes).toEqual([]);
  });
});
