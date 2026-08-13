import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ensureDependencyGraph,
  expandRetrievedDependencies,
  parseArgs,
  resolveDependencyGraphSummaryFields,
} from '../run-aurora-fixture';
import {
  createDependencyGraph,
  type DependencyEdgeInput,
  type DependencyEndpoint,
  type DependencyGraph,
} from '../../src/lib/knowledge/dependency-graph';
import { CallTraceLog } from '../../src/lib/ai/call-trace-log';
import { CostLedger } from '../../src/lib/ai/cost-ledger';
import type { ExtractionArtifact } from '../../src/lib/eval/extraction-artifact';
import type { PersistedKnowledgeUnit } from '../../src/lib/knowledge/applicability/identity-assignment';

/**
 * Tests for the `--dependency-graph=required|skip` audit-only measurement
 * override. New file (not an extension of `run-aurora-fixture-dependency-
 * graph.test.ts`) specifically to avoid touching a file that overlaps with
 * concurrent work on dependency-graph.ts/dependency-graph-builder.ts.
 */

const REQUIRED = [
  '--mode=e2e',
  '--out=C:/tmp/aurora-dependency-graph-skip-test',
  '--max-cost-usd=0.50',
  '--max-paid-calls=7',
];

function unit(unitId: string): PersistedKnowledgeUnit {
  return {
    unitId,
    statement: `statement ${unitId}`,
    sourceSpan: { anchor: unitId, quote: `quote ${unitId}` },
    evidenceByField: { statement: { anchor: unitId, quote: `quote ${unitId}` } },
    sourceBlockAnchor: unitId,
    contentHash: `hash-${unitId}`,
    kind: 'PROCEDURE_STEP',
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    parentRuleRef: null,
    uncertainties: [],
  };
}

/** Only the fields `ensureDependencyGraph` (and its REQUIRED-path helpers)
 *  actually read: phase, contentDigest, fingerprint.{extractionProvider,
 *  extractionModel}, snapshot.units. Cast at the boundary like the codebase's
 *  own fixtures do (see grade-aurora-fixture.test.ts's `evidenceUnit`). */
function fakeExtractionArtifact(units: readonly PersistedKnowledgeUnit[]): ExtractionArtifact {
  return {
    phase: 'COMPLETE',
    contentDigest: 'a'.repeat(64),
    fingerprint: { extractionProvider: 'anthropic', extractionModel: 'claude-sonnet-5' },
    snapshot: { units },
  } as unknown as ExtractionArtifact;
}

const endpoint = (unitId: string): DependencyEndpoint => ({
  unitId,
  sourceSpan: { anchor: unitId, quote: `quote ${unitId}` },
  evidenceByField: { statement: { anchor: unitId, quote: `quote ${unitId}` } },
});

let tempDir = '';
afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

describe('--dependency-graph CLI flag parsing', () => {
  it('defaults to required with no flag; run-summary fields stay exactly today\'s shape', () => {
    const args = parseArgs(REQUIRED);
    expect(args.dependencyGraphStage).toBe('required');

    const fields = resolveDependencyGraphSummaryFields(args.dependencyGraphStage);
    expect(fields).toEqual({ dependencyGraphStage: 'REQUIRED' });
    // Strict key-set check -- proves no dependencyGraphSkipReason leaks in
    // for the default path, i.e. run-summary.json's shape is unchanged.
    expect(Object.keys(fields)).toEqual(['dependencyGraphStage']);
  });

  it('accepts an explicit --dependency-graph=required', () => {
    expect(parseArgs([...REQUIRED, '--dependency-graph=required']).dependencyGraphStage).toBe('required');
  });

  it('accepts an explicit --dependency-graph=skip', () => {
    expect(parseArgs([...REQUIRED, '--dependency-graph=skip']).dependencyGraphStage).toBe('skip');
  });

  it('rejects an unsupported value with the established parseArgs error style', () => {
    expect(() => parseArgs([...REQUIRED, '--dependency-graph=maybe'])).toThrow(
      '--dependency-graph принимает required|skip, получено "maybe"'
    );
  });

  it('is not swallowed by the unknown-argument check', () => {
    // Regression guard for the exact bug class the file's own comment on
    // knownOptions warns about (--fresh-extraction=false silently ignored):
    // an unrecognized --dependency-graph=X must fail LOUD, never fall
    // through as "unknown argument" nor be silently accepted.
    expect(() => parseArgs([...REQUIRED, '--dependency-graph=REQUIRED_TYPO'])).toThrow(/--dependency-graph принимает/);
  });

  it('marks a skipped stage with a non-empty reason naming the grader override', () => {
    const fields = resolveDependencyGraphSummaryFields('skip');
    expect(fields).toMatchObject({ dependencyGraphStage: 'SKIPPED' });
    const reason = (fields as { dependencyGraphStage: 'SKIPPED'; dependencyGraphSkipReason: string }).dependencyGraphSkipReason;
    expect(reason.length).toBeGreaterThan(0);
    expect(reason).toContain('--accept-skipped-graph');
  });
});

