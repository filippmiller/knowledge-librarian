/**
 * Composes bounded-batch extraction (batch-extraction.ts) with the
 * oracle-blind completeness auditor (extraction-coverage-auditor.ts):
 * every source block gets audited after the batch pass, and a confirmed
 * gap triggers exactly ONE bounded, focused re-extraction of just that
 * block — never a loop, never "retry until the benchmark score improves"
 * (explicitly out of scope by design, not merely by convention).
 *
 * Focused-retry units are namespaced into their own isolated identity
 * space (`focused-{anchor}-...`) with `parentExtractionRef` forced to
 * `null`: they were extracted without seeing the original batch pass's
 * units, so any parent reference they invent could only coincidentally
 * match a real id, never legitimately. Making that failure mode
 * IMPOSSIBLE (not merely unlikely) matches the rest of this module's
 * discipline (batch-extraction.ts's cross-batch namespacing does the same).
 */

import {
  extractKnowledgeUnits,
  type ExtractKnowledgeUnitsOptions,
  type ExtractKnowledgeUnitsResult,
  type SourceBlock,
} from './knowledge-unit-extractor';
import {
  extractKnowledgeUnitsInBatches,
  type BatchExtractionLog,
  type BatchExtractor,
} from './batch-extraction';
import {
  auditBlockCoverage,
  coverageAuditNeedsReview,
  type AuditBlockCoverageOptions,
  type BlockCoverageAuditResult,
  type CoverageFinding,
} from './extraction-coverage-auditor';
import { validateParentRefs } from './applicability/extraction-parent-refs';
import type { ExtractedKnowledgeUnit } from './applicability/extraction';
import type { ExtractionRunConfig } from '@/lib/ai/extraction-run';
import { quoteSpansOverlap } from './quote-locator';

export interface FocusedRetryLog {
  readonly blockAnchor: string;
  readonly triggeredBy: readonly CoverageFinding[];
  readonly additionalUnitCount: number;
}

export interface AuditedExtractionResult {
  readonly units: ExtractedKnowledgeUnit[];
  readonly batchLogs: readonly BatchExtractionLog[];
  readonly auditResults: readonly BlockCoverageAuditResult[];
  readonly focusedRetryLogs: readonly FocusedRetryLog[];
}

type CoverageAuditor = (options: AuditBlockCoverageOptions) => Promise<BlockCoverageAuditResult>;

export interface AuditedExtractionDeps {
  readonly extractor?: BatchExtractor;
  readonly auditor?: CoverageAuditor;
}

/** Stable, deterministic identity component for semantic deduplication.
 *  Evidence overlap alone is never enough: one broad source span may support
 *  several distinct rules, including a clause recovered only by repair. */
function normalizeSemanticStatement(statement: string): string {
  return statement.normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ').trim();
}

/** Public pure policy boundary so artifact fingerprints can probe the exact
 * focused-repair dedup rule rather than one lower-level ingredient of it. */
export function focusedRepairDuplicatesExistingUnit(
  blockText: string,
  candidate: ExtractedKnowledgeUnit,
  existingUnits: readonly ExtractedKnowledgeUnit[]
): boolean {
  const candidateStatement = normalizeSemanticStatement(candidate.statement);
  return existingUnits.some(
    (existing) =>
      normalizeSemanticStatement(existing.statement) === candidateStatement &&
      quoteSpansOverlap(blockText, candidate.sourceSpan.quote, existing.sourceSpan.quote)
  );
}

export async function extractKnowledgeUnitsWithCompletenessAudit(
  blocks: readonly SourceBlock[],
  batchSize: number,
  optionsPerBatch: Omit<ExtractKnowledgeUnitsOptions, 'blocks'>,
  auditRunConfig: ExtractionRunConfig,
  deps: AuditedExtractionDeps = {}
): Promise<AuditedExtractionResult> {
  const extractor = deps.extractor ?? extractKnowledgeUnits;
  const auditor = deps.auditor ?? auditBlockCoverage;

  const { units: initialUnits, batchLogs } = await extractKnowledgeUnitsInBatches(
    blocks,
    batchSize,
    optionsPerBatch,
    extractor
  );

  const unitsByBlockAnchor = new Map<string, ExtractedKnowledgeUnit[]>();
  for (const u of initialUnits) {
    const list = unitsByBlockAnchor.get(u.sourceSpan.anchor) ?? [];
    list.push(u);
    unitsByBlockAnchor.set(u.sourceSpan.anchor, list);
  }

  const auditResults: BlockCoverageAuditResult[] = [];
  const focusedRetryLogs: FocusedRetryLog[] = [];
  const additionalUnits: ExtractedKnowledgeUnit[] = [];

  for (const block of blocks) {
    const unitsForBlock = unitsByBlockAnchor.get(block.anchor) ?? [];
    const audit = await auditor({
      blockAnchor: block.anchor,
      blockText: block.text,
      extractedStatements: unitsForBlock.map((u) => ({ statement: u.statement, quote: u.sourceSpan.quote })),
      runConfig: auditRunConfig,
    });
    if (!coverageAuditNeedsReview(audit)) {
      auditResults.push(audit);
      continue;
    }

    if (!audit.hasGap) {
      throw new Error(`Coverage audit did not clear block ${block.anchor}: explicit COVERED verdict required`);
    }

    const retryResult: ExtractKnowledgeUnitsResult = await extractor({ ...optionsPerBatch, blocks: [block] });
    // The retry re-extracts the WHOLE block from scratch without seeing the
    // original batch pass's units — a confirmed gap (even a minor one, like
    // one missing adjective) makes it re-derive content the original pass
    // ALREADY covered, not just the genuinely missing part. Real observed
    // effect (goal-shift continuation, 2026-08-09, full-smoke6 benchmark run):
    // one source rule ended up with 5 near-duplicate root-level units instead
    // of the 1-2 a human curator would produce, purely from this. Drop a
    // retry unit only when BOTH its normalized semantic statement matches
    // and its evidence overlaps. Overlap by itself is not duplication: one
    // broad quote can contain multiple independent clauses.
    const coveredUnits = [...unitsForBlock];
    const keptUnits: ExtractedKnowledgeUnit[] = [];
    for (const candidate of retryResult.units) {
      if (focusedRepairDuplicatesExistingUnit(block.text, candidate, coveredUnits)) continue;
      coveredUnits.push(candidate);
      keptUnits.push(candidate);
    }

    const namespaced = keptUnits.map((u) => ({
      ...u,
      extractionRef: `focused-${block.anchor}-${u.extractionRef}`,
      parentExtractionRef: null,
    }));
    additionalUnits.push(...namespaced);
    focusedRetryLogs.push({
      blockAnchor: block.anchor,
      triggeredBy: audit.findings.filter(
        (f) => f.verdict === 'POSSIBLE_OMISSION' || f.verdict === 'UNREPRESENTED_CLAUSE'
      ),
      additionalUnitCount: namespaced.length,
    });

    const finalAudit = await auditor({
      blockAnchor: block.anchor,
      blockText: block.text,
      extractedStatements: [...unitsForBlock, ...namespaced].map((u) => ({
        statement: u.statement,
        quote: u.sourceSpan.quote,
      })),
      runConfig: auditRunConfig,
    });
    if (coverageAuditNeedsReview(finalAudit)) {
      throw new Error(`Focused repair did not clear block ${block.anchor}: final explicit COVERED verdict required`);
    }
    auditResults.push(finalAudit);
  }

  const units = validateParentRefs([...initialUnits, ...additionalUnits]);

  return { units, batchLogs, auditResults, focusedRetryLogs };
}
