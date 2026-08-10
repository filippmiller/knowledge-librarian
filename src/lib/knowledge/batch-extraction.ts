/**
 * Bounded-batch extraction (goal-shift continuation, 2026-08-09). A single
 * whole-document `extractKnowledgeUnits()` call silently omitted rules
 * 5-10 on a real run — 28 units/10 rules vs. 18 units/4 rules, from the
 * SAME schema, no retry trigger, because nothing failed validation; the
 * model just ran out of steam partway through one long generation. Bounding
 * each call's responsibility to a small group of adjacent blocks makes
 * that failure mode structurally harder to hit, at the cost of more calls.
 *
 * Generalizes to any document — no assumption about numbered rules,
 * fixed rule count, or this fixture's structure anywhere in this module.
 *
 * A model cannot emit a `parentExtractionRef` to a unit from a previous
 * response. After namespacing, this module therefore restores only a narrow,
 * deterministic class of cross-boundary relationships: an orphan exception
 * or numeric qualification may link to the immediately preceding batch when
 * there is exactly one structurally compatible base unit. Ambiguous cases
 * remain unlinked; there are no pairwise LLM calls or semantic guesses.
 */

import {
  extractKnowledgeUnits,
  type ExtractKnowledgeUnitsOptions,
  type ExtractKnowledgeUnitsResult,
  type SourceBlock,
} from './knowledge-unit-extractor';
import { validateParentRefs } from './applicability/extraction-parent-refs';
import type { ExtractedKnowledgeUnit } from './applicability/extraction';

export function batchSourceBlocks(
  blocks: readonly SourceBlock[],
  batchSize: number
): readonly (readonly SourceBlock[])[] {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`batchSourceBlocks: batchSize обязан быть целым >= 1, получено ${batchSize}`);
  }
  const batches: SourceBlock[][] = [];
  for (let i = 0; i < blocks.length; i += batchSize) {
    batches.push(blocks.slice(i, i + batchSize) as SourceBlock[]);
  }
  return batches;
}

function namespaceUnit(unit: ExtractedKnowledgeUnit, batchIndex: number): ExtractedKnowledgeUnit {
  const prefix = `b${batchIndex}-`;
  return {
    ...unit,
    extractionRef: `${prefix}${unit.extractionRef}`,
    parentExtractionRef: unit.parentExtractionRef === null ? null : `${prefix}${unit.parentExtractionRef}`,
  };
}

function facetsAreCompatible(
  left: ExtractedKnowledgeUnit['facets'],
  right: ExtractedKnowledgeUnit['facets']
): boolean {
  for (const key of Object.keys(left) as (keyof ExtractedKnowledgeUnit['facets'])[]) {
    if (key in right && left[key] !== right[key]) return false;
  }
  return true;
}

function isOrphanQualification(unit: ExtractedKnowledgeUnit): boolean {
  return (
    unit.parentExtractionRef === null &&
    (unit.kind === 'EXCEPTION_RULE' || unit.numericConstraint !== null)
  );
}

function isCompatibleBase(
  child: ExtractedKnowledgeUnit,
  candidate: ExtractedKnowledgeUnit
): boolean {
  if (!facetsAreCompatible(child.facets, candidate.facets)) return false;

  if (child.kind === 'EXCEPTION_RULE') {
    return candidate.kind === 'PROCEDURE_STEP';
  }

  return (
    child.numericConstraint !== null &&
    candidate.kind === child.kind &&
    candidate.numericConstraint === null
  );
}

const EXPLICIT_PREVIOUS_RULE_REFERENCE =
  /(?:к|для)\s+(?:предыдущ(?:ему|его)|предшествующ(?:ему|его)|указанн(?:ому|ого)\s+выше)\s+(?:правил(?:у|а)|пункт(?:у|а)|абзац(?:у|а)|требовани(?:ю|я)|шаг(?:у|а))|(?:previous|preceding|above)\s+(?:rule|clause|paragraph|requirement|step)/iu;

