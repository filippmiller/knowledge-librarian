/**
 * PersistedKnowledgeUnit -> ApplicabilityProfile / KnowledgeUnitLike /
 * EvaluatedCandidate (goal shift 2026-08-09: evaluation-only benchmark
 * runner, Task 13). No such adapter existed anywhere in the codebase before
 * this file — confirmed by repo-wide search. Two decisions here, both
 * confirmed with the user (AskUserQuestion, 2026-08-09) before writing this:
 *
 * 1. `reviewStatus: 'REVIEWED'` with a clearly-fake `reviewedBy`
 *    (`EVALUATION_REVIEWER_ID`) — otherwise `evaluateUnitEligibility`'s
 *    `review_unclassified_for_internal` branch unconditionally sets
 *    `requiresHumanReview = true`, and `resolveKnowledgeSet` forces
 *    `disposition = 'HOLD'` on every case that selects such a candidate,
 *    regardless of retrieval/synthesis quality — the benchmark would
 *    measure nothing but that gate firing 16/16 times.
 *
 * 2. Every applicable facet is `GLOBAL`, never `SCOPED` from real extracted
 *    values. This training document has no scenario/service/routing
 *    concept — confirmed empirically: 0 of 41 real `--stage=extraction`
 *    units (`scratchpad/extraction-runs/run1`) populate ANY production
 *    facet. `evaluateFacet` (`scope.ts:163`) returns `unknown_profile_scope`
 *    (NOT in `ASKABLE_SCOPE_SITUATIONS`) whenever a profile facet is
 *    `UNKNOWN`, independent of what the query says — so leaving `scenario`
 *    `UNKNOWN` would force `scope.verdict = 'UNKNOWN'` -> held ->
 *    non-askable -> `requiresHumanReview` -> HOLD, the same dead end as (1)
 *    via a different path. `GLOBAL` is the honest label here: this rule was
 *    never meant to be partitioned by scenario, not "a human reviewed and
 *    scoped it to nothing."
 *
 * Both are confined to `src/lib/eval/` (this evaluation-only path) and
 * clearly labeled — `EVALUATION_REVIEWER_ID` is unmistakable in every
 * artifact this produces.
 */

import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';
import type { ApplicabilityProfile } from '@/lib/knowledge/applicability/profile';
import type { FacetMap } from '@/lib/knowledge/applicability/facets';
import { applicableFacetsOf } from '@/lib/knowledge/applicability/kinds';
import {
  evaluateUnitEligibility,
  type KnowledgeUnitLike,
  type RequestContext,
} from '@/lib/knowledge/applicability/eligibility';
import { evaluateScope } from '@/lib/knowledge/applicability/scope';
import { evaluateTrigger } from '@/lib/knowledge/applicability/trigger';
import type { TriggerClause, TriggerCondition, TriggerDecision } from '@/lib/knowledge/applicability/trigger';
import type { QueryFrame } from '@/lib/knowledge/applicability/query-frame';
import { UNKNOWN_QUERY_FACETS, UNKNOWN_TRIGGER_FACTS } from '@/lib/knowledge/applicability/query-frame';
import { resolveKnowledgeSet, type EvaluatedCandidate } from '@/lib/knowledge/applicability/resolution';

export const EVALUATION_REVIEWER_ID = 'EVALUATION_HARNESS_UNREVIEWED';

/** Conservative proof that a source states a necessary condition. Generic
 * "если X, то Y" is intentionally absent: falsifying a sufficient condition
 * does not prove not-Y. */
export function hasSourceBackedNecessaryCondition(
  statement: string,
  triggerEvidenceQuotes: readonly string[]
): boolean {
  const marker = /(?:только|лишь)\s+(?:при|после)(?=$|[\s,.;:])/giu;
  const ambiguousLead = /(?:возможно|вероятно|обычно|как правило|не всегда).{0,48}(?:только|лишь)\s+(?:при|после)/iu;
  return [statement, ...triggerEvidenceQuotes].some((text) => {
    if (ambiguousLead.test(text)) return false;
    for (const match of text.matchAll(marker)) {
      const index = match.index ?? 0;
      const before = text.slice(Math.max(0, index - 48), index);
      const boundary = index === 0 || /[\s,;:]$/u.test(before);
      if (!boundary) continue;
      // Reject explicit negation and short contrastive/hedged leads such as
      // «не только при», «не лишь после», «не всегда только при».
      if (/(?:^|[\s,;:])не(?:\s+[^\s,;:]+){0,2}\s*$/iu.test(before)) continue;
      return true;
    }
    return false;
  });
}

