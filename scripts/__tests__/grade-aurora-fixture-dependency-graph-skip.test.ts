import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  gradeNegativeCase,
  gradePositiveCase,
  main,
  resolveDependencyGraphGate,
  type EngineQuestionResultLike,
  type RunArtifacts,
} from '../grade-aurora-fixture';
import type { NegativeCaseApplicabilityOracle } from '../../src/lib/eval/negative-case-oracle';
import type { OracleCase } from '../../src/lib/eval/semantic-rule-oracle';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The real, committed baseline this task names explicitly: "Verify this
 *  against the committed audit rather than assuming." */
const COMMITTED_BASELINE_RUN_SUMMARY = path.resolve(
  HERE,
  '../../.claude/audits/2026-08-11-aurora-baseline/run-summary.json'
);

describe('resolveDependencyGraphGate', () => {
  it('does not throw for an explicit REQUIRED stage', () => {
    expect(resolveDependencyGraphGate({ dependencyGraphStage: 'REQUIRED' }, false)).toEqual({
      dependencyGraphSkipped: false,
    });
  });

  it('treats a missing dependencyGraphStage field as REQUIRED -- verified against the real committed baseline, not assumed', () => {
    const committed = JSON.parse(readFileSync(COMMITTED_BASELINE_RUN_SUMMARY, 'utf8')) as Record<string, unknown>;
    expect('dependencyGraphStage' in committed).toBe(false);
    expect(resolveDependencyGraphGate(committed, false)).toEqual({ dependencyGraphSkipped: false });
  });

  it('refuses a SKIPPED run without --accept-skipped-graph, naming the override', () => {
    expect(() => resolveDependencyGraphGate({ dependencyGraphStage: 'SKIPPED' }, false)).toThrow(
      'Run used a skipped dependency graph. Pass --accept-skipped-graph to grade this as a non-acceptance measurement.'
    );
  });

  it('folds the recorded skip reason into the refusal message when present', () => {
    expect(() =>
      resolveDependencyGraphGate(
        { dependencyGraphStage: 'SKIPPED', dependencyGraphSkipReason: 'явный флаг --dependency-graph=skip' },
        false
      )
    ).toThrow('явный флаг --dependency-graph=skip');
  });

  it('accepts a SKIPPED run once --accept-skipped-graph is passed', () => {
    expect(
      resolveDependencyGraphGate({ dependencyGraphStage: 'SKIPPED', dependencyGraphSkipReason: 'x' }, true)
    ).toEqual({ dependencyGraphSkipped: true });
  });

  it('--accept-skipped-graph is a no-op on a REQUIRED run', () => {
    expect(resolveDependencyGraphGate({ dependencyGraphStage: 'REQUIRED' }, true)).toEqual({
      dependencyGraphSkipped: false,
    });
  });
});

describe('gradePositiveCase / gradeNegativeCase dependencyGraphSkipped stamping', () => {
  const positiveOracle: OracleCase = {
    id: 'Q08',
    question: 'question text',
    expectedRuleIds: [8],
    expectedAnswer: 'answer',
    matchReason: 'rule 8',
    negativeCases: [],
  };
  const negativeOracle: NegativeCaseApplicabilityOracle = {
    id: 'Q09-N1',
    expectedDisposition: 'HOLD',
  };

  function result(overrides: Partial<EngineQuestionResultLike> = {}): EngineQuestionResultLike {
    return {
      caseId: 'Q08',
      question: positiveOracle.question,
      queryFrame: {},
      retrieval: { candidatesBeforeRerank: ['u8'], topK: ['u8'] },
      resolution: {
        disposition: 'ANSWER',
        selected: ['u8'],
        excluded: [],
        undetermined: [],
        clarificationNeeds: { facets: [], triggerFacts: [], ambiguities: [] },
        reasons: [],
      },
      verification: { verified: true, violations: [] },
      actualDisposition: 'DIRECT_ANSWER',
      errorMessage: null,
      draft: { text: 'answer', citedUnitIds: ['u8'] },
      ...overrides,
    };
  }

  function run(results: EngineQuestionResultLike[]): RunArtifacts {
    return { runId: 'run-1', units: [], sourceRuleIdByUnitId: new Map([['u8', 8]]), results };
  }

  it('gradePositiveCase omits dependencyGraphSkipped by default -- shape unaffected for REQUIRED', () => {
    const verdict = gradePositiveCase(positiveOracle, run([result()]));
    expect(verdict.pass).toBe(true);
    expect('dependencyGraphSkipped' in verdict).toBe(false);
  });

  it('gradePositiveCase stamps dependencyGraphSkipped:true when told the run was skipped', () => {
    const verdict = gradePositiveCase(positiveOracle, run([result()]), true);
    expect(verdict.dependencyGraphSkipped).toBe(true);
  });

  it('gradePositiveCase stamps the flag on the "no engine result recorded" early-return path too', () => {
    const verdict = gradePositiveCase(positiveOracle, run([]), true);
    expect(verdict.primaryFailureStage).toBe('ENGINE_ERROR');
    expect(verdict.dependencyGraphSkipped).toBe(true);
  });

  it('gradeNegativeCase omits dependencyGraphSkipped by default -- shape unaffected for REQUIRED', () => {
    const verdict = gradeNegativeCase(negativeOracle, run([result({ caseId: 'Q09-N1', actualDisposition: 'HOLD', resolution: null, verification: null, draft: null })]));
    expect('dependencyGraphSkipped' in verdict).toBe(false);
  });

  it('gradeNegativeCase stamps dependencyGraphSkipped:true when told the run was skipped', () => {
    const verdict = gradeNegativeCase(
      negativeOracle,
      run([result({ caseId: 'Q09-N1', actualDisposition: 'HOLD', resolution: null, verification: null, draft: null })]),
      true
    );
    expect(verdict.dependencyGraphSkipped).toBe(true);
  });

  it('gradeNegativeCase stamps the flag on the "no engine result recorded" early-return path too', () => {
    const verdict = gradeNegativeCase(negativeOracle, run([]), true);
    expect(verdict.primaryFailureStage).toBe('ENGINE_ERROR');
    expect(verdict.dependencyGraphSkipped).toBe(true);
  });
});

