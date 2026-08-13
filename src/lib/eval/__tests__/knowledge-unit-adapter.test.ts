import { describe, expect, it } from 'vitest';
import {
  EVALUATION_REVIEWER_ID,
  buildEvaluatedCandidate,
  buildEvaluatedCandidates,
  hasSourceBackedNecessaryCondition,
  buildEvaluationApplicabilityProfile,
  buildEvaluationKnowledgeUnitLike,
} from '../knowledge-unit-adapter';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';
import { UNKNOWN_QUERY_FACETS, UNKNOWN_TRIGGER_FACTS, type QueryFrame } from '@/lib/knowledge/applicability/query-frame';
import type { RequestContext } from '@/lib/knowledge/applicability/eligibility';
import { resolveKnowledgeSet } from '@/lib/knowledge/applicability/resolution';

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

describe('necessary-condition proof', () => {
  it('accepts conservative source markers and rejects generic sufficient if-then wording', () => {
    expect(hasSourceBackedNecessaryCondition('Действие разрешено только при согласии.', [])).toBe(true);
    expect(hasSourceBackedNecessaryCondition('Действие разрешено.', ['лишь после проверки'])).toBe(true);
    expect(hasSourceBackedNecessaryCondition('Если согласие есть, действие разрешено.', ['если есть согласие'])).toBe(false);
    expect(hasSourceBackedNecessaryCondition('Действие разрешено не только при согласии.', [])).toBe(false);
    expect(hasSourceBackedNecessaryCondition('Действие разрешено не только после проверки.', [])).toBe(false);
    expect(hasSourceBackedNecessaryCondition('Действие разрешено не лишь при согласии.', [])).toBe(false);
    expect(hasSourceBackedNecessaryCondition('Действие разрешено не лишь после проверки.', [])).toBe(false);
    expect(hasSourceBackedNecessaryCondition('Возможно, действие разрешено только при согласии.', [])).toBe(false);
    expect(hasSourceBackedNecessaryCondition('Действие разрешено не всегда только при согласии.', [])).toBe(false);
  });
});

function queryWithFacts(facts: Partial<QueryFrame['triggerFacts']>): QueryFrame {
  return emptyQueryFrame({ triggerFacts: { ...UNKNOWN_TRIGGER_FACTS, ...facts } });
}

function knownFact<T>(value: T) {
  return { state: 'KNOWN' as const, value, evidence: [{ source: 'CURRENT_MESSAGE' as const, quote: String(value) }] };
}

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

  it('sourceBlockAnchor доносится до кандидата — иначе вето по соседям мертво в проде', () => {
    // Регрессия на реальный дефект: вето по соседям в resolveKnowledgeSet
    // ищет кандидатов с общим sourceBlockAnchor, а адаптер — единственный
    // путь из персистентного юнита в кандидата на живом прогоне — поле не
    // проставлял. Тесты резолюции собирают кандидатов вручную и якорь задают,
    // поэтому оставались зелёными при полностью мёртвой защите. Этот тест
    // стережёт именно связь между слоями, а не поведение каждого из них.
    const candidate = buildEvaluatedCandidate(
      unit({ kind: 'PROCEDURE_STEP' }),
      emptyQueryFrame(),
      INTERNAL_CONTEXT,
      REVIEWED_AT
    );
    expect(candidate.sourceBlockAnchor).toBe(unit({ kind: 'PROCEDURE_STEP' }).sourceBlockAnchor);
    expect(candidate.sourceBlockAnchor).toBeDefined();
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

  it.each([
    ['PUBLIC', 'ACTIVE', 'ANSWER'],
    ['PRIVATE', 'INACTIVE', 'HOLD'],
  ] as const)(
    'PROCEDURE_STEP with PUBLIC trigger and query=%s -> %s, resolution=%s',
    (privacy, triggerVerdict, disposition) => {
      const query = emptyQueryFrame({
        triggerFacts: {
          ...UNKNOWN_TRIGGER_FACTS,
          privacyContext: { state: 'KNOWN', value: privacy, evidence: [] },
        },
      });
      const candidate = buildEvaluatedCandidate(
        unit({
          unitId: `public-step-${privacy}`,
          kind: 'PROCEDURE_STEP',
          triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] },
        }),
        query,
        INTERNAL_CONTEXT,
        REVIEWED_AT
      );
      expect(candidate.trigger?.verdict).toBe(triggerVerdict);
      const resolution = resolveKnowledgeSet([candidate], query);
      expect(resolution.disposition).toBe(disposition);
      if (privacy === 'PUBLIC') expect(resolution.selected).toEqual([`public-step-${privacy}`]);
      else expect(resolution.excluded).toContainEqual({
        unitId: `public-step-${privacy}`, reason: 'exception_trigger_inactive',
      });
    }
  );

  it('PROCEDURE_STEP with unknown PUBLIC trigger reaches synthesis as conditional evidence', () => {
    const query = emptyQueryFrame();
    const candidate = buildEvaluatedCandidate(
      unit({
        unitId: 'public-step-unknown',
        kind: 'PROCEDURE_STEP',
        triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] },
      }),
      query,
      INTERNAL_CONTEXT,
      REVIEWED_AT
    );
    expect(candidate.trigger?.verdict).toBe('UNKNOWN');
    const resolution = resolveKnowledgeSet([candidate], query);
    expect(resolution.disposition).toBe('ANSWER');
    expect(resolution.selected).toEqual(['public-step-unknown']);
    expect(resolution.selectedApplicability).toContainEqual(
      expect.objectContaining({ unitId: 'public-step-unknown', mode: 'CONDITIONAL' })
    );
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

