import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDependencyGraphArtifact,
  buildDependencyGraphArtifactFingerprint,
  loadCompatibleDependencyGraphArtifact,
  parseDependencyGraphArtifact,
  writeDependencyGraphArtifact,
} from '../dependency-graph-artifact';

const extraction = { phase: 'COMPLETE', contentDigest: 'a'.repeat(64) };
const units = [{ unitId: 'u1', text: 'one' }, { unitId: 'u2', text: 'two' }];
const config = { provider: 'p', model: 'm', prompt: 'prompt-v1', schema: 'schema-v1', policy: 'policy-v1' };
const graph = { edges: [], omittedEdges: [], bounds: { maxEdges: 1000, maxDegree: 50 }, fingerprint: 'c'.repeat(64) };
let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined; });

describe('dependency graph sidecar artifact', () => {
  it('atomically round-trips and reuses only an exact fingerprint', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'dependency-graph-'));
    const file = path.join(dir, 'graph.json');
    const fingerprint = buildDependencyGraphArtifactFingerprint(extraction, units, config);
    writeDependencyGraphArtifact(file, buildDependencyGraphArtifact(fingerprint, graph));
    expect(loadCompatibleDependencyGraphArtifact(file, fingerprint)?.graph).toEqual(graph);
    expect(readFileSync(file, 'utf8')).toContain('contentDigest');
  });

  it.each([
    ['extraction digest', { extractionArtifactContentDigest: 'b'.repeat(64) }],
    ['unit content', { orderedUnitContentHashes: [...buildDependencyGraphArtifactFingerprint(extraction, [{ ...units[0], text: 'changed' }, units[1]], config).orderedUnitContentHashes] }],
    ['provider', { provider: 'other' }], ['model', { model: 'other' }], ['prompt', { prompt: 'other' }],
    ['schema', { schema: 'other' }], ['policy', { policy: 'other' }],
  ])('fails closed on %s mismatch', (_name, change) => {
    dir = mkdtempSync(path.join(tmpdir(), 'dependency-graph-'));
    const file = path.join(dir, 'graph.json');
    const fingerprint = buildDependencyGraphArtifactFingerprint(extraction, units, config);
    writeDependencyGraphArtifact(file, buildDependencyGraphArtifact(fingerprint, graph));
    expect(() => loadCompatibleDependencyGraphArtifact(file, { ...fingerprint, ...change })).toThrow(/fingerprint mismatch/);
  });

  it('rejects non-COMPLETE extraction and content tampering', () => {
    expect(() => buildDependencyGraphArtifactFingerprint({ ...extraction, phase: 'SEMANTIC_CHECKPOINT' }, units, config)).toThrow(/COMPLETE/);
    const artifact = buildDependencyGraphArtifact(buildDependencyGraphArtifactFingerprint(extraction, units, config), graph);
    const raw = JSON.parse(JSON.stringify(artifact)); raw.graph.fingerprint = 'd'.repeat(64);
    expect(() => parseDependencyGraphArtifact(JSON.stringify(raw), 'tampered.json')).toThrow(/content digest/);
  });

  it('canonicalizes unit order and rejects duplicate identities', () => {
    const forward = buildDependencyGraphArtifactFingerprint(extraction, units, config);
    const reverse = buildDependencyGraphArtifactFingerprint(extraction, [...units].reverse(), config);
    expect(reverse.orderedUnitContentHashes).toEqual(forward.orderedUnitContentHashes);
    expect(() => buildDependencyGraphArtifactFingerprint(extraction, [units[0], { ...units[0] }], config)).toThrow(/Duplicate/);
  });

  it('strictly rejects a malformed dependency graph document', () => {
    const fingerprint = buildDependencyGraphArtifactFingerprint(extraction, units, config);
    expect(() => buildDependencyGraphArtifact(fingerprint, { ...graph, extra: true } as typeof graph)).toThrow();
    expect(() => buildDependencyGraphArtifact(fingerprint, {
      ...graph,
      edges: [{
        fromUnitId: 'u1', toUnitId: 'u2', relation: 'REQUIRES', auditStatus: 'PENDING',
        evidence: {
          from: { anchor: 'u1', quote: 'one' },
          to: { anchor: 'u2', quote: 'two' },
        },
      }],
    })).toThrow(/TRUSTED/);
  });

  it('strictly rejects unknown fields and a truncated disk file', () => {
    const artifact = buildDependencyGraphArtifact(buildDependencyGraphArtifactFingerprint(extraction, units, config), graph);
    expect(() => parseDependencyGraphArtifact(JSON.stringify({ ...artifact, surprise: true }))).toThrow(/Invalid/);
    dir = mkdtempSync(path.join(tmpdir(), 'dependency-graph-'));
    const file = path.join(dir, 'graph.json'); writeFileSync(file, '{"artifactVersion":');
    expect(() => loadCompatibleDependencyGraphArtifact(file, artifact.fingerprint)).toThrow(/Invalid JSON/);
  });
});
