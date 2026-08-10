/**
 * Crash-safe journal for the paid, initial (pre-audit) extraction stage.
 *
 * This is deliberately NOT an extraction artifact.  Its contents are raw
 * model output which may still be incomplete; the only promise it makes is
 * that each stored batch passed the strict extraction schema for the exact
 * request/configuration fingerprint below.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

import type { CallTraceEntry } from '@/lib/ai/call-trace-log';
import { batchSourceBlocks, type BatchExtractionCheckpoint } from '@/lib/knowledge/batch-extraction';
import {
  extractedKnowledgeUnitSchema,
  type ExtractedKnowledgeUnit,
} from '@/lib/knowledge/applicability/extraction';
import {
  buildExtractionPromptMessages,
  type SourceBlock,
} from '@/lib/knowledge/knowledge-unit-extractor';
import { validateParentRefs } from '@/lib/knowledge/applicability/extraction-parent-refs';
import {
  buildFocusedRepairPromptMessages,
  type AuditedExtractionCheckpoint,
  type CoverageAuditStage,
  type FocusedRepairOptions,
} from '@/lib/knowledge/audited-extraction';
import {
  buildCoverageAuditPromptMessages,
  coverageAuditResponseSchema,
  interpretCoverageAuditResponse,
  type AuditBlockCoverageOptions,
  type BlockCoverageAuditResult,
} from '@/lib/knowledge/extraction-coverage-auditor';

export const RAW_EXTRACTION_CHECKPOINT_VERSION = '2026-08-10-raw-extraction-v1';

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

const batchDescriptorSchema = z.strictObject({
  batchIndex: z.number().int().nonnegative(),
  blockAnchors: z.array(z.string().min(1)).readonly(),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

const fingerprintSchema = z.strictObject({
  sourceRevisionHash: z.string().min(1),
  canonicalTextHash: z.string().min(1),
  parserVersion: z.string().min(1),
  sourceBlocksDigest: z.string().regex(/^[a-f0-9]{64}$/),
  configDigest: z.string().regex(/^[a-f0-9]{64}$/),
  auditContractDigest: z.string().regex(/^[a-f0-9]{64}$/),
  repairContractDigest: z.string().regex(/^[a-f0-9]{64}$/),
  legacyCombinedConfigDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  batchSize: z.number().int().positive(),
  batches: z.array(batchDescriptorSchema).readonly(),
});

export type RawExtractionFingerprint = z.infer<typeof fingerprintSchema>;

export interface RawExtractionFingerprintInput {
  readonly sourceRevisionHash: string;
  readonly canonicalTextHash: string;
  readonly parserVersion: string;
  readonly blocks: readonly SourceBlock[];
  readonly batchSize: number;
  /** JSON-safe values which can affect the response (provider/model/prompt,
   * schema version, token limit, temperature). Functions are forbidden. */
  readonly config: Readonly<Record<string, string | number | boolean | null>>;
  readonly auditContract: Readonly<Record<string, string | number | boolean | null>>;
  readonly repairContract: Readonly<Record<string, string | number | boolean | null>>;
  /** Exact pre-split config object, only for one-time migration of v1 files
   * whose single configDigest mixed extraction, audit and repair settings. */
  readonly legacyCombinedConfig?: Readonly<Record<string, string | number | boolean | null>>;
  readonly provider: string;
  readonly model: string;
}

export function buildRawExtractionFingerprint(
  input: RawExtractionFingerprintInput
): RawExtractionFingerprint {
  const batches = batchSourceBlocks(input.blocks, input.batchSize).map((blocks, batchIndex) => ({
    batchIndex,
    blockAnchors: blocks.map((block) => block.anchor),
    requestDigest: digest(buildExtractionPromptMessages(blocks)),
  }));
  return fingerprintSchema.parse({
    sourceRevisionHash: input.sourceRevisionHash,
    canonicalTextHash: input.canonicalTextHash,
    parserVersion: input.parserVersion,
    sourceBlocksDigest: digest(input.blocks),
    configDigest: digest(input.config),
    auditContractDigest: digest(input.auditContract),
    repairContractDigest: digest(input.repairContract),
    ...(input.legacyCombinedConfig !== undefined && {
      legacyCombinedConfigDigest: digest(input.legacyCombinedConfig),
    }),
    provider: input.provider,
    model: input.model,
    batchSize: input.batchSize,
    batches,
  });
}