describe('buildEvaluatedCandidates — effective trigger inheritance', () => {
  const publicCondition = { all: [{ fact: 'privacyContext' as const, equals: 'PUBLIC' as const }] };

  function publicExceptionGraph() {
    const base = unit({ unitId: 'base' });
    const parent = unit({
      unitId: 'public-exception',
      kind: 'EXCEPTION_RULE',
      parentRuleRef: 'base',
      triggerCondition: publicCondition,
    });
    const child = unit({
      unitId: 'count-fragment',
      parentRuleRef: 'public-exception',
      numericConstraint: { factKey: 'maximum actions', value: 1, unit: 'times' },
    });
    const all = [base, parent, child];
    return { all, byId: new Map(all.map((item) => [item.unitId, item])) };
  }

  it.each([
    ['PUBLIC', 'ACTIVE', 'ANSWER', ['public-exception', 'count-fragment']],
    ['PRIVATE', 'INACTIVE', 'ANSWER', ['base']],
  ] as const)('PUBLIC exception child with null trigger: query=%s => child %s', (privacy, verdict, disposition, selected) => {
    const graph = publicExceptionGraph();
    const query = queryWithFacts({ privacyContext: knownFact(privacy) });
    const evaluated = buildEvaluatedCandidates(graph.all, graph.byId, query, INTERNAL_CONTEXT, REVIEWED_AT);
    expect(evaluated.find((item) => item.unitId === 'count-fragment')?.trigger?.verdict).toBe(verdict);
    const resolution = resolveKnowledgeSet(evaluated, query);
    expect(resolution.disposition).toBe(disposition);
    expect(resolution.selected).toEqual(selected);
  });

  it('unknown inherited PUBLIC trigger holds both exception and fragment and asks once for privacy', () => {
    const graph = publicExceptionGraph();
    const query = emptyQueryFrame();
    const evaluated = buildEvaluatedCandidates(graph.all, graph.byId, query, INTERNAL_CONTEXT, REVIEWED_AT);
    expect(evaluated.slice(1).map((item) => item.trigger?.verdict)).toEqual(['UNKNOWN', 'UNKNOWN']);
    const resolution = resolveKnowledgeSet(evaluated, query);
    expect(resolution.disposition).toBe('CLARIFY');
    expect(resolution.clarificationNeeds.triggerFacts).toEqual(['privacyContext']);
  });

  it('inherits transitively and independently of candidate order', () => {
    const parent = unit({ unitId: 'parent', triggerCondition: publicCondition });
    const child = unit({ unitId: 'child', parentRuleRef: 'parent' });
    const grandchild = unit({ unitId: 'grandchild', parentRuleRef: 'child' });
    const full = new Map([grandchild, child, parent].map((item) => [item.unitId, item]));
    const query = queryWithFacts({ privacyContext: knownFact('PRIVATE') });
    const evaluated = buildEvaluatedCandidates([grandchild, child, parent], full, query, INTERNAL_CONTEXT, REVIEWED_AT);
    expect(evaluated.map((item) => item.trigger?.verdict)).toEqual(['INACTIVE', 'INACTIVE', 'INACTIVE']);
  });

  it('carries the parent source quote as inherited presentation evidence', () => {
    const parent = unit({
      unitId: 'parent',
      triggerCondition: publicCondition,
      evidenceByField: {
        statement: span('anchor-1', 'step'),
        triggerCondition: span('anchor-1', 'only in a public setting'),
      },
    });
    const child = unit({ unitId: 'child', parentRuleRef: 'parent' });
    const full = new Map([parent, child].map((item) => [item.unitId, item]));
    const [evaluated] = buildEvaluatedCandidates([child], full, emptyQueryFrame(), INTERNAL_CONTEXT, REVIEWED_AT);
    expect(evaluated.triggerPresentationConditions).toEqual(['only in a public setting']);
    const resolution = resolveKnowledgeSet([evaluated], emptyQueryFrame());
    expect(resolution.selectedApplicability).toContainEqual({
      unitId: 'child', mode: 'CONDITIONAL', presentationConditions: ['only in a public setting'],
    });
  });

  it('ANDs a narrower own trigger with inherited applicability', () => {
    const parent = unit({ unitId: 'parent', triggerCondition: publicCondition });
    const child = unit({
      unitId: 'child',
      parentRuleRef: 'parent',
      triggerCondition: { all: [{ fact: 'helperPresent', equals: true }] },
    });
    const full = new Map([parent, child].map((item) => [item.unitId, item]));
    const verdict = (privacy: 'PUBLIC' | 'PRIVATE', helper: boolean | null) => {
      const query = queryWithFacts({
        privacyContext: knownFact(privacy),
        ...(helper === null ? {} : { helperPresent: knownFact(helper) }),
      });
      return buildEvaluatedCandidates([child], full, query, INTERNAL_CONTEXT, REVIEWED_AT)[0]?.trigger?.verdict;
    };
    expect(verdict('PUBLIC', true)).toBe('ACTIVE');
    expect(verdict('PUBLIC', null)).toBe('UNKNOWN');
    expect(verdict('PRIVATE', true)).toBe('INACTIVE');
  });

  it('does not inherit an EXCEPTION_RULE parent trigger: its own trigger remains the override condition', () => {
    const parent = unit({ unitId: 'parent', triggerCondition: publicCondition });
    const exception = unit({
      unitId: 'exception', kind: 'EXCEPTION_RULE', parentRuleRef: 'parent',
      triggerCondition: { all: [{ fact: 'helperPresent', equals: true }] },
    });
    const full = new Map([parent, exception].map((item) => [item.unitId, item]));
    const query = queryWithFacts({ privacyContext: knownFact('PRIVATE'), helperPresent: knownFact(true) });
    const [evaluated] = buildEvaluatedCandidates([exception], full, query, INTERNAL_CONTEXT, REVIEWED_AT);
    expect(evaluated.trigger?.verdict).toBe('ACTIVE');
    expect(evaluated.trigger?.clauseVerdicts.map((clause) => clause.fact)).toEqual(['helperPresent']);
  });

  it.each(['dangling', 'cycle', 'contradiction'] as const)('%s structural graph fails closed as UNKNOWN', (shape) => {
    const parent = unit({ unitId: 'parent', triggerCondition: publicCondition, parentRuleRef: shape === 'cycle' ? 'child' : null });
    const child = unit({
      unitId: 'child',
      parentRuleRef: shape === 'dangling' ? 'missing' : 'parent',
      triggerCondition: shape === 'contradiction'
        ? { all: [{ fact: 'privacyContext', equals: 'PRIVATE' }] }
        : null,
    });
    const full = new Map([parent, child].map((item) => [item.unitId, item]));
    const query = queryWithFacts({ privacyContext: knownFact('PUBLIC') });
    const [evaluated] = buildEvaluatedCandidates([child], full, query, INTERNAL_CONTEXT, REVIEWED_AT);
    expect(evaluated.trigger?.verdict).toBe('UNKNOWN');
    expect(resolveKnowledgeSet([evaluated], query).disposition).toBe('HOLD');
  });
});
