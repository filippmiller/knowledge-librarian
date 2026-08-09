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
  type AuditBlockCoverageOptions,
  type BlockCoverageAuditResult,
  type CoverageFinding,
} from './extraction-coverage-auditor';
import { validateParentRefs } from './applicability/extraction-parent-refs';
import type { ExtractedKnowledgeUnit } from './applicability/extraction';
import type { ExtractionRunConfig } from '@/lib/ai/extraction-run';

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
    auditResults.push(audit);

    if (!audit.hasGap) continue;

    const retryResult: ExtractKnowledgeUnitsResult = await extractor({ ...optionsPerBatch, blocks: [block] });
    const namespaced = retryResult.units.map((u) => ({
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
  }

  const units = validateParentRefs([...initialUnits, ...additionalUnits]);

  return { units, batchLogs, auditResults, focusedRetryLogs };
}
