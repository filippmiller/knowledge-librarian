import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CallTraceEntry } from '@/lib/ai/call-trace-log';
import { extractKnowledgeUnitsInBatches } from '@/lib/knowledge/batch-extraction';
import { extractKnowledgeUnitsWithCompletenessAudit } from '@/lib/knowledge/audited-extraction';
import { buildExtractionPromptMessages, type SourceBlock } from '@/lib/knowledge/knowledge-unit-extractor';
import type { ExtractedKnowledgeUnit } from '@/lib/knowledge/applicability/extraction';
import {
  buildRawExtractionFingerprint,
  RawExtractionCheckpointStore,
} from '../raw-extraction-checkpoint';

const blocks: SourceBlock[] = [
  { anchor: 'a', text: 'Первое правило.' },
  { anchor: 'b', text: 'Второе правило.' },
];
const unit = (anchor: string): ExtractedKnowledgeUnit => ({
  kind: 'PROCEDURE_STEP', statement: `Правило ${anchor}`, facets: {}, triggerCondition: null,
  numericConstraint: null, extractionRef: 'u1', parentExtractionRef: null,
  sourceSpan: { anchor, quote: anchor === 'a' ? 'Первое правило.' : 'Второе правило.' },
  evidenceByField: { statement: { anchor, quote: anchor === 'a' ? 'Первое правило.' : 'Второе правило.' } },
  uncertainties: [],
});
function fingerprint(source = 'source', auditContract = 'audit-v1') {
  const legacyCombinedConfig = { promptVersion: 'v1', maxTokens: 100, auditVersion: auditContract };
  return buildRawExtractionFingerprint({
    sourceRevisionHash: source, canonicalTextHash: 'canonical', parserVersion: 'parser', blocks,
    batchSize: 1,
    config: { promptVersion: 'v1', maxTokens: 100 },
    auditContract: { version: auditContract }, repairContract: { version: 'repair-v1' },
    legacyCombinedConfig,
    provider: 'anthropic', model: 'haiku',
  });
}

