import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ModelInfo } from '@/lib/ai/embedding-provider';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';
import type { RetrievalCandidate } from '@/lib/knowledge/semantic-retrieval';

import {
  EXTRACTION_ARTIFACT_VERSION,
  ExtractionArtifactError,
  ExtractionArtifactMismatchError,
  assertFingerprintMatches,
  buildExtractionArtifact,
  computeFingerprintDigest,
  computePipelineProbes,
  diffFingerprints,
  parseExtractionArtifact,
  readExtractionArtifact,
  restoreEmbeddedCandidates,
  serializeExtractionArtifact,
  writeExtractionArtifact,
  type ExtractionArtifact,
  type ExtractionFingerprint,
} from '../extraction-artifact';

/**
 * W1-A. The whole point of the artifact cache is that a benchmark run can skip
 * ~36% of its LLM calls when extraction is not what's under test. The whole
 * RISK of it is that a stale artifact reused after the extraction logic
 * changed produces confidently wrong conclusions — strictly worse than the
 * money it saves. These tests are therefore weighted toward refusal, not reuse.
 */

const FINGERPRINT: ExtractionFingerprint = {
  artifactVersion: EXTRACTION_ARTIFACT_VERSION,
  sourceRevisionHash: 'source-rev-1',
  canonicalTextHash: 'canonical-text-1',
  parserVersion: '2.0.0',
  blockCount: 15,
  extractionProvider: 'anthropic',
  extractionModel: 'claude-sonnet-5',
  extractionPromptVersion: 'extraction-prompt-v1',
  extractionSchemaVersion: 'extraction-schema-v1',
  extractionMaxTokens: 16000,
  extractionBatchSize: 4,
  auditProvider: 'anthropic',
  auditModel: 'claude-sonnet-5',
  auditPromptVersion: 'audit-prompt-v1',
  auditPromptFingerprint: 'a'.repeat(64),
  auditPolicyFingerprint: 'b'.repeat(64),
  focusedRepairPolicyFingerprint: 'c'.repeat(64),
  identityAlgorithmFingerprint: 'd'.repeat(64),
  retrievalTextFingerprint: 'e'.repeat(64),
  embeddingProvider: 'openai',
  embeddingModel: 'text-embedding-3-small',
  embeddingDimensions: 4,
};

const EMBEDDING_MODEL: ModelInfo = { provider: 'openai', model: 'text-embedding-3-small', dimensions: 4 };

function unit(unitId: string): PersistedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: `утверждение ${unitId}`,
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    parentRuleRef: null,
    sourceSpan: { anchor: 'anchor-1', quote: `цитата ${unitId}` },
    evidenceByField: { statement: { anchor: 'anchor-1', quote: `цитата ${unitId}` } },
    uncertainties: [],
    sourceBlockAnchor: 'block-1',
    unitId,
    contentHash: `hash-${unitId}`,
  };
}

function candidate(unitId: string): RetrievalCandidate {
  return { unitId, retrievalText: `retrieval text ${unitId}` };
}

function artifact(overrides: Partial<Parameters<typeof buildExtractionArtifact>[0]> = {}): ExtractionArtifact {
  return buildExtractionArtifact({
    fingerprint: FINGERPRINT,
    sourceDocPath: 'oracle-pack/source.docx',
    snapshot: {
      sourceRevisionHash: 'source-rev-1',
      canonicalTextHash: 'canonical-text-1',
      parserVersion: '2.0.0',
      extractionRunId: 'run-1-2026-08-10T00-00-00-000Z',
      extractionProvider: 'anthropic',
      extractionModel: 'claude-sonnet-5',
      extractionPromptVersion: 'extraction-prompt-v1',
      extractionSchemaVersion: 'extraction-schema-v1',
      humanReviewed: false,
      units: [unit('u1'), unit('u2')],
    },
    embeddingModel: EMBEDDING_MODEL,
    embeddings: [
      { unitId: 'u1', retrievalText: 'retrieval text u1', embedding: [0.1, 0.2, 0.3, 0.4] },
      { unitId: 'u2', retrievalText: 'retrieval text u2', embedding: [0.5, 0.6, 0.7, 0.8] },
    ],
    extractionAttemptLog: [{ attempt: 1, outcome: 'SUCCESS', message: null }],
    batchLogs: [],
    auditResults: [],
    focusedRetryLogs: [],
    ...overrides,
  });
}

function mutateField(fp: ExtractionFingerprint, key: keyof ExtractionFingerprint): ExtractionFingerprint {
  const value = fp[key];
  return { ...fp, [key]: typeof value === 'number' ? value + 1 : `${value}-changed` } as ExtractionFingerprint;
}

