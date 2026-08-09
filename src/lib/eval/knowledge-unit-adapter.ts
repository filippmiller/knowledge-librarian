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
import type { QueryFrame } from '@/lib/knowledge/applicability/query-frame';
import type { EvaluatedCandidate } from '@/lib/knowledge/applicability/resolution';

export const EVALUATION_REVIEWER_ID = 'EVALUATION_HARNESS_UNREVIEWED';

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
    unit.kind === 'EXCEPTION_RULE' && unit.triggerCondition !== null
      ? evaluateTrigger(unit.triggerCondition, query)
      : null;

  return {
    unitId: unit.unitId,
    kind: unit.kind,
    eligibility,
    scope,
    trigger,
    parentRuleRef: unit.parentRuleRef,
    // Ничто в extraction/persistence не производит эту связь сегодня — см.
    // repo-wide поиск перед написанием этого файла (Task 13 планирование).
    supersedes: [],
    numericConstraint: unit.numericConstraint,
  };
}