describe('RawExtractionCheckpointStore', () => {
  let dir = '';
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });
  function file() { dir = mkdtempSync(path.join(tmpdir(), 'raw-extraction-')); return path.join(dir, 'checkpoint.json'); }

  it('writes each successful batch and a rerun skips every completed paid call', async () => {
    const checkpointPath = file();
    let calls = 0;
    const first = new RawExtractionCheckpointStore(checkpointPath, fingerprint());
    await expect(extractKnowledgeUnitsInBatches(blocks, 1, { runConfig: {} as never }, async (options) => {
      calls += 1;
      if (options.blocks[0].anchor === 'b') throw new Error('crash after first batch');
      return { units: [unit('a')], structuredResult: {} as never };
    }, first)).rejects.toThrow('crash');
    expect(JSON.parse(readFileSync(checkpointPath, 'utf8')).trust).toBe('RAW_EXTRACTION_ONLY');

    const resumed = new RawExtractionCheckpointStore(checkpointPath, fingerprint());
    const result = await extractKnowledgeUnitsInBatches(blocks, 1, { runConfig: {} as never }, async (options) => {
      calls += 1;
      return { units: [unit(options.blocks[0].anchor)], structuredResult: {} as never };
    }, resumed);
    expect(calls).toBe(3); // first a + failed b + resumed b; resumed a cost nothing
    expect(result.units).toHaveLength(2);
  });

  it('fails closed on source/config mismatch and content tampering', () => {
    const checkpointPath = file();
    const store = new RawExtractionCheckpointStore(checkpointPath, fingerprint());
    store.saveBatch(0, [blocks[0]], [unit('a')]);
    expect(() => new RawExtractionCheckpointStore(checkpointPath, fingerprint('other'))).toThrow(/fingerprint mismatch/);
    const json = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    json.completedBatches[0].units[0].statement = 'tampered';
    writeFileSync(checkpointPath, JSON.stringify(json));
    expect(() => new RawExtractionCheckpointStore(checkpointPath, fingerprint())).toThrow(/digest mismatch/);
  });

  it('imports only exact-request, provider/model-matching, strict-schema SUCCESS trace entries', () => {
    const checkpointPath = file();
    const store = new RawExtractionCheckpointStore(checkpointPath, fingerprint());
    const trace: CallTraceEntry = {
      callId: 'recovery-call-1', correlation: { runId: 'run-1', stage: 'extraction' }, attempts: [],
      timestamp: new Date(0).toISOString(), purpose: 'extraction', provider: 'anthropic', model: 'haiku', outcome: 'SUCCESS',
      requestMessages: buildExtractionPromptMessages([blocks[0]]),
      responseText: JSON.stringify({ units: [unit('a')] }), errorMessage: null,
    };
    expect(store.importTraceEntries([trace], blocks)).toBe(1);
    expect(store.loadBatch(0, [blocks[0]])).toHaveLength(1);
    expect(store.loadBatch(1, [blocks[1]])).toBeUndefined();
  });

  it('never substitutes a later focused-repair response for an initial one-block batch', () => {
    const checkpointPath = file();
    const store = new RawExtractionCheckpointStore(checkpointPath, fingerprint());
    const trace = (statement: string): CallTraceEntry => ({
      callId: `recovery-${statement}`, correlation: { runId: 'run-1', stage: 'extraction' }, attempts: [],
      timestamp: new Date(0).toISOString(), purpose: 'extraction', provider: 'anthropic', model: 'haiku', outcome: 'SUCCESS',
      requestMessages: buildExtractionPromptMessages([blocks[0]]),
      responseText: JSON.stringify({ units: [{ ...unit('a'), statement }] }), errorMessage: null,
    });
    expect(store.importTraceEntries([trace('initial'), trace('later repair')], blocks)).toBe(1);
    expect(store.loadBatch(0, [blocks[0]])?.[0].statement).toBe('initial');
  });

  it('rejects extraction-purpose responses for a different block prompt', () => {
    const checkpointPath = file();
    const store = new RawExtractionCheckpointStore(checkpointPath, fingerprint());
    const wrong: CallTraceEntry = {
      callId: 'wrong-recovery-call', correlation: { runId: 'run-1', stage: 'extraction' }, attempts: [],
      timestamp: new Date(0).toISOString(), purpose: 'extraction', provider: 'anthropic', model: 'haiku', outcome: 'SUCCESS',
      requestMessages: buildExtractionPromptMessages([{ anchor: 'repair', text: 'Другой блок.' }]),
      responseText: JSON.stringify({ units: [unit('a')] }), errorMessage: null,
    };
    expect(store.importTraceEntries([wrong], blocks)).toBe(0);
  });

  it('resumes initial audit, compact repair, and final audit without repeating any paid stage', async () => {
    const checkpointPath = file();
    let extractionCalls = 0;
    let auditCalls = 0;
    let repairCalls = 0;
    const execute = (checkpoint: RawExtractionCheckpointStore) =>
      extractKnowledgeUnitsWithCompletenessAudit(
        [blocks[0]], 1, { runConfig: {} as never }, {} as never,
        {
          extractor: async () => {
            extractionCalls += 1;
            return { units: [unit('a')], structuredResult: {} as never };
          },
          auditor: async (options) => {
            auditCalls += 1;
            const repaired = options.extractedStatements.some((statement) => statement.statement === 'repair');
            return repaired
              ? { blockAnchor: 'a', findings: [{ verdict: 'COVERED', quote: '', explanation: 'ok', quoteVerified: false }], hasGap: false, unresolved: false }
              : { blockAnchor: 'a', findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'Первое правило.', explanation: 'missing', quoteVerified: true }], hasGap: true, unresolved: false };
          },
          repairExtractor: async () => {
            repairCalls += 1;
            return { units: [unit('a'), { ...unit('a'), extractionRef: 'repair', statement: 'repair' }], structuredResult: {} as never };
          },
          initialExtractionCheckpoint: checkpoint,
          paidStageCheckpoint: checkpoint,
        }
      );

    await execute(new RawExtractionCheckpointStore(checkpointPath, fingerprint()));
    expect({ extractionCalls, auditCalls, repairCalls }).toEqual({ extractionCalls: 1, auditCalls: 2, repairCalls: 1 });
    await execute(new RawExtractionCheckpointStore(checkpointPath, fingerprint()));
    expect({ extractionCalls, auditCalls, repairCalls }).toEqual({ extractionCalls: 1, auditCalls: 2, repairCalls: 1 });
  });

  it('audit policy change preserves paid initial batches but invalidates only audit entries', () => {
    const checkpointPath = file();
    const first = new RawExtractionCheckpointStore(checkpointPath, fingerprint('source', 'audit-v1'));
    first.saveBatch(0, [blocks[0]], [unit('a')]);
    const auditOptions = {
      blockAnchor: 'a', blockText: blocks[0].text,
      extractedStatements: [{ statement: unit('a').statement, quote: unit('a').sourceSpan.quote }],
      runConfig: {} as never,
    };
    first.saveAudit('INITIAL_AUDIT', auditOptions, {
      blockAnchor: 'a', findings: [{ verdict: 'COVERED', quote: '', explanation: 'ok', quoteVerified: false }], hasGap: false,
    });

    const afterAuditFix = new RawExtractionCheckpointStore(checkpointPath, fingerprint('source', 'audit-v2'));
    expect(afterAuditFix.loadBatch(0, [blocks[0]])).toHaveLength(1);
    expect(afterAuditFix.loadAudit('INITIAL_AUDIT', auditOptions)).toBeUndefined();
  });

  it('migrates pre-split checkpoint atomically, preserving batches and dropping unversioned audited stages', () => {
    const checkpointPath = file();
    const expected = fingerprint();
    const store = new RawExtractionCheckpointStore(checkpointPath, expected);
    store.saveBatch(0, [blocks[0]], [unit('a')]);
    const json = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    json.fingerprint.configDigest = json.fingerprint.legacyCombinedConfigDigest;
    // Simulates the real b2 audit-prompt fix: the old opaque combined digest
    // cannot equal today's extraction-only digest.
    json.fingerprint.configDigest = 'f'.repeat(64);
    delete json.fingerprint.auditContractDigest;
    delete json.fingerprint.repairContractDigest;
    delete json.fingerprint.legacyCombinedConfigDigest;
    json.completedAuditedStages = [{
      stage: 'INITIAL_AUDIT', blockAnchor: 'a', requestDigest: 'a'.repeat(64),
      result: { blockAnchor: 'a', findings: [{ verdict: 'COVERED', quote: '', explanation: 'legacy', quoteVerified: false }], hasGap: false },
    }];
    const { contentDigest: _oldDigest, ...legacyBody } = json;
    json.contentDigest = createHash('sha256').update(JSON.stringify(legacyBody), 'utf8').digest('hex');
    writeFileSync(checkpointPath, JSON.stringify(json));

    const migrated = new RawExtractionCheckpointStore(checkpointPath, expected);
    expect(migrated.loadBatch(0, [blocks[0]])).toHaveLength(1);
    const rewritten = JSON.parse(readFileSync(checkpointPath, 'utf8'));
    expect(rewritten.fingerprint.auditContractDigest).toBe(expected.auditContractDigest);
    expect(rewritten.completedAuditedStages).toEqual([]);
  });

  it('resumes taint replacement extraction and its audit independently by round', () => {
    const checkpointPath = file();
    const first = new RawExtractionCheckpointStore(checkpointPath, fingerprint());
    first.saveTaintExtraction(1, blocks[0], [unit('a')]);
    const auditOptions = {
      blockAnchor: 'a', blockText: blocks[0].text,
      extractedStatements: [{ statement: unit('a').statement, quote: unit('a').sourceSpan.quote }],
      runConfig: {} as never,
    };
    first.saveTaintAudit(1, auditOptions, {
      blockAnchor: 'a', findings: [{ verdict: 'COVERED', quote: '', explanation: 'ok', quoteVerified: false }], hasGap: false,
    });
    const resumed = new RawExtractionCheckpointStore(checkpointPath, fingerprint());
    expect(resumed.loadTaintExtraction(1, blocks[0])).toHaveLength(1);
    expect(resumed.loadTaintAudit(1, auditOptions)?.findings[0].verdict).toBe('COVERED');
    expect(resumed.loadTaintExtraction(2, blocks[0])).toBeUndefined();
  });
});
