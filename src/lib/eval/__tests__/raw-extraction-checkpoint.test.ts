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
  isImmediatelyPreviousQualityV2RawFamily,
  RawExtractionCheckpointStore,
  type RawExtractionFingerprint,
} from '../raw-extraction-checkpoint';

function previousQualityV2Fingerprint(): RawExtractionFingerprint {
  const anchors = [['b0', 'b1', 'b2', 'b3'], ['b4', 'b5', 'b6', 'b7'], ['b8', 'b9', 'b10', 'b11'], ['b12', 'b13', 'b14']];
  const requests = [
    'ec9605e2ff802700a2be5e534a785912e41c72d3fef20b5ccd0cd1ad1d769684',
    '9a57baf98567fba7a89cae378aa8ce7c805edb2a591fc3c336ea874f3580fed0',
    '624d587a831a7cbdab9fca5d7cb871745ee44301f2e96205f0e5f930b1a6f457',
    '584f1b18f780e76445c95928c04974a540c6c74a25d54ddaf27893067b298f2e',
  ];
  return {
    sourceRevisionHash: '90cfcdf6ccfd2ce719bba81cf826dd93b4ace7a9234db45d750b9f3975bdc3b6',
    canonicalTextHash: '8e87e889d6f5cd09dbd2ad5278c607e5b47d3472a6c3a85f18a90711705bdd70',
    parserVersion: '2.0.0',
    sourceBlocksDigest: 'f9f2cab9b297a2112d0264c7a623a0b4a1354f051057ac49840faa0d50152b05',
    configDigest: '34a635cd960adac15ea65f2beeb64060603dd32f452bf3f483451f8866068fad',
    auditContractDigest: 'a'.repeat(64), repairContractDigest: 'b'.repeat(64),
    provider: 'anthropic', model: 'claude-sonnet-5', batchSize: 4,
    batches: anchors.map((blockAnchors, batchIndex) => ({ batchIndex, blockAnchors, requestDigest: requests[batchIndex]! })),
  };
}

function immediateQualityV2Successor(previous: RawExtractionFingerprint): RawExtractionFingerprint {
  const requests = [
    'd738a03ef58b99f91a65946232ecd4f95789d10992c4702f96b97acc5f47349b',
    'a45bc51b02b4d92e21a25fa8dca6f5f5c732cf5723c08fd0be6d9387fca859c0',
    '9b0d90b64167d3da44d50df5e087a3e9d0394b78d9bbfb2c0fb18b0fc214f5d1',
    'f8f36f32d66adf56a8bf821170b84086d59fb549917458e1bae489b94d733915',
  ];
  return {
    ...previous,
    configDigest: 'c9aa58e6eeac7e90bd144f6456b41ab40da833b0fc7f8f8a545676cfc2984db0',
    auditContractDigest: 'd'.repeat(64),
    repairContractDigest: 'e'.repeat(64),
    batches: previous.batches.map((batch, index) => ({
      ...batch,
      requestDigest: requests[index]!,
    })),
  };
}