describe('computeFingerprintDigest', () => {
  it('is deterministic and independent of key insertion order', () => {
    const reordered = Object.fromEntries(
      Object.entries(FINGERPRINT).reverse()
    ) as unknown as ExtractionFingerprint;
    expect(computeFingerprintDigest(FINGERPRINT)).toBe(computeFingerprintDigest(FINGERPRINT));
    expect(computeFingerprintDigest(reordered)).toBe(computeFingerprintDigest(FINGERPRINT));
  });

  it('EVERY field participates — no field can drift silently', () => {
    const base = computeFingerprintDigest(FINGERPRINT);
    const inert: string[] = [];
    for (const key of Object.keys(FINGERPRINT) as (keyof ExtractionFingerprint)[]) {
      if (computeFingerprintDigest(mutateField(FINGERPRINT, key)) === base) inert.push(key);
    }
    expect(inert).toEqual([]);
  });
});

describe('diffFingerprints', () => {
  it('reports nothing when the configuration is unchanged', () => {
    expect(diffFingerprints(FINGERPRINT, { ...FINGERPRINT })).toEqual([]);
  });

  it('names the changed field and BOTH values — a bare "mismatch" is not actionable', () => {
    const current = mutateField(FINGERPRINT, 'extractionModel');
    expect(diffFingerprints(FINGERPRINT, current)).toEqual([
      { field: 'extractionModel', saved: 'claude-sonnet-5', current: 'claude-sonnet-5-changed' },
    ]);
  });

  it('reports every changed field, not just the first', () => {
    const current = mutateField(mutateField(FINGERPRINT, 'extractionBatchSize'), 'auditPolicyFingerprint');
    expect(diffFingerprints(FINGERPRINT, current).map((m) => m.field).sort()).toEqual([
      'auditPolicyFingerprint',
      'extractionBatchSize',
    ]);
  });
});

describe('assertFingerprintMatches', () => {
  it('passes an identical configuration through', () => {
    expect(() => assertFingerprintMatches(FINGERPRINT, { ...FINGERPRINT }, 'artifact.json')).not.toThrow();
  });

  it('refuses LOUDLY: names the artifact, the field, both values and the way out', () => {
    let caught: unknown;
    try {
      assertFingerprintMatches(FINGERPRINT, mutateField(FINGERPRINT, 'auditPolicyFingerprint'), 'artifact.json');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExtractionArtifactMismatchError);
    const message = (caught as Error).message;
    expect(message).toContain('artifact.json');
    expect(message).toContain('auditPolicyFingerprint');
    expect(message).toContain('b'.repeat(64));
    expect(message).toContain('--fresh-extraction');
    expect((caught as ExtractionArtifactMismatchError).mismatches.map((m) => m.field)).toEqual([
      'auditPolicyFingerprint',
    ]);
  });

  it('never silently proceeds on a changed extraction MODEL', () => {
    expect(() =>
      assertFingerprintMatches(FINGERPRINT, mutateField(FINGERPRINT, 'extractionModel'), 'artifact.json')
    ).toThrow(ExtractionArtifactMismatchError);
  });
});

describe('serializeExtractionArtifact / parseExtractionArtifact', () => {
  it('round-trips without losing units or embeddings', () => {
    const parsed = parseExtractionArtifact(serializeExtractionArtifact(artifact()), 'artifact.json');
    expect(parsed.snapshot.units.map((u) => u.unitId)).toEqual(['u1', 'u2']);
    expect(parsed.embeddings.map((e) => e.unitId)).toEqual(['u1', 'u2']);
    expect(parsed.fingerprint).toEqual(FINGERPRINT);
    expect(parsed.snapshot.humanReviewed).toBe(false);
  });

  it('rejects non-JSON with the artifact path in the message', () => {
    expect(() => parseExtractionArtifact('{not json', 'broken.json')).toThrow(ExtractionArtifactError);
    expect(() => parseExtractionArtifact('{not json', 'broken.json')).toThrow(/broken\.json/);
  });

  it('rejects an artifact written by a different artifact version', () => {
    const raw = JSON.parse(serializeExtractionArtifact(artifact()));
    raw.artifactVersion = 'some-older-version';
    expect(() => parseExtractionArtifact(JSON.stringify(raw), 'old.json')).toThrow(ExtractionArtifactError);
  });

  it('rejects a HAND-EDITED fingerprint — the stored digest no longer matches its own fields', () => {
    const raw = JSON.parse(serializeExtractionArtifact(artifact()));
    raw.fingerprint.extractionBatchSize = 99;
    expect(() => parseExtractionArtifact(JSON.stringify(raw), 'tampered.json')).toThrow(/digest/i);
  });

  it('rejects an empty unit set — a degenerate artifact would look like a clean reuse', () => {
    const raw = JSON.parse(serializeExtractionArtifact(artifact()));
    raw.snapshot.units = [];
    expect(() => parseExtractionArtifact(JSON.stringify(raw), 'empty.json')).toThrow(ExtractionArtifactError);
  });
});