describe('main() end-to-end dependency-graph gate', () => {
  let rootDir = '';
  afterEach(() => {
    if (rootDir) {
      rmSync(rootDir, { recursive: true, force: true });
      rootDir = '';
    }
  });

  /** Minimal run directory: empty results mean every oracle case grades via
   *  the "no engine result recorded" path, which is irrelevant here -- these
   *  tests only assert on the gate/shape, never on pass/fail counts. */
  function writeMinimalRunFixture(runId: string, summaryExtra: Record<string, unknown> = {}): { inDir: string; outPath: string } {
    rootDir = mkdtempSync(path.join(tmpdir(), 'grade-aurora-dependency-graph-'));
    const runDir = path.join(rootDir, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, 'persisted-units.json'), '[]', 'utf8');
    writeFileSync(path.join(runDir, 'source-rule-id-by-unit.json'), '{}', 'utf8');
    writeFileSync(path.join(runDir, 'engine-results.json'), '[]', 'utf8');
    writeFileSync(
      path.join(rootDir, 'run-summary.json'),
      JSON.stringify({ runIds: [runId], ...summaryExtra }, null, 2),
      'utf8'
    );
    return { inDir: rootDir, outPath: path.join(rootDir, 'report.json') };
  }

  it('refuses a skipped run without --accept-skipped-graph: rejects and writes no report', async () => {
    const { inDir, outPath } = writeMinimalRunFixture('run-1', {
      dependencyGraphStage: 'SKIPPED',
      dependencyGraphSkipReason: 'явный флаг --dependency-graph=skip',
    });

    await expect(main([`--in=${inDir}`, `--out=${outPath}`])).rejects.toThrow(
      'Run used a skipped dependency graph. Pass --accept-skipped-graph to grade this as a non-acceptance measurement.'
    );
    expect(existsSync(outPath)).toBe(false);
  });

  it('grades a skipped run when --accept-skipped-graph is passed, stamping dependencyGraphSkipped throughout', async () => {
    const { inDir, outPath } = writeMinimalRunFixture('run-1', {
      dependencyGraphStage: 'SKIPPED',
      dependencyGraphSkipReason: 'явный флаг --dependency-graph=skip',
    });

    await main([`--in=${inDir}`, `--out=${outPath}`, '--accept-skipped-graph']);

    expect(existsSync(outPath)).toBe(true);
    const report = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(report.dependencyGraphSkipped).toBe(true);
    expect(report.perRunSummary.length).toBeGreaterThan(0);
    expect(report.perRunSummary.every((r: { dependencyGraphSkipped?: boolean }) => r.dependencyGraphSkipped === true)).toBe(true);
    expect(report.allVerdicts.length).toBeGreaterThan(0);
    expect(report.allVerdicts.every((v: { dependencyGraphSkipped?: boolean }) => v.dependencyGraphSkipped === true)).toBe(true);
  });

  it('grades a REQUIRED run (no dependencyGraphStage field, mirroring the committed baseline) with the exact pre-existing shape', async () => {
    const { inDir, outPath } = writeMinimalRunFixture('run-1');

    await main([`--in=${inDir}`, `--out=${outPath}`]);

    expect(existsSync(outPath)).toBe(true);
    const report = JSON.parse(readFileSync(outPath, 'utf8'));
    expect('dependencyGraphSkipped' in report).toBe(false);
    expect(report.perRunSummary.length).toBeGreaterThan(0);
    expect(report.perRunSummary.some((r: Record<string, unknown>) => 'dependencyGraphSkipped' in r)).toBe(false);
    expect(report.allVerdicts.length).toBeGreaterThan(0);
    expect(report.allVerdicts.some((v: Record<string, unknown>) => 'dependencyGraphSkipped' in v)).toBe(false);
  });

  it('--accept-skipped-graph on a REQUIRED run changes nothing (no flag needed, unaffected output)', async () => {
    const { inDir, outPath } = writeMinimalRunFixture('run-1', { dependencyGraphStage: 'REQUIRED' });

    await main([`--in=${inDir}`, `--out=${outPath}`, '--accept-skipped-graph']);

    const report = JSON.parse(readFileSync(outPath, 'utf8'));
    expect('dependencyGraphSkipped' in report).toBe(false);
  });
});