const completedBatchSchema = z.strictObject({
  batchIndex: z.number().int().nonnegative(),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  units: z.array(extractedKnowledgeUnitSchema).readonly(),
});

const semanticAuditResultSchema = z.strictObject({
  blockAnchor: z.string().min(1),
  findings: z.array(z.strictObject({
    verdict: z.enum(['COVERED', 'POSSIBLE_OMISSION', 'UNREPRESENTED_CLAUSE', 'AMBIGUOUS']),
    quote: z.string(),
    explanation: z.string(),
    quoteVerified: z.boolean(),
  })).readonly(),
  hasGap: z.boolean(),
  unresolved: z.boolean().optional(),
});

const completedAuditedStageSchema = z.discriminatedUnion('stage', [
  z.strictObject({
    stage: z.enum(['INITIAL_AUDIT', 'FINAL_AUDIT']),
    blockAnchor: z.string().min(1),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
    result: semanticAuditResultSchema,
  }),
  z.strictObject({
    stage: z.literal('FOCUSED_REPAIR'),
    blockAnchor: z.string().min(1),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
    units: z.array(extractedKnowledgeUnitSchema).readonly(),
  }),
  z.strictObject({
    stage: z.literal('TAINT_RESAMPLE_EXTRACTION'),
    blockAnchor: z.string().min(1),
    round: z.number().int().positive(),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
    units: z.array(extractedKnowledgeUnitSchema).readonly(),
  }),
  z.strictObject({
    stage: z.literal('TAINT_RESAMPLE_AUDIT'),
    blockAnchor: z.string().min(1),
    round: z.number().int().positive(),
    requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
    contractDigest: z.string().regex(/^[a-f0-9]{64}$/),
    result: semanticAuditResultSchema,
  }),
]);

const checkpointBodySchema = z.strictObject({
  version: z.literal(RAW_EXTRACTION_CHECKPOINT_VERSION),
  trust: z.literal('RAW_EXTRACTION_ONLY'),
  fingerprint: fingerprintSchema,
  completedBatches: z.array(completedBatchSchema).readonly(),
  // Optional keeps v1 initial-batch checkpoints readable; once rewritten the
  // field is always present and covered by contentDigest.
  completedAuditedStages: z.array(completedAuditedStageSchema).readonly().optional(),
});
const checkpointSchema = checkpointBodySchema.extend({
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
});

const legacyFingerprintSchema = fingerprintSchema.omit({
  auditContractDigest: true,
  repairContractDigest: true,
  legacyCombinedConfigDigest: true,
});
const legacyAuditedStageSchema = z.discriminatedUnion('stage', [
  completedAuditedStageSchema.options[0].omit({ contractDigest: true }),
  completedAuditedStageSchema.options[1].omit({ contractDigest: true }),
]);
const legacyCheckpointBodySchema = z.strictObject({
  version: z.literal(RAW_EXTRACTION_CHECKPOINT_VERSION),
  trust: z.literal('RAW_EXTRACTION_ONLY'),
  fingerprint: legacyFingerprintSchema,
  completedBatches: z.array(completedBatchSchema).readonly(),
  completedAuditedStages: z.array(legacyAuditedStageSchema).readonly().optional(),
});
const legacyCheckpointSchema = legacyCheckpointBodySchema.extend({
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
type CheckpointBody = z.infer<typeof checkpointBodySchema>;
type CompletedBatch = z.infer<typeof completedBatchSchema>;
type CompletedAuditedStage = z.infer<typeof completedAuditedStageSchema>;

export class RawExtractionCheckpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RawExtractionCheckpointError';
  }
}

