import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  dependencyGraphQuestionFingerprint,
  dependencyGraphSidecarPath,
  dependencyGraphStructuredCallCeiling,
  expandRetrievedDependencies,
  withStructuredRetry,
} from '../run-aurora-fixture';
import {
  createDependencyGraph,
  serializeDependencyGraph,
  type DependencyEdgeInput,
  type DependencyEndpoint,
} from '../../src/lib/knowledge/dependency-graph';
import {
  buildDependencyGraphArtifact,
  buildDependencyGraphArtifactFingerprint,
  loadCompatibleDependencyGraphArtifact,
  writeDependencyGraphArtifact,
} from '../../src/lib/eval/dependency-graph-artifact';
import { buildQuestionJournalFingerprint } from '../../src/lib/eval/question-result-journal';
import { CostLedger } from '../../src/lib/ai/cost-ledger';
import { CallTraceLog } from '../../src/lib/ai/call-trace-log';

const unit = (unitId: string): DependencyEndpoint => ({
  unitId,
  sourceSpan: { anchor: unitId, quote: `evidence ${unitId}` },
  evidenceByField: { statement: { anchor: unitId, quote: `evidence ${unitId}` } },
});
const edge = (
  from: DependencyEndpoint,
  to: DependencyEndpoint,
  relation: DependencyEdgeInput['relation']
): DependencyEdgeInput => ({
  fromUnitId: from.unitId,
  toUnitId: to.unitId,
  relation,
  auditStatus: 'TRUSTED',
  evidence: { from: from.sourceSpan, to: to.sourceSpan },
});

let directory: string | undefined;
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

describe('Aurora dependency graph integration', () => {
  it('Q01-like retrieval adds and protects a directed prerequisite', () => {
    const procedure = unit('procedure');
    const privatePlace = unit('private-place');
    const graph = createDependencyGraph({
      units: [procedure, privatePlace],
      edges: [edge(procedure, privatePlace, 'REQUIRES')],
    });
    expect(expandRetrievedDependencies(['procedure'], graph)).toEqual({
      retrievalSeedUnitIds: ['procedure'],
      expandedUnitIds: ['procedure', 'private-place'],
      trustedMandatoryUnitIds: ['private-place'],
    });
  });

  it('Q10-like CO_REQUIRED closure is recursive and protected', () => {
    const helper = unit('helper');
    const consent = unit('consent');
    const stop = unit('stop');
    const force = unit('force');
    const graph = createDependencyGraph({
      units: [helper, consent, stop, force],
      edges: [
        edge(helper, consent, 'CO_REQUIRED'),
        edge(helper, stop, 'CO_REQUIRED'),
        edge(helper, force, 'CO_REQUIRED'),
      ],
    });
    const expansion = expandRetrievedDependencies(['consent'], graph);
    expect(expansion.expandedUnitIds).toEqual(['consent', 'helper', 'force', 'stop']);
    expect(expansion.trustedMandatoryUnitIds).toEqual(['helper', 'force', 'stop']);
  });

  it('Q02-like ALTERNATIVE enters the pool without a classifier-drop lock', () => {
    const standard = unit('standard');
    const conditional = unit('conditional');
    const unrelated = unit('unrelated');
    const graph = createDependencyGraph({
      units: [standard, conditional, unrelated],
      edges: [edge(standard, conditional, 'ALTERNATIVE')],
    });
    expect(expandRetrievedDependencies(['standard'], graph)).toEqual({
      retrievalSeedUnitIds: ['standard'],
      expandedUnitIds: ['standard', 'conditional'],
      trustedMandatoryUnitIds: [],
    });
  });

  it('fails closed rather than silently truncating dependency closure', () => {
    const a = unit('a'); const b = unit('b'); const c = unit('c');
    const graph = createDependencyGraph({
      units: [a, b, c],
      edges: [edge(a, b, 'REQUIRES'), edge(b, c, 'REQUIRES')],
    });
    expect(() => expandRetrievedDependencies(['a'], graph, { maxUnits: 2, maxDepth: 6 }))
      .toThrow(/exceeded bounds/);
  });

  it('budgets all six logical builder stages and resolves a stable sidecar path', () => {
    expect(dependencyGraphStructuredCallCeiling()).toBe(6);
    const extractionPath = path.join('runs', 'one', 'extraction-artifact.json');
    expect(dependencyGraphSidecarPath(extractionPath))
      .toBe(path.join('runs', 'one', 'dependency-graph-artifact.json'));
    expect(dependencyGraphSidecarPath(extractionPath, 'a'.repeat(64)))
      .toBe(path.join('runs', 'one', `dependency-graph-artifact-${'a'.repeat(16)}.json`));
  });

  it('accounts one dependency stage reservation, priced attempt, and trace exactly once', async () => {
    const ledger = new CostLedger({ maxPaidCalls: 1, maxTotalUsd: 1 });
    const trace = new CallTraceLog();
    ledger.reservePaidCall('dependency-graph-audit');
    await withStructuredRetry(
      async () => ({
        attempts: [{
          provider: 'openai' as const,
          model: 'gpt-4o-mini',
          startedAt: '2026-08-11T00:00:00.000Z',
          latencyMs: 1,
          outcome: 'SUCCESS' as const,
          usage: { inputTokens: 1_000_000, outputTokens: 0 },
        }],
      }),
      1,
      'dependency graph audit',
      ledger,
      trace,
      'dependency-graph-audit',
      (result) => result.attempts,
      () => ({ requestMessages: [{ role: 'user', content: 'full graph' }], responseText: '{"verdict":"PASS"}' }),
      { runId: 'run-test', stage: 'dependency-graph-audit' }
    );
    expect(ledger.totalReservedPaidCalls()).toBe(1);
    expect(ledger.totalAttemptCount()).toBe(1);
    expect(ledger.summaryByPurpose()).toEqual([
      expect.objectContaining({ purpose: 'dependency-graph-audit', callCount: 1, attemptCount: 1 }),
    ]);
    expect(trace.all()).toEqual([
      expect.objectContaining({ purpose: 'dependency-graph-audit', outcome: 'SUCCESS' }),
    ]);
  });

  it('reuses the exact sidecar and binds question cache to graph content and behavior', () => {
    directory = mkdtempSync(path.join(tmpdir(), 'aurora-dependency-integration-'));
    const extraction = { phase: 'COMPLETE', contentDigest: 'a'.repeat(64) };
    const a = unit('a'); const b = unit('b');
    const graph = createDependencyGraph({ units: [a, b], edges: [edge(a, b, 'REQUIRES')] });
    const units = [{ unitId: 'a', statement: 'a' }, { unitId: 'b', statement: 'b' }];
    const config = { provider: 'anthropic', model: 'fixed', prompt: 'p', schema: 's', policy: 'x' };
    const fingerprint = buildDependencyGraphArtifactFingerprint(extraction, units, config);
    const artifact = buildDependencyGraphArtifact(fingerprint, serializeDependencyGraph(graph));
    const file = path.join(directory, 'dependency-graph-artifact.json');
    writeDependencyGraphArtifact(file, artifact);
    expect(loadCompatibleDependencyGraphArtifact(file, fingerprint)?.contentDigest).toBe(artifact.contentDigest);

    const base = buildQuestionJournalFingerprint(
      extraction.contentDigest,
      dependencyGraphQuestionFingerprint(artifact.contentDigest, graph)
    );
    const changed = buildQuestionJournalFingerprint(
      extraction.contentDigest,
      dependencyGraphQuestionFingerprint('b'.repeat(64), graph)
    );
    expect(changed.configDigest).not.toBe(base.configDigest);
  });
});