describe('one-transition quality-v2 raw prompt migration', () => {
  it('accepts the exact prior paid raw family only for its exact immediate successor', () => {
    const previous = previousQualityV2Fingerprint();
    const current = immediateQualityV2Successor(previous);
    expect(isImmediatelyPreviousQualityV2RawFamily(previous, current)).toBe(true);
  });

  it('rejects future config or request drift even when source/provider/layout still match', () => {
    const previous = previousQualityV2Fingerprint();
    const current = immediateQualityV2Successor(previous);
    expect(isImmediatelyPreviousQualityV2RawFamily(
      previous, { ...current, configDigest: '0'.repeat(64) }
    )).toBe(false);
    expect(isImmediatelyPreviousQualityV2RawFamily(previous, {
      ...current,
      batches: current.batches.map((batch, index) => index === 2
        ? { ...batch, requestDigest: '0'.repeat(64) }
        : batch),
    })).toBe(false);
  });

  it('fails closed on source/provider/layout mismatch instead of broadly ignoring prompt drift', () => {
    const previous = previousQualityV2Fingerprint();
    const current = immediateQualityV2Successor(previous);
    expect(isImmediatelyPreviousQualityV2RawFamily(
      { ...previous, sourceRevisionHash: '0'.repeat(64) }, current
    )).toBe(false);
    expect(isImmediatelyPreviousQualityV2RawFamily(
      { ...previous, provider: 'openai' }, current
    )).toBe(false);
    expect(isImmediatelyPreviousQualityV2RawFamily(
      { ...previous, batches: previous.batches.slice(0, 3) }, current
    )).toBe(false);
  });
});

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
function fingerprint(source = 'source', auditContract = 'audit-v1', exceptionRepairContract = 'exception-v1') {
  const legacyCombinedConfig = { promptVersion: 'v1', maxTokens: 100, auditVersion: auditContract };
  return buildRawExtractionFingerprint({
    sourceRevisionHash: source, canonicalTextHash: 'canonical', parserVersion: 'parser', blocks,
    batchSize: 1,
    config: { promptVersion: 'v1', maxTokens: 100 },
    auditContract: { version: auditContract }, repairContract: { version: 'repair-v1' },
    exceptionRepairContract: exceptionRepairContract === 'live-strict-v1'
      ? { policyFingerprint: '5a23e0d076490ba1ecde8f26316235aff611929e5abe417bf1fbeaac3c51aab9', maxTokens: 8_000 }
      : { version: exceptionRepairContract },
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
    delete json.fingerprint.exceptionRepairContractDigest;
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

  it('journals exception repair extraction and audit against the exact prompt and round', () => {
    const checkpointPath = file();
    const messages = [
      { role: 'system' as const, content: 'exception taxonomy v1' },
      { role: 'user' as const, content: 'repair malformed ref unit-1' },
    ];
    const auditOptions = {
      blockAnchor: 'a', blockText: blocks[0].text,
      extractedStatements: [{ statement: unit('a').statement, quote: unit('a').sourceSpan.quote }],
      runConfig: {} as never,
    };
    const first = new RawExtractionCheckpointStore(checkpointPath, fingerprint());
    first.saveExceptionRepair(1, blocks[0], messages, [unit('a')]);
    first.saveExceptionRepairAudit(1, auditOptions, {
      blockAnchor: 'a', findings: [{ verdict: 'COVERED', quote: '', explanation: 'ok', quoteVerified: false }], hasGap: false,
    });

    const resumed = new RawExtractionCheckpointStore(checkpointPath, fingerprint());
    expect(resumed.loadExceptionRepair(1, blocks[0], messages)).toHaveLength(1);
    expect(resumed.loadExceptionRepairAudit(1, auditOptions)?.findings[0].verdict).toBe('COVERED');
    expect(resumed.loadExceptionRepair(2, blocks[0], messages)).toBeUndefined();
    expect(() => resumed.loadExceptionRepair(1, blocks[0], [
      ...messages.slice(0, 1),
      { role: 'user', content: 'different malformed ref' },
    ])).toThrow(/request mismatch/);
  });

  it('evicts only a stale exception-repair audit when the replacement request changes', () => {
    const checkpointPath = file();
    const first = new RawExtractionCheckpointStore(checkpointPath, fingerprint());
    first.saveBatch(0, [blocks[0]], [unit('a')]);
    const oldAuditOptions = {
      blockAnchor: 'a', blockText: blocks[0].text,
      extractedStatements: [{ statement: 'old replacement', quote: unit('a').sourceSpan.quote }],
      runConfig: {} as never,
    };
    const newAuditOptions = {
      ...oldAuditOptions,
      extractedStatements: [{ statement: 'new replacement', quote: unit('a').sourceSpan.quote }],
    };
    first.saveExceptionRepairAudit(1, oldAuditOptions, {
      blockAnchor: 'a', findings: [{ verdict: 'COVERED', quote: '', explanation: 'old', quoteVerified: false }], hasGap: false,
    });

    const resumed = new RawExtractionCheckpointStore(checkpointPath, fingerprint());
    expect(resumed.loadExceptionRepairAudit(1, newAuditOptions)).toBeUndefined();
    // Other exact stages survive the selective eviction.
    expect(resumed.loadBatch(0, [blocks[0]])).toHaveLength(1);
    resumed.saveExceptionRepairAudit(1, newAuditOptions, {
      blockAnchor: 'a', findings: [{ verdict: 'COVERED', quote: '', explanation: 'new', quoteVerified: false }], hasGap: false,
    });
    expect(resumed.loadExceptionRepairAudit(1, newAuditOptions)?.findings[0].explanation).toBe('new');
  });

  it('exception prompt change invalidates only exception stages', () => {
    const checkpointPath = file();
    const messages = [
      { role: 'system' as const, content: 'exception taxonomy v1' },
      { role: 'user' as const, content: 'repair malformed ref unit-1' },
    ];
    const auditOptions = {
      blockAnchor: 'a', blockText: blocks[0].text,
      extractedStatements: [{ statement: unit('a').statement, quote: unit('a').sourceSpan.quote }],
      runConfig: {} as never,
    };
    const focusedOptions = {
      block: blocks[0],
      findings: [{
        verdict: 'UNREPRESENTED_CLAUSE' as const,
        quote: 'Первое правило.',
        explanation: 'missing',
        quoteVerified: true,
      }],
      existingUnits: [unit('a')],
      runConfig: {} as never,
    };
    const first = new RawExtractionCheckpointStore(checkpointPath, fingerprint());
    first.saveBatch(0, [blocks[0]], [unit('a')]);
    first.saveAudit('INITIAL_AUDIT', auditOptions, {
      blockAnchor: 'a', findings: [{ verdict: 'COVERED', quote: '', explanation: 'ok', quoteVerified: false }], hasGap: false,
    });
    first.saveRepair(focusedOptions, [unit('a')]);
    first.saveExceptionRepair(1, blocks[0], messages, [unit('a')]);

    const afterExceptionPromptChange = new RawExtractionCheckpointStore(
      checkpointPath,
      fingerprint('source', 'audit-v1', 'exception-v2')
    );
    expect(afterExceptionPromptChange.loadBatch(0, [blocks[0]])).toHaveLength(1);
    expect(afterExceptionPromptChange.loadAudit('INITIAL_AUDIT', auditOptions)).toBeDefined();
    expect(afterExceptionPromptChange.loadRepair(focusedOptions)).toHaveLength(1);
    expect(afterExceptionPromptChange.loadExceptionRepair(1, blocks[0], messages)).toBeUndefined();
  });

  it('persists and reloads multiple focused repairs and final audits for one block by request digest', () => {
    const checkpointPath = file();
    const first = new RawExtractionCheckpointStore(checkpointPath, fingerprint());
    const repair1 = {
      block: blocks[0], existingUnits: [unit('a')], runConfig: {} as never,
      findings: [{ verdict: 'UNREPRESENTED_CLAUSE' as const, quote: 'Первое', explanation: 'trigger', quoteVerified: true }],
    };
    const repaired = unit('a');
    const repair2 = {
      ...repair1, existingUnits: [repaired],
      findings: [{ verdict: 'UNREPRESENTED_CLAUSE' as const, quote: 'правило', explanation: 'numeric', quoteVerified: true }],
    };
    const repair3 = {
      ...repair1, existingUnits: [repaired, unit('b')],
      findings: [{ verdict: 'UNREPRESENTED_CLAUSE' as const, quote: 'Первое правило', explanation: 'duration', quoteVerified: true }],
    };
    const audit1 = { blockAnchor: 'a', blockText: blocks[0].text, extractedStatements: [{ statement: 'round1', quote: 'Первое правило.' }], runConfig: {} as never };
    const audit2 = { ...audit1, extractedStatements: [{ statement: 'round2', quote: 'Первое правило.' }] };
    const audit3 = { ...audit1, extractedStatements: [{ statement: 'round3', quote: 'Первое правило.' }] };
    const gap = { blockAnchor: 'a', findings: [{ verdict: 'UNREPRESENTED_CLAUSE' as const, quote: 'правило', explanation: 'gap', quoteVerified: true }], hasGap: true };
    const covered = { blockAnchor: 'a', findings: [{ verdict: 'COVERED' as const, quote: '', explanation: 'clean', quoteVerified: false }], hasGap: false };
    first.saveRepair(repair1, [unit('a')]);
    first.saveRepair(repair2, [unit('a')]);
    first.saveRepair(repair3, [unit('b')]);
    first.saveAudit('FINAL_AUDIT', audit1, gap);
    first.saveAudit('FINAL_AUDIT', audit2, covered);
    first.saveAudit('FINAL_AUDIT', audit3, covered);

    const resumed = new RawExtractionCheckpointStore(checkpointPath, fingerprint());
    expect(resumed.loadRepair(repair1)).toHaveLength(1);
    expect(resumed.loadRepair(repair2)).toHaveLength(1);
    expect(resumed.loadRepair(repair3)).toHaveLength(1);
    expect(resumed.loadAudit('FINAL_AUDIT', audit1)?.hasGap).toBe(true);
    expect(resumed.loadAudit('FINAL_AUDIT', audit2)?.hasGap).toBe(false);
    expect(resumed.loadAudit('FINAL_AUDIT', audit3)?.hasGap).toBe(false);
  });

  it('preserves a schema-valid successful repair from the immediately preceding live prompt', () => {
    const checkpointPath = file();
    const oldMessages = [
      { role: 'system' as const, content: 'strict unit skeleton without closed trigger catalog' },
      { role: 'user' as const, content: 'repair b4' },
    ];
    const newMessages = [
      { role: 'system' as const, content: 'strict unit skeleton plus closed trigger catalog' },
      { role: 'user' as const, content: 'repair b4' },
    ];
    const parent = unit('a');
    const validException: ExtractedKnowledgeUnit = {
      ...unit('a'),
      kind: 'EXCEPTION_RULE',
      statement: 'Допустимая оговорка.',
      extractionRef: 'exception',
      parentExtractionRef: parent.extractionRef,
      triggerCondition: { all: [{ fact: 'helperPresent', equals: true }] },
      evidenceByField: {
        statement: unit('a').sourceSpan,
        triggerCondition: unit('a').sourceSpan,
      },
    };
    const first = new RawExtractionCheckpointStore(
      checkpointPath,
      fingerprint('source', 'audit-v1', 'live-strict-v1')
    );
    first.saveExceptionRepair(1, blocks[0], oldMessages, [parent, validException]);

    const afterCatalogFix = new RawExtractionCheckpointStore(
      checkpointPath,
      fingerprint('source', 'audit-v1', 'exception-v2')
    );
    expect(afterCatalogFix.loadExceptionRepair(1, blocks[0], newMessages)).toHaveLength(2);
  });
});
