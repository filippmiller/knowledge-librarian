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
  type BatchExtractionCheckpoint,
} from './batch-extraction';
import {
  auditBlockCoverage,
  coverageAuditNeedsReview,
  type AuditBlockCoverageOptions,
  type BlockCoverageAuditResult,
  type CoverageFinding,
} from './extraction-coverage-auditor';
import { validateParentRefs } from './applicability/extraction-parent-refs';
import { extractedKnowledgeUnitSchema, type ExtractedKnowledgeUnit } from './applicability/extraction';
import type { ExtractionRunConfig } from '@/lib/ai/extraction-run';
import type { ChatMessage } from '@/lib/ai/chat-provider';
import { structured } from '@/lib/ai/structured-output';
import { quoteSpansOverlap } from './quote-locator';
import { z } from 'zod';

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
type FocusedRepairExtractor = (options: FocusedRepairOptions) => Promise<ExtractKnowledgeUnitsResult>;

export interface FocusedRepairOptions extends Omit<ExtractKnowledgeUnitsOptions, 'blocks'> {
  readonly block: SourceBlock;
  readonly findings: readonly CoverageFinding[];
  readonly existingUnits: readonly ExtractedKnowledgeUnit[];
}

export interface AuditedExtractionDeps {
  readonly extractor?: BatchExtractor;
  readonly repairExtractor?: FocusedRepairExtractor;
  readonly auditor?: CoverageAuditor;
  readonly initialExtractionCheckpoint?: BatchExtractionCheckpoint;
  readonly paidStageCheckpoint?: AuditedExtractionCheckpoint;
}

export type CoverageAuditStage = 'INITIAL_AUDIT' | 'FINAL_AUDIT';

export interface AuditedExtractionCheckpoint {
  loadAudit(stage: CoverageAuditStage, options: AuditBlockCoverageOptions): BlockCoverageAuditResult | undefined;
  saveAudit(stage: CoverageAuditStage, options: AuditBlockCoverageOptions, result: BlockCoverageAuditResult): void;
  loadRepair(options: FocusedRepairOptions): readonly ExtractedKnowledgeUnit[] | undefined;
  saveRepair(options: FocusedRepairOptions, units: readonly ExtractedKnowledgeUnit[]): void;
}

const focusedRepairResponseSchema = z.strictObject({
  units: z.array(extractedKnowledgeUnitSchema).readonly(),
});

const FOCUSED_REPAIR_SYSTEM_PROMPT = `Ты исправляешь КОНКРЕТНЫЕ пропуски в уже выполненном извлечении единиц знания из одного блока.

Верни ТОЛЬКО новые units, необходимые для findings. Не повторяй уже извлечённые утверждения и не пересматривай весь блок.
kind — СТРОГО одно из: "PROCEDURE_STEP", "EXCEPTION_RULE", "TERM_DEFINITION", "DELIVERY_RULE", "PRICE_RULE". Значения "fact", "disclaimer", "rule", "note" и любые другие ЗАПРЕЩЕНЫ. Если текст является оговоркой или фактом, выбери ближайший допустимый kind по функции знания; не изобретай новый enum.

Каждый unit обязан иметь ТОЧНО эту объектную форму (без дополнительных ключей):
{"kind":"PROCEDURE_STEP","statement":"...","facets":{},"triggerCondition":null,"numericConstraint":null,"extractionRef":"r1","parentExtractionRef":null,"sourceSpan":{"anchor":"ДАННЫЙ_ANCHOR","quote":"ДОСЛОВНАЯ ЦИТАТА"},"evidenceByField":{"statement":{"anchor":"ДАННЫЙ_ANCHOR","quote":"ДОСЛОВНАЯ ЦИТАТА"}},"uncertainties":[]}

sourceSpan — именно объект {"anchor":"...","quote":"..."}, НЕ строка. sourceSpan.anchor и каждый evidenceByField.*.anchor должны ТОЧНО совпадать с данным anchor. Все quote должны быть непустыми дословными фрагментами исходного блока. evidenceByField.statement обязателен; evidence для каждого заполненного facets/triggerCondition/numericConstraint также обязательно.
parentExtractionRef всегда null: repair возвращает только независимые новые units. extractionRef каждого unit уникален в этом ответе.
uncertainties — всегда массив объектов ТОЧНО формы {"kind":"OTHER","description":"...","quote":"дословная цитата"}. uncertainty.kind — СТРОГО одно из: "UNRECOGNIZED_TRIGGER_CONDITION", "UNRECOGNIZED_NUMERIC_CONSTRAINT", "AMBIGUOUS_FACET", "DANGLING_PARENT_REF", "DUPLICATE_EXTRACTION_REF", "OTHER". Строки вместо объектов запрещены.
Не изобретай значения. Если finding нельзя уверенно структурировать, сохрани правило с явной uncertainty.

Ответ СТРОГО JSON: {"units": [...]}`;