function atomicWrite(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx' });
    renameSync(temporaryPath, filePath);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function sameFingerprint(left: RawExtractionFingerprint, right: RawExtractionFingerprint): boolean {
  const extractionOnly = ({ auditContractDigest: _audit, repairContractDigest: _repair, legacyCombinedConfigDigest: _legacy, ...rest }: RawExtractionFingerprint) => rest;
  return digest(extractionOnly(left)) === digest(extractionOnly(right));
}

export class RawExtractionCheckpointStore implements BatchExtractionCheckpoint, AuditedExtractionCheckpoint {
  private completed = new Map<number, CompletedBatch>();
  private auditedStages = new Map<string, CompletedAuditedStage>();
  private recoveryTraceEntries: readonly CallTraceEntry[] = [];

  constructor(
    private readonly filePath: string,
    private readonly expected: RawExtractionFingerprint
  ) {
    if (existsSync(filePath)) this.loadExisting();
  }

  private loadExisting(): void {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.filePath, 'utf8'));
    } catch (error) {
      throw new RawExtractionCheckpointError(`Raw extraction checkpoint is unreadable or invalid: ${String(error)}`);
    }
    if (typeof raw !== 'object' || raw === null || !('contentDigest' in raw)) {
      throw new RawExtractionCheckpointError('Raw extraction checkpoint is unreadable or invalid');
    }
    const { contentDigest, ...body } = raw as Record<string, unknown>;
    if (digest(body) !== contentDigest) {
      throw new RawExtractionCheckpointError('Raw extraction checkpoint content digest mismatch');
    }

    const current = checkpointSchema.safeParse(raw);
    if (!current.success) {
      const legacy = legacyCheckpointSchema.safeParse(raw);
      if (!legacy.success) {
        throw new RawExtractionCheckpointError(`Raw extraction checkpoint is unreadable or invalid: ${current.error}`);
      }
      this.loadLegacy(legacy.data);
      this.persist();
      return;
    }
    const parsed = current.data;
    if (!sameFingerprint(parsed.fingerprint, this.expected)) {
      throw new RawExtractionCheckpointError('Raw extraction checkpoint source/config/batch fingerprint mismatch');
    }
    for (const batch of parsed.completedBatches) {
      const descriptor = this.expected.batches[batch.batchIndex];
      if (!descriptor || descriptor.requestDigest !== batch.requestDigest || this.completed.has(batch.batchIndex)) {
        throw new RawExtractionCheckpointError(`Raw extraction checkpoint has an invalid or duplicate batch ${batch.batchIndex}`);
      }
      this.completed.set(batch.batchIndex, batch);
    }
    for (const stage of parsed.completedAuditedStages ?? []) {
      const key = this.stageKey(stage);
      if (this.auditedStages.has(key)) {
        throw new RawExtractionCheckpointError(`Raw extraction checkpoint has duplicate paid stage ${key}`);
      }
      this.auditedStages.set(key, stage);
    }
  }

  private loadLegacy(parsed: z.infer<typeof legacyCheckpointSchema>): void {
    const { auditContractDigest: _audit, repairContractDigest: _repair, legacyCombinedConfigDigest: _legacy, ...expectedCore } = this.expected;
    const { configDigest: _legacyMixedConfig, ...legacySeparableCore } = parsed.fingerprint;
    const { configDigest: _currentExtractionConfig, ...expectedSeparableCore } = expectedCore;
    // The legacy digest irreversibly mixed extraction and audit settings, so
    // an audit-only prompt change necessarily changes it. Validate every
    // separable extraction dependency instead: source/parser, provider/model,
    // batching and each exact extraction request digest. The opaque mixed
    // digest cannot safely invalidate already-paid batches after the split.
    if (digest(legacySeparableCore) !== digest(expectedSeparableCore)) {
      throw new RawExtractionCheckpointError('Legacy raw extraction checkpoint source/config/batch fingerprint mismatch');
    }
    for (const batch of parsed.completedBatches) {
      const descriptor = this.expected.batches[batch.batchIndex];
      if (!descriptor || descriptor.requestDigest !== batch.requestDigest || this.completed.has(batch.batchIndex)) {
        throw new RawExtractionCheckpointError(`Legacy raw extraction checkpoint has invalid batch ${batch.batchIndex}`);
      }
      this.completed.set(batch.batchIndex, batch);
    }
    // Legacy audited stages have no independent policy digest. They cannot be
    // proven compatible after the split and are intentionally discarded.
  }

  loadBatch(batchIndex: number, blocks: readonly SourceBlock[]): readonly ExtractedKnowledgeUnit[] | undefined {
    this.assertRequest(batchIndex, blocks);
    return this.completed.get(batchIndex)?.units;
  }

  saveBatch(batchIndex: number, blocks: readonly SourceBlock[], units: readonly ExtractedKnowledgeUnit[]): void {
    const descriptor = this.assertRequest(batchIndex, blocks);
    const parsedUnits = z.array(extractedKnowledgeUnitSchema).parse(units);
    const existing = this.completed.get(batchIndex);
    const next: CompletedBatch = { batchIndex, requestDigest: descriptor.requestDigest, units: parsedUnits };
    if (existing && digest(existing) !== digest(next)) {
      throw new RawExtractionCheckpointError(`Refusing to replace completed raw extraction batch ${batchIndex}`);
    }
    if (existing) return;
    this.completed.set(batchIndex, next);
    this.persist();
  }

  /** Recover schema-valid SUCCESS responses from a prior write-through trace.
   * Only exact canonical request matches for missing batches are accepted. */
  importTraceEntries(entries: readonly CallTraceEntry[], blocks: readonly SourceBlock[]): number {
    this.recoveryTraceEntries = entries;
    let imported = 0;
    const batches = batchSourceBlocks(blocks, this.expected.batchSize);
    for (const descriptor of this.expected.batches) {
      if (this.completed.has(descriptor.batchIndex)) continue;
      const batchBlocks = batches[descriptor.batchIndex];
      // Earliest exact-match success is authoritative for recovery. A
      // focused repair of a one-block initial batch has byte-identical prompt
      // messages and the legacy trace has no stage/correlation id; repairs
      // happen only after the initial extraction and audit, so taking the
      // latest match would silently import repair output as the initial pass.
      const match = entries.find((entry) =>
        entry.purpose === 'extraction' && entry.outcome === 'SUCCESS' &&
        entry.provider === this.expected.provider && entry.model === this.expected.model &&
        digest(entry.requestMessages) === descriptor.requestDigest && entry.responseText !== null
      );
      if (!match?.responseText) continue;
      try {
        const response = z.strictObject({ units: z.array(extractedKnowledgeUnitSchema) }).parse(JSON.parse(match.responseText));
        this.saveBatch(descriptor.batchIndex, batchBlocks, validateParentRefs(response.units));
        imported += 1;
      } catch {
        // A trace is diagnostic data, not authority. Invalid output is ignored.
      }
    }
    return imported;
  }

  loadAudit(stage: CoverageAuditStage, options: AuditBlockCoverageOptions): BlockCoverageAuditResult | undefined {
    let saved = this.auditedStages.get(`${stage}:${options.blockAnchor}`);
    if (saved && saved.contractDigest !== this.expected.auditContractDigest) saved = undefined;
    if (!saved) {
      const requestDigest = this.auditRequestDigest(options);
      const matches = this.recoveryTraceEntries.filter((entry) =>
        entry.purpose === 'coverage-audit' && entry.outcome === 'SUCCESS' &&
        entry.provider === this.expected.provider && entry.model === this.expected.model &&
        digest(entry.requestMessages) === requestDigest && entry.responseText !== null
      );
      // A final re-audit can be byte-identical when repair units deduplicate;
      // legacy traces have no stage id, but temporal ordering is guaranteed.
      const match = stage === 'INITIAL_AUDIT' ? matches[0] : matches.at(-1);
      if (match?.responseText) {
        try {
          const response = coverageAuditResponseSchema.parse(JSON.parse(match.responseText));
          this.saveAudit(stage, options, interpretCoverageAuditResponse(options.blockAnchor, options.blockText, response.findings));
          saved = this.auditedStages.get(`${stage}:${options.blockAnchor}`);
        } catch {
          // Diagnostic traces are never trusted when strict replay fails.
        }
      }
    }
    if (!saved) return undefined;
    if ((saved.stage !== 'INITIAL_AUDIT' && saved.stage !== 'FINAL_AUDIT') || saved.requestDigest !== this.auditRequestDigest(options)) {
      throw new RawExtractionCheckpointError(`${stage} request mismatch for block ${options.blockAnchor}`);
    }
    return saved.result;
  }

  saveAudit(stage: CoverageAuditStage, options: AuditBlockCoverageOptions, result: BlockCoverageAuditResult): void {
    this.saveAuditedStage({
      stage,
      blockAnchor: options.blockAnchor,
      requestDigest: this.auditRequestDigest(options),
      contractDigest: this.expected.auditContractDigest,
      result: {
        blockAnchor: result.blockAnchor,
        findings: result.findings,
        hasGap: result.hasGap,
        ...(result.unresolved !== undefined && { unresolved: result.unresolved }),
      },
    });
  }

  loadRepair(options: FocusedRepairOptions): readonly ExtractedKnowledgeUnit[] | undefined {
    let saved = this.auditedStages.get(`FOCUSED_REPAIR:${options.block.anchor}`);
    if (saved && saved.contractDigest !== this.expected.repairContractDigest) saved = undefined;
    if (!saved) {
      const requestDigest = digest(buildFocusedRepairPromptMessages(options));
      const match = this.recoveryTraceEntries.find((entry) =>
        entry.purpose === 'focused-repair' && entry.outcome === 'SUCCESS' &&
        entry.provider === this.expected.provider && entry.model === this.expected.model &&
        digest(entry.requestMessages) === requestDigest && entry.responseText !== null
      );
      if (match?.responseText) {
        try {
          const response = z.strictObject({ units: z.array(extractedKnowledgeUnitSchema) }).parse(JSON.parse(match.responseText));
          this.saveRepair(options, validateParentRefs(response.units));
          saved = this.auditedStages.get(`FOCUSED_REPAIR:${options.block.anchor}`);
        } catch {
          // Invalid legacy repair response is ignored and paid call proceeds.
        }
      }
    }
    if (!saved) return undefined;
    if (saved.stage !== 'FOCUSED_REPAIR' || saved.requestDigest !== digest(buildFocusedRepairPromptMessages(options))) {
      throw new RawExtractionCheckpointError(`FOCUSED_REPAIR request mismatch for block ${options.block.anchor}`);
    }
    return saved.units;
  }

  saveRepair(options: FocusedRepairOptions, units: readonly ExtractedKnowledgeUnit[]): void {
    this.saveAuditedStage({
      stage: 'FOCUSED_REPAIR',
      blockAnchor: options.block.anchor,
      requestDigest: digest(buildFocusedRepairPromptMessages(options)),
      contractDigest: this.expected.repairContractDigest,
      units: z.array(extractedKnowledgeUnitSchema).parse(units),
    });
  }

  loadTaintExtraction(round: number, block: SourceBlock): readonly ExtractedKnowledgeUnit[] | undefined {
    const key = `TAINT_RESAMPLE_EXTRACTION:${round}:${block.anchor}`;
    let saved = this.auditedStages.get(key);
    if (saved && saved.contractDigest !== this.expected.configDigest) saved = undefined;
    const requestDigest = digest(buildExtractionPromptMessages([block]));
    if (!saved) {
      const match = this.recoveryTraceEntries.find((entry) =>
        entry.purpose === 'extraction' && entry.outcome === 'SUCCESS' &&
        entry.correlation?.stage === 'taint-resample' &&
        entry.provider === this.expected.provider && entry.model === this.expected.model &&
        digest(entry.requestMessages) === requestDigest && entry.responseText !== null
      );
      if (match?.responseText) {
        try {
          const response = z.strictObject({ units: z.array(extractedKnowledgeUnitSchema) }).parse(JSON.parse(match.responseText));
          this.saveTaintExtraction(round, block, validateParentRefs(response.units));
          saved = this.auditedStages.get(key);
        } catch { /* trace is not authority */ }
      }
    }
    if (!saved) return undefined;
    if (saved.stage !== 'TAINT_RESAMPLE_EXTRACTION' || saved.requestDigest !== requestDigest) {
      throw new RawExtractionCheckpointError(`Taint extraction request mismatch for block ${block.anchor}, round ${round}`);
    }
    return saved.units;
  }

  saveTaintExtraction(round: number, block: SourceBlock, units: readonly ExtractedKnowledgeUnit[]): void {
    this.saveAuditedStage({
      stage: 'TAINT_RESAMPLE_EXTRACTION', blockAnchor: block.anchor, round,
      requestDigest: digest(buildExtractionPromptMessages([block])), contractDigest: this.expected.configDigest,
      units: z.array(extractedKnowledgeUnitSchema).parse(units),
    });
  }

  loadTaintAudit(round: number, options: AuditBlockCoverageOptions): BlockCoverageAuditResult | undefined {
    const key = `TAINT_RESAMPLE_AUDIT:${round}:${options.blockAnchor}`;
    let saved = this.auditedStages.get(key);
    if (saved && saved.contractDigest !== this.expected.auditContractDigest) saved = undefined;
    const requestDigest = this.auditRequestDigest(options);
    if (!saved) {
      const matches = this.recoveryTraceEntries.filter((entry) =>
        entry.purpose === 'coverage-audit' && entry.outcome === 'SUCCESS' &&
        entry.provider === this.expected.provider && entry.model === this.expected.model &&
        digest(entry.requestMessages) === requestDigest && entry.responseText !== null
      );
      const match = matches.at(-1);
      if (match?.responseText) {
        try {
          const response = coverageAuditResponseSchema.parse(JSON.parse(match.responseText));
          this.saveTaintAudit(round, options, interpretCoverageAuditResponse(options.blockAnchor, options.blockText, response.findings));
          saved = this.auditedStages.get(key);
        } catch { /* trace is not authority */ }
      }
    }
    if (!saved) return undefined;
    if (saved.stage !== 'TAINT_RESAMPLE_AUDIT' || saved.requestDigest !== requestDigest) {
      throw new RawExtractionCheckpointError(`Taint audit request mismatch for block ${options.blockAnchor}, round ${round}`);
    }
    return saved.result;
  }

  saveTaintAudit(round: number, options: AuditBlockCoverageOptions, result: BlockCoverageAuditResult): void {
    this.saveAuditedStage({
      stage: 'TAINT_RESAMPLE_AUDIT', blockAnchor: options.blockAnchor, round,
      requestDigest: this.auditRequestDigest(options), contractDigest: this.expected.auditContractDigest,
      result: { blockAnchor: result.blockAnchor, findings: result.findings, hasGap: result.hasGap,
        ...(result.unresolved !== undefined && { unresolved: result.unresolved }) },
    });
  }

  private auditRequestDigest(options: AuditBlockCoverageOptions): string {
    return digest(buildCoverageAuditPromptMessages(options.blockText, options.extractedStatements, options.blockKind));
  }

  private saveAuditedStage(stage: CompletedAuditedStage): void {
    const key = this.stageKey(stage);
    const existing = this.auditedStages.get(key);
    if (existing && existing.contractDigest !== stage.contractDigest) {
      this.auditedStages.delete(key);
    }
    const compatibleExisting = this.auditedStages.get(key);
    if (compatibleExisting && digest(compatibleExisting) !== digest(stage)) {
      throw new RawExtractionCheckpointError(`Refusing to replace completed paid stage ${key}`);
    }
    if (compatibleExisting) return;
    this.auditedStages.set(key, stage);
    this.persist();
  }

  private stageKey(stage: CompletedAuditedStage): string {
    return 'round' in stage
      ? `${stage.stage}:${stage.round}:${stage.blockAnchor}`
      : `${stage.stage}:${stage.blockAnchor}`;
  }

  private assertRequest(batchIndex: number, blocks: readonly SourceBlock[]) {
    const descriptor = this.expected.batches[batchIndex];
    if (!descriptor || descriptor.requestDigest !== digest(buildExtractionPromptMessages(blocks))) {
      throw new RawExtractionCheckpointError(`Batch ${batchIndex} does not match the checkpoint fingerprint`);
    }
    return descriptor;
  }

  private persist(): void {
    const body: CheckpointBody = {
      version: RAW_EXTRACTION_CHECKPOINT_VERSION,
      trust: 'RAW_EXTRACTION_ONLY',
      fingerprint: this.expected,
      completedBatches: [...this.completed.values()].sort((a, b) => a.batchIndex - b.batchIndex),
      completedAuditedStages: [...this.auditedStages.values()].sort((a, b) =>
        `${a.blockAnchor}:${a.stage}`.localeCompare(`${b.blockAnchor}:${b.stage}`)
      ),
    };
    atomicWrite(this.filePath, { ...body, contentDigest: digest(body) });
  }
}