export function buildEvaluationApplicabilityProfile(
  unit: PersistedKnowledgeUnit,
  reviewedAt: string
): ApplicabilityProfile {
  const facets: Record<string, FacetMap[keyof FacetMap]> = {};
  for (const facet of applicableFacetsOf(unit.kind)) {
    facets[facet] = { state: 'GLOBAL', reviewedBy: EVALUATION_REVIEWER_ID, reviewedAt };
  }
  return {
    kind: unit.kind,
    facets: facets as FacetMap,
    audience: 'INTERNAL_ONLY',
    reviewStatus: 'REVIEWED',
    reviewedBy: EVALUATION_REVIEWER_ID,
    reviewedAt,
  };
}

export function buildEvaluationKnowledgeUnitLike(
  unit: PersistedKnowledgeUnit,
  reviewedAt: string
): KnowledgeUnitLike {
  return {
    unitId: unit.unitId,
    status: 'ACTIVE',
    profile: buildEvaluationApplicabilityProfile(unit, reviewedAt),
    validFrom: null,
    validUntil: null,
    sourceRevision: null,
  };
}

export function buildEvaluatedCandidate(
  unit: PersistedKnowledgeUnit,
  query: QueryFrame,
  requestContext: RequestContext,
  reviewedAt: string
): EvaluatedCandidate {
  // `profile` строится ОДИН раз и переиспользуется напрямую для evaluateScope —
  // `KnowledgeUnitLike.profile.audience` типизирован как `ProfileAudience |
  // null` (намеренное расширение для legacy-состояний БД, eligibility.ts),
  // а `evaluateScope` ждёт настоящий `ApplicabilityProfile` с ненулевым
  // audience; здесь он всегда ненулевой (см. buildEvaluationApplicabilityProfile),
  // но обходить это через `knowledgeUnitLike.profile` заставило бы TS
  // требовать сужение вручную на каждом вызове.
  const profile = buildEvaluationApplicabilityProfile(unit, reviewedAt);
  const knowledgeUnitLike: KnowledgeUnitLike = {
    unitId: unit.unitId,
    status: 'ACTIVE',
    profile,
    validFrom: null,
    validUntil: null,
    sourceRevision: null,
  };
  const eligibility = evaluateUnitEligibility(knowledgeUnitLike, requestContext);
  const scope = evaluateScope(profile, query);
  const trigger =
    unit.triggerCondition !== null
      ? evaluateTrigger(unit.triggerCondition, query)
      : null;
  const triggerPresentationConditions = unit.triggerCondition === null
    ? []
    : [unit.evidenceByField.triggerCondition?.quote ?? unit.sourceSpan.quote];

  return {
    unitId: unit.unitId,
    kind: unit.kind,
    eligibility,
    scope,
    trigger,
    triggerPresentationConditions,
    negativeInferenceAllowed: hasSourceBackedNecessaryCondition(unit.statement, triggerPresentationConditions),
    parentRuleRef: unit.parentRuleRef,
    // Без этой строки вето по соседям в resolveKnowledgeSet НИКОГДА не
    // срабатывает на живом прогоне: оно ищет кандидатов с общим
    // sourceBlockAnchor, а здесь — единственном пути из персистентного юнита в
    // кандидата — поле не проставлялось. Тесты резолюции собирают кандидатов
    // вручную и задают якорь, поэтому оставались зелёными при мёртвой защите в
    // проде. Это опаснее отсутствия защиты: в отчёте она есть, в работе её нет.
    sourceBlockAnchor: unit.sourceBlockAnchor,
    // Ничто в extraction/persistence не производит эту связь сегодня — см.
    // repo-wide поиск перед написанием этого файла (Task 13 планирование).
    supersedes: [],
    numericConstraint: unit.numericConstraint,
  };
}