/** Compact, finding-scoped prompt. Deliberately excludes the full-document
 * extraction catalog: schema validation remains identical, while the model
 * is asked only to fill omissions named by the auditor. */
export function buildFocusedRepairPromptMessages(options: Pick<FocusedRepairOptions, 'block' | 'findings' | 'existingUnits'>): ChatMessage[] {
  const existing = options.existingUnits.map((u) => ({ statement: u.statement, quote: u.sourceSpan.quote }));
  const findings = options.findings.map(({ verdict, quote, explanation }) => ({ verdict, quote, explanation }));
  return [
    { role: 'system', content: FOCUSED_REPAIR_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Anchor: ${options.block.anchor}\n\nИсходный блок:\n${options.block.text}\n\nУже извлечено:\n${JSON.stringify(existing)}\n\nИсправь только эти findings:\n${JSON.stringify(findings)}`,
    },
  ];
}

export async function extractFocusedRepairUnits(options: FocusedRepairOptions): Promise<ExtractKnowledgeUnitsResult> {
  const structuredResult = await structured<{ units: readonly ExtractedKnowledgeUnit[] }>({
    schema: focusedRepairResponseSchema,
    messages: buildFocusedRepairPromptMessages(options),
    runConfig: options.runConfig,
    maxTokens: Math.min(options.maxTokens ?? 4_000, 4_000),
    ...(options.temperature !== undefined && { temperature: options.temperature }),
    ...(options.signal && { signal: options.signal }),
  });
  return { units: validateParentRefs(structuredResult.data.units), structuredResult };
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
  // Never fall back to the batch extractor here: real runners inject a
  // retrying/instrumented batch extractor, and doing so would silently bring
  // the full-document system prompt back for a one-finding repair.
  const repairExtractor = deps.repairExtractor ?? extractFocusedRepairUnits;
  const auditor = deps.auditor ?? auditBlockCoverage;

  const { units: initialUnits, batchLogs } = await extractKnowledgeUnitsInBatches(
    blocks,
    batchSize,
    optionsPerBatch,
    extractor,
    deps.initialExtractionCheckpoint
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
    const initialAuditOptions: AuditBlockCoverageOptions = {
      blockAnchor: block.anchor,
      blockText: block.text,
      ...(block.kind !== undefined && { blockKind: block.kind }),
      extractedStatements: unitsForBlock.map((u) => ({ statement: u.statement, quote: u.sourceSpan.quote })),
      runConfig: auditRunConfig,
    };
    const restoredInitialAudit = deps.paidStageCheckpoint?.loadAudit('INITIAL_AUDIT', initialAuditOptions);
    const audit = restoredInitialAudit ?? await auditor(initialAuditOptions);
    if (restoredInitialAudit === undefined) deps.paidStageCheckpoint?.saveAudit('INITIAL_AUDIT', initialAuditOptions, audit);
    if (!coverageAuditNeedsReview(audit)) {
      auditResults.push(audit);
      continue;
    }

    if (!audit.hasGap) {
      throw new Error(`Coverage audit did not clear block ${block.anchor}: explicit COVERED verdict required`);
    }

    const repairOptions: FocusedRepairOptions = {
      ...optionsPerBatch,
      block,
      findings: audit.findings.filter(
        (finding) => finding.verdict === 'POSSIBLE_OMISSION' || finding.verdict === 'UNREPRESENTED_CLAUSE'
      ),
      existingUnits: unitsForBlock,
    };
    const restoredRepair = deps.paidStageCheckpoint?.loadRepair(repairOptions);
    const retryResult = restoredRepair === undefined
      ? await repairExtractor(repairOptions)
      : { units: [...restoredRepair], structuredResult: {} as never };
    if (restoredRepair === undefined) deps.paidStageCheckpoint?.saveRepair(repairOptions, retryResult.units);
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

    const finalAuditOptions: AuditBlockCoverageOptions = {
      blockAnchor: block.anchor,
      blockText: block.text,
      ...(block.kind !== undefined && { blockKind: block.kind }),
      extractedStatements: [...unitsForBlock, ...namespaced].map((u) => ({
        statement: u.statement,
        quote: u.sourceSpan.quote,
      })),
      runConfig: auditRunConfig,
    };
    const restoredFinalAudit = deps.paidStageCheckpoint?.loadAudit('FINAL_AUDIT', finalAuditOptions);
    const finalAudit = restoredFinalAudit ?? await auditor(finalAuditOptions);
    if (restoredFinalAudit === undefined) deps.paidStageCheckpoint?.saveAudit('FINAL_AUDIT', finalAuditOptions, finalAudit);
    if (coverageAuditNeedsReview(finalAudit)) {
      throw new Error(`Focused repair did not clear block ${block.anchor}: final explicit COVERED verdict required`);
    }
    auditResults.push(finalAudit);
  }

  const units = validateParentRefs([...initialUnits, ...additionalUnits]);

  return { units, batchLogs, auditResults, focusedRetryLogs };
}
