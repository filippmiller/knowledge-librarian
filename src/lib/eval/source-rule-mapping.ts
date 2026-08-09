/**
 * unit -> номер исходного правила, БЕЗ committed review manifest (Task 15,
 * goal-shift benchmark). `review-manifest.ts`'s `sourceRuleByUnitId` requires
 * a human-authored manifest that doesn't exist for the evaluation-only path
 * (no human review happens here by design). Matching is by DOCX text
 * containment — `unit.sourceSpan.quote` is a literal substring of exactly
 * one `SourceRule.text` — the same evidence-grounded principle
 * `resolveEvidenceOffsets` (`applicability/identity.ts`) already uses.
 * Never derived from the oracle.
 */

import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';
import type { SourceRule } from './source-rule-segmentation';

export function resolveSourceRuleId(
  unit: PersistedKnowledgeUnit,
  sourceRules: readonly SourceRule[]
): number | null {
  const matches = sourceRules.filter((rule) => rule.text.includes(unit.sourceSpan.quote));
  return matches.length === 1 ? matches[0].sourceRuleId : null;
}