/**
 * Builds candidates as a graph, so an explicitly linked structural fragment
 * cannot outlive the applicability of the rule it completes.
 *
 * `parentRuleRef` has two meanings in the persisted model.  On an
 * EXCEPTION_RULE it identifies the rule being overridden, so the exception
 * deliberately uses only its own mandatory trigger.  On every other kind it
 * identifies a structural parent: the child's effective trigger is the
 * conjunction of its own trigger (if any) and all effective ancestor
 * triggers.  Raw persisted conditions are never rewritten.
 *
 * Invalid graphs and contradictory conjunctions become UNKNOWN rather than
 * INACTIVE.  That is intentionally fail-closed: resolution holds the
 * candidate instead of silently excluding it and answering from incomplete
 * knowledge.  The trusted-artifact boundary should eventually reject these
 * shapes earlier; this runtime guard also protects legacy/manual snapshots.
 */
export function buildEvaluatedCandidates(
  units: readonly PersistedKnowledgeUnit[],
  fullUnitsById: ReadonlyMap<string, PersistedKnowledgeUnit>,
  query: QueryFrame,
  requestContext: RequestContext,
  reviewedAt: string
): EvaluatedCandidate[] {
  type EffectiveCondition =
    | { readonly state: 'VALID'; readonly condition: TriggerCondition | null; readonly quotes: readonly string[] }
    | { readonly state: 'INVALID' };

  const memo = new Map<string, EffectiveCondition>();
  const visiting = new Set<string>();

  const combine = (
    inherited: EffectiveCondition & { readonly state: 'VALID' },
    own: TriggerCondition | null,
    ownQuote: string | null
  ): EffectiveCondition => {
    const clauses: TriggerClause[] = [];
    const byFact = new Map<TriggerClause['fact'], TriggerClause['equals']>();
    for (const clause of [...(inherited.condition?.all ?? []), ...(own?.all ?? [])]) {
      const previous = byFact.get(clause.fact);
      if (previous !== undefined && previous !== clause.equals) return { state: 'INVALID' };
      if (previous === undefined) {
        byFact.set(clause.fact, clause.equals);
        clauses.push(clause);
      }
    }
    return {
      state: 'VALID',
      condition: clauses.length > 0 ? { all: clauses } : null,
      quotes: [...new Set([...inherited.quotes, ...(ownQuote === null ? [] : [ownQuote])])],
    };
  };

  const effectiveConditionOf = (unit: PersistedKnowledgeUnit): EffectiveCondition => {
    const cached = memo.get(unit.unitId);
    if (cached !== undefined) return cached;
    if (unit.kind === 'EXCEPTION_RULE' || unit.parentRuleRef === null) {
      const own = {
        state: 'VALID',
        condition: unit.triggerCondition,
        quotes: unit.triggerCondition === null
          ? []
          : [unit.evidenceByField.triggerCondition?.quote ?? unit.sourceSpan.quote],
      } as const;
      memo.set(unit.unitId, own);
      return own;
    }
    if (visiting.has(unit.unitId)) return { state: 'INVALID' };
    visiting.add(unit.unitId);
    const parent = fullUnitsById.get(unit.parentRuleRef);
    const inherited = parent === undefined ? { state: 'INVALID' } as const : effectiveConditionOf(parent);
    const result = inherited.state === 'INVALID'
      ? inherited
      : combine(
          inherited,
          unit.triggerCondition,
          unit.triggerCondition === null
            ? null
            : (unit.evidenceByField.triggerCondition?.quote ?? unit.sourceSpan.quote)
        );
    visiting.delete(unit.unitId);
    memo.set(unit.unitId, result);
    return result;
  };

  const invalidTrigger = (): TriggerDecision => ({
    verdict: 'UNKNOWN',
    clauseVerdicts: [],
    satisfiedFacts: [],
    violatedFacts: [],
    missingFacts: [],
    requiresClarification: false,
    reasons: [],
  });

  return units.map((unit) => {
    const base = buildEvaluatedCandidate(unit, query, requestContext, reviewedAt);
    const effective = effectiveConditionOf(unit);
    return {
      ...base,
      trigger: effective.state === 'INVALID'
        ? invalidTrigger()
        : effective.condition === null
          ? null
          : evaluateTrigger(effective.condition, query),
      triggerPresentationConditions: effective.state === 'INVALID' ? [] : effective.quotes,
      triggerInvalid: effective.state === 'INVALID',
      negativeInferenceAllowed: effective.state !== 'INVALID' &&
        hasSourceBackedNecessaryCondition(unit.statement, effective.quotes),
    };
  });
}