describe('ensureDependencyGraph required/skip switch', () => {
  it('required (absent-flag default) still invokes the graph builder and produces a real graph', async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'aurora-dependency-graph-required-'));
    const units = [unit('a'), unit('b')];
    const artifact = fakeExtractionArtifact(units);
    const endpointA = endpoint('a');
    const endpointB = endpoint('b');
    const edge: DependencyEdgeInput = {
      fromUnitId: 'a',
      toUnitId: 'b',
      relation: 'REQUIRES',
      auditStatus: 'TRUSTED',
      evidence: { from: endpointA.sourceSpan, to: endpointB.sourceSpan },
    };
    const canned: DependencyGraph = createDependencyGraph({ units: [endpointA, endpointB], edges: [edge] });
    // Mocked/spied builder, not a real call -- proves the REQUIRED path
    // still runs the stage without ever reaching a provider.
    const buildGraph = vi.fn(async () => canned);
    const ledger = new CostLedger();
    const traceLog = new CallTraceLog();

    const args = parseArgs(REQUIRED);
    expect(args.dependencyGraphStage).toBe('required');

    const ready = await ensureDependencyGraph(
      'run-required',
      path.join(tempDir, 'extraction-artifact.json'),
      artifact,
      ledger,
      traceLog,
      args.dependencyGraphStage,
      buildGraph
    );

    expect(buildGraph).toHaveBeenCalledTimes(1);
    expect(ready.graph.edges).toHaveLength(1);
    expect(ready.artifactPath).not.toBeNull();
    expect(existsSync(ready.artifactPath as string)).toBe(true);
    expect(ledger.totalAttemptCount()).toBe(0);
    expect(traceLog.all()).toHaveLength(0);
  });

  it('skip short-circuits before any provider call: builder never invoked, empty-edge graph, disk untouched', async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'aurora-dependency-graph-skip-'));
    const units = [unit('a'), unit('b')];
    const artifact = fakeExtractionArtifact(units);
    const endpointA = endpoint('a');
    const endpointB = endpoint('b');
    const edge: DependencyEdgeInput = {
      fromUnitId: 'a',
      toUnitId: 'b',
      relation: 'REQUIRES',
      auditStatus: 'TRUSTED',
      evidence: { from: endpointA.sourceSpan, to: endpointB.sourceSpan },
    };
    // Same canned non-empty graph the REQUIRED test above uses: if skip ever
    // regressed into calling the real builder, this test would see its
    // (mocked) edge and fail the edges:[] assertion below.
    const canned: DependencyGraph = createDependencyGraph({ units: [endpointA, endpointB], edges: [edge] });
    const buildGraph = vi.fn(async () => canned);
    const ledger = new CostLedger();
    const traceLog = new CallTraceLog();

    const ready = await ensureDependencyGraph(
      'run-skip',
      path.join(tempDir, 'extraction-artifact.json'),
      artifact,
      ledger,
      traceLog,
      'skip',
      buildGraph
    );

    expect(buildGraph).not.toHaveBeenCalled();
    expect(ready.artifactPath).toBeNull();
    expect(ready.restored).toBe(false);
    expect(ready.graph.edges).toEqual([]);
    expect([...ready.graph.units.keys()].sort()).toEqual(['a', 'b']);
    expect(ledger.totalAttemptCount()).toBe(0);
    expect(traceLog.all()).toHaveLength(0);
    // No sidecar artifact, no stage journal -- nothing written to disk at all.
    expect(readdirSync(tempDir)).toEqual([]);

    // expandRetrievedDependencies degenerates to a no-op: only retrieval
    // seeds enter the candidate pool, exactly the pre-a0a17ba behaviour.
    const expansion = expandRetrievedDependencies(['a'], ready.graph);
    expect(expansion).toEqual({
      retrievalSeedUnitIds: ['a'],
      expandedUnitIds: ['a'],
      trustedMandatoryUnitIds: [],
    });
  });

  it('skip produces a distinct artifactContentDigest from a required run of the same extraction', async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'aurora-dependency-graph-digest-'));
    const units = [unit('a'), unit('b')];
    const artifact = fakeExtractionArtifact(units);
    const endpointA = endpoint('a');
    const endpointB = endpoint('b');
    const canned: DependencyGraph = createDependencyGraph({ units: [endpointA, endpointB], edges: [] });
    const buildGraph = vi.fn(async () => canned);
    const ledger = new CostLedger();
    const traceLog = new CallTraceLog();

    const required = await ensureDependencyGraph(
      'run-a', path.join(tempDir, 'extraction-artifact.json'), artifact, ledger, traceLog, 'required', buildGraph
    );
    const skipped = await ensureDependencyGraph(
      'run-b', path.join(tempDir, 'extraction-artifact.json'), artifact, ledger, traceLog, 'skip', buildGraph
    );

    expect(skipped.artifactContentDigest).not.toBe(required.artifactContentDigest);
  });
});
