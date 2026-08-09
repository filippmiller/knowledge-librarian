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
 * Cross-batch `parentExtractionRef` is impossible BY CONSTRUCTION, not by
 * a rule this module enforces: the model only ever sees one batch's blocks
 * per call, so it cannot reference a unit it never saw. Real fragment
 * relationships (numeric sub-clauses, exception-to-parent) survive as long
 * as the fragments' source text lives within one batch — true for every
 * case observed on the real training document (each fragmented rule's
 * units all share one canonical block). Batching by several ADJACENT
 * blocks, not strictly one block at a time, gives headroom for documents
 * where related content spans more than one block.
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
  const allUnits: ExtractedKnowledgeUnit[] = [];
  const batchLogs: BatchExtractionLog[] = [];

  for (const [batchIndex, batchBlocks] of batches.entries()) {
    const result = await extractor({ ...optionsPerBatch, blocks: batchBlocks });
    const namespaced = result.units.map((u) => namespaceUnit(u, batchIndex));
    allUnits.push(...namespaced);
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
  const units = validateParentRefs(allUnits);

  return { units, batchLogs };
}