/** Observable policy probe for resumable question-journal fingerprints. */
export function effectiveTriggerInheritanceBehaviorProbe(): unknown {
  const makeUnit = (
    unitId: string,
    overrides: Partial<PersistedKnowledgeUnit> = {}
  ): PersistedKnowledgeUnit => ({
    unitId,
    contentHash: `probe-${unitId}`,
    sourceBlockAnchor: 'probe-block',
    kind: 'PROCEDURE_STEP',
    statement: `probe ${unitId}`,
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    parentRuleRef: null,
    sourceSpan: { anchor: 'probe-block', quote: `probe ${unitId}` },
    evidenceByField: { statement: { anchor: 'probe-block', quote: `probe ${unitId}` } },
    uncertainties: [],
    ...overrides,
  });
  const parent = makeUnit('parent', {
    triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] },
  });
  const child = makeUnit('child', { parentRuleRef: 'parent' });
  const exception = makeUnit('exception', {
    kind: 'EXCEPTION_RULE',
    parentRuleRef: 'parent',
    triggerCondition: { all: [{ fact: 'helperPresent', equals: true }] },
  });
  const full = new Map([parent, child, exception].map((unit) => [unit.unitId, unit]));
  const reviewedAt = '2000-01-01T00:00:00.000Z';
  const requestContext: RequestContext = { audience: 'internal', now: reviewedAt };
  const query = (privacy: 'PUBLIC' | 'PRIVATE' | null, helper: boolean | null): QueryFrame => ({
    concepts: [],
    facets: UNKNOWN_QUERY_FACETS,
    triggerFacts: {
      ...UNKNOWN_TRIGGER_FACTS,
      ...(privacy === null ? {} : {
        privacyContext: { state: 'KNOWN' as const, value: privacy, evidence: [{ source: 'DETERMINISTIC' as const, quote: privacy }] },
      }),
      ...(helper === null ? {} : {
        helperPresent: { state: 'KNOWN' as const, value: helper, evidence: [{ source: 'DETERMINISTIC' as const, quote: String(helper) }] },
      }),
    },
    questionAspects: [],
    ambiguities: [],
  });
  const behavior = (frame: QueryFrame) => {
    const evaluated = buildEvaluatedCandidates([child, exception], full, frame, requestContext, reviewedAt);
    const resolution = resolveKnowledgeSet(evaluated, frame);
    return {
      verdicts: evaluated.map((candidate) => [candidate.unitId, candidate.trigger?.verdict ?? null]),
      disposition: resolution.disposition,
      selectedApplicability: resolution.selectedApplicability,
      reasons: resolution.reasons,
      negativeEvidence: resolution.negativeEvidence,
      necessaryConditionPolicy: {
        necessary: hasSourceBackedNecessaryCondition('Allowed only with approval.', ['только при согласии']),
        sufficient: hasSourceBackedNecessaryCondition('Allowed if approval exists.', ['если есть согласие']),
        negated: hasSourceBackedNecessaryCondition('Это верно не только при согласии.', []),
        contrastive: hasSourceBackedNecessaryCondition('Не лишь после проверки, но и заранее.', []),
        ambiguous: hasSourceBackedNecessaryCondition('Возможно, только при согласии.', []),
      },
    };
  };
  return {
    public: behavior(query('PUBLIC', true)),
    private: behavior(query('PRIVATE', true)),
    unknown: behavior(query(null, true)),
  };
}