function hasStructuralBoundaryEvidence(
  child: ExtractedKnowledgeUnit,
  candidate: ExtractedKnowledgeUnit,
  previousBatch: readonly SourceBlock[],
  currentBatch: readonly SourceBlock[]
): boolean {
  const previousBoundary = previousBatch.at(-1);
  const currentBoundary = currentBatch[0];
  if (
    previousBoundary === undefined ||
    currentBoundary === undefined ||
    candidate.sourceSpan.anchor !== previousBoundary.anchor ||
    child.sourceSpan.anchor !== currentBoundary.anchor
  ) {
    return false;
  }

  // SourceBlock currently carries no section/outline metadata. In its
  // absence, only an explicit textual reference to the preceding structural
  // item is evidence enough. Mere adjacency (even with one candidate) is not.
  return EXPLICIT_PREVIOUS_RULE_REFERENCE.test(currentBoundary.text);
}

/**
 * Reconnect relationships that a batch boundary made impossible for the
 * extractor to express. The immediately previous batch is the full search
 * window, both units must sit on the batch boundary, the source must
 * explicitly refer to the preceding structural item, and uniqueness is
 * mandatory. Missing or ambiguous evidence fails closed.
 */
function linkAdjacentBatchRelationships(
  unitsByBatch: readonly (readonly ExtractedKnowledgeUnit[])[],
  sourceBatches: readonly (readonly SourceBlock[])[]
): ExtractedKnowledgeUnit[] {
  const linked: ExtractedKnowledgeUnit[] = [];

  for (const [batchIndex, units] of unitsByBatch.entries()) {
    const previous = batchIndex === 0 ? [] : unitsByBatch[batchIndex - 1];
    for (const unit of units) {
      if (!isOrphanQualification(unit)) {
        linked.push(unit);
        continue;
      }

      const candidates = previous.filter(
        (candidate) =>
          isCompatibleBase(unit, candidate) &&
          hasStructuralBoundaryEvidence(
            unit,
            candidate,
            sourceBatches[batchIndex - 1] ?? [],
            sourceBatches[batchIndex] ?? []
          )
      );
      linked.push(
        candidates.length === 1
          ? { ...unit, parentExtractionRef: candidates[0].extractionRef }
          : unit
      );
    }
  }

  return linked;
}

export interface BatchExtractionLog {
  readonly batchIndex: number;
  readonly blockAnchors: readonly string[];
  readonly unitCount: number;
}

export interface BatchExtractionResult {
  readonly units: ExtractedKnowledgeUnit[];
  readonly batchLogs: readonly BatchExtractionLog[];
}

/** Injected, same principle as `AnswerGenerator` (synthesize.ts) — the
 *  merge/namespacing logic is fully testable without a network call; real
 *  callers default to the real `extractKnowledgeUnits`. */
export type BatchExtractor = (
  options: ExtractKnowledgeUnitsOptions
) => Promise<ExtractKnowledgeUnitsResult>;

export async function extractKnowledgeUnitsInBatches(
  blocks: readonly SourceBlock[],
  batchSize: number,
  optionsPerBatch: Omit<ExtractKnowledgeUnitsOptions, 'blocks'>,
  extractor: BatchExtractor = extractKnowledgeUnits
): Promise<BatchExtractionResult> {
  const batches = batchSourceBlocks(blocks, batchSize);
  const unitsByBatch: ExtractedKnowledgeUnit[][] = [];
  const batchLogs: BatchExtractionLog[] = [];

  for (const [batchIndex, batchBlocks] of batches.entries()) {
    const result = await extractor({ ...optionsPerBatch, blocks: batchBlocks });
    const namespaced = result.units.map((u) => namespaceUnit(u, batchIndex));
    unitsByBatch.push(namespaced);
    batchLogs.push({
      batchIndex,
      blockAnchors: batchBlocks.map((b) => b.anchor),
      unitCount: namespaced.length,
    });
  }

  // Re-validated as a whole set, not just trusted from per-batch validation
  // inside extractKnowledgeUnits — same "don't trust silently" discipline
  // as the rest of this codebase (extraction-drift.ts's duplicate-safety,
  // etc.). Namespacing already makes every extractionRef globally unique
  // and every parentExtractionRef batch-local, so this is defense in depth,
  // not expected to find anything new.
  const units = validateParentRefs(linkAdjacentBatchRelationships(unitsByBatch, batches));

  return { units, batchLogs };
}