describe('readExtractionArtifact', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'extraction-artifact-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports a missing file clearly instead of crashing (the --reuse-extraction typo case)', () => {
    const missing = path.join(dir, 'nope.json');
    expect(() => readExtractionArtifact(missing, FINGERPRINT)).toThrow(ExtractionArtifactError);
    expect(() => readExtractionArtifact(missing, FINGERPRINT)).toThrow(/nope\.json/);
  });

  it('round-trips through disk and returns the artifact when the fingerprint matches', () => {
    const file = path.join(dir, 'good.json');
    writeExtractionArtifact(file, artifact());
    expect(readExtractionArtifact(file, { ...FINGERPRINT }).snapshot.units).toHaveLength(2);
  });

  it('refuses a stale artifact rather than returning it', () => {
    const file = path.join(dir, 'stale.json');
    writeExtractionArtifact(file, artifact());
    expect(() => readExtractionArtifact(file, mutateField(FINGERPRINT, 'parserVersion'))).toThrow(
      ExtractionArtifactMismatchError
    );
  });

  it('surfaces a truncated file as an artifact error, not a raw SyntaxError', () => {
    const file = path.join(dir, 'truncated.json');
    writeFileSync(file, serializeExtractionArtifact(artifact()).slice(0, 120), 'utf8');
    expect(() => readExtractionArtifact(file, FINGERPRINT)).toThrow(ExtractionArtifactError);
  });
});

describe('restoreEmbeddedCandidates', () => {
  it('returns cached vectors in the order of the CURRENT candidate list', () => {
    const restored = restoreEmbeddedCandidates(
      artifact(),
      [candidate('u2'), candidate('u1')],
      EMBEDDING_MODEL,
      'artifact.json'
    );
    expect(restored.map((c) => c.unitId)).toEqual(['u2', 'u1']);
    expect(restored[0].embedding).toEqual([0.5, 0.6, 0.7, 0.8]);
    expect(restored[0].embeddingModel).toEqual(EMBEDDING_MODEL);
  });

  it('refuses when the cached unit set differs from the snapshot candidates', () => {
    expect(() =>
      restoreEmbeddedCandidates(artifact(), [candidate('u1'), candidate('u3')], EMBEDDING_MODEL, 'artifact.json')
    ).toThrow(ExtractionArtifactError);
  });

  it('refuses when the retrieval text drifted — the cached vector describes different words', () => {
    const drifted: readonly RetrievalCandidate[] = [
      { unitId: 'u1', retrievalText: 'retrieval text u1 ПЛЮС новое поле' },
      candidate('u2'),
    ];
    expect(() => restoreEmbeddedCandidates(artifact(), drifted, EMBEDDING_MODEL, 'artifact.json')).toThrow(
      /retrievalText|текст/i
    );
  });

  it('refuses vectors computed by a different embedding model', () => {
    expect(() =>
      restoreEmbeddedCandidates(
        artifact(),
        [candidate('u1'), candidate('u2')],
        { provider: 'openai', model: 'text-embedding-3-large', dimensions: 4 },
        'artifact.json'
      )
    ).toThrow(ExtractionArtifactError);
  });

  it('refuses vectors of the wrong dimensionality', () => {
    const wrongDims = artifact({
      embeddings: [
        { unitId: 'u1', retrievalText: 'retrieval text u1', embedding: [0.1, 0.2] },
        { unitId: 'u2', retrievalText: 'retrieval text u2', embedding: [0.5, 0.6, 0.7, 0.8] },
      ],
    });
    expect(() =>
      restoreEmbeddedCandidates(wrongDims, [candidate('u1'), candidate('u2')], EMBEDDING_MODEL, 'artifact.json')
    ).toThrow(ExtractionArtifactError);
  });
});

describe('computePipelineProbes', () => {
  it('produces a stable sha256 per probed policy', () => {
    const first = computePipelineProbes();
    const second = computePipelineProbes();
    expect(first).toEqual(second);
    for (const value of Object.values(first)) {
      expect(value).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('probes are pairwise distinct — each observes a DIFFERENT policy, not the same one five times', () => {
    const values = Object.values(computePipelineProbes());
    expect(new Set(values).size).toBe(values.length);
  });

  it('covers the five behaviours a saved extraction silently depends on', () => {
    expect(Object.keys(computePipelineProbes()).sort()).toEqual([
      'auditPolicyFingerprint',
      'auditPromptFingerprint',
      'focusedRepairPolicyFingerprint',
      'identityAlgorithmFingerprint',
      'retrievalTextFingerprint',
    ]);
  });
});
