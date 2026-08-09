/**
 * Grades scripts/run-aurora-fixture.ts artifacts against the oracle (goal
 * shift 2026-08-09, Task 14). Strictly a SEPARATE pass from engine
 * execution — reads recorded traces the engine produced without ever seeing
 * expected_answer/expected_rule_ids, and ONLY NOW compares them against the
 * oracle. Deterministic assertions only (rule coverage, disposition,
 * evidence-group coverage, verification violations) — no LLM judge this
 * session (explicitly left as a follow-up in the final report; per the
 * task's own preference, "if deterministic expected facts can be encoded,
 * prefer those over LLM judgment").
 *
 * Usage:
 *   npx tsx scripts/grade-aurora-fixture.ts --in=path/to/run-aurora-fixture-output --out=path/to/report.json
 */
import 'dotenv/config';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadSemanticRuleOracle, type OracleCase } from '../src/lib/eval/semantic-rule-oracle';
import { loadNegativeCaseOracle, type NegativeCaseApplicabilityOracle } from '../src/lib/eval/negative-case-oracle';
import { RULE_9_EVIDENCE_GROUP, RULE_10_EVIDENCE_GROUP, evaluateEvidenceGroupCoverage, type RequiredEvidenceGroup } from '../src/lib/eval/evidence-groups';
import type { PersistedKnowledgeUnit } from '../src/lib/knowledge/applicability/identity-assignment';

type FailureStage =
  | 'EXTRACTION_MISS'
  | 'RETRIEVAL_MISS'
  | 'RERANK_MISS'
  | 'APPLICABILITY_ERROR'
  | 'RESOLUTION_ERROR'
  | 'EVIDENCE_ERROR'
  | 'SYNTHESIS_ERROR'
  | 'EXPECTED_CLARIFICATION_MISSED'
  | 'UNEXPECTED_HOLD'
  | 'ENGINE_ERROR'
  | 'NONE';

const EVIDENCE_GROUPS_BY_RULE: Record<number, RequiredEvidenceGroup> = {
  9: RULE_9_EVIDENCE_GROUP,
  10: RULE_10_EVIDENCE_GROUP,
};

function parseArgs(argv: readonly string[]): { inDir: string; outPath: string } {
  const inArg = argv.find((a) => a.startsWith('--in='))?.slice('--in='.length);
  const outArg = argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
  if (!inArg || !outArg) {
    throw new Error('Usage: npx tsx scripts/grade-aurora-fixture.ts --in=<dir> --out=<report.json>');
  }
  return { inDir: inArg, outPath: outArg };
}

interface EngineQuestionResultLike {
  readonly caseId: string;
  readonly question: string;
  readonly queryFrame: unknown;
  readonly retrieval: {
    readonly topK: readonly string[];
    readonly candidatesBeforeRerank: readonly string[];
  } | null;
  readonly resolution: {
    readonly disposition: 'ANSWER' | 'CLARIFY' | 'HOLD';
    readonly selected: readonly string[];
    readonly excluded: readonly { unitId: string; reason: string }[];
    readonly undetermined: readonly { unitId: string; reason: string }[];
    readonly clarificationNeeds: { facets: readonly string[]; triggerFacts: readonly string[]; ambiguities: readonly string[] };
    readonly reasons: readonly string[];
  } | null;
  readonly verification: { readonly verified: boolean; readonly violations: readonly { code: string; detail: string }[] } | null;
  readonly actualDisposition: 'DIRECT_ANSWER' | 'HOLD' | 'ERROR';
  readonly errorMessage: string | null;
  readonly draft: { readonly text: string; readonly citedUnitIds: readonly string[] } | null;
}

interface RunArtifacts {
  readonly runId: string;
  readonly units: readonly PersistedKnowledgeUnit[];
  readonly sourceRuleIdByUnitId: ReadonlyMap<string, number | null>;
  readonly results: readonly EngineQuestionResultLike[];
}

function loadRunArtifacts(runDir: string, runId: string): RunArtifacts {
  const units: PersistedKnowledgeUnit[] = JSON.parse(readFileSync(path.join(runDir, 'persisted-units.json'), 'utf8'));
  const sourceRuleIdByUnitIdRaw: Record<string, number | null> = JSON.parse(
    readFileSync(path.join(runDir, 'source-rule-id-by-unit.json'), 'utf8')
  );
  const results: EngineQuestionResultLike[] = JSON.parse(readFileSync(path.join(runDir, 'engine-results.json'), 'utf8'));
  return { runId, units, sourceRuleIdByUnitId: new Map(Object.entries(sourceRuleIdByUnitIdRaw)), results };
}

interface CaseVerdict {
  readonly runId: string;
  readonly caseId: string;
  readonly pass: boolean;
  readonly expectedDisposition: 'DIRECT_ANSWER' | 'HOLD';
  readonly actualDisposition: 'DIRECT_ANSWER' | 'HOLD' | 'ERROR';
  readonly primaryFailureStage: FailureStage;
  readonly diagnosticFlags: readonly string[];
}

function ruleIdsOf(unitIds: readonly string[], sourceRuleIdByUnitId: ReadonlyMap<string, number | null>): Set<number> {
  const out = new Set<number>();
  for (const id of unitIds) {
    const ruleId = sourceRuleIdByUnitId.get(id);
    if (ruleId !== null && ruleId !== undefined) out.add(ruleId);
  }
  return out;
}

function gradePositiveCase(oracleCase: OracleCase, run: RunArtifacts): CaseVerdict {
  const result = run.results.find((r) => r.caseId === oracleCase.id);
  const flags: string[] = [];

  if (result === undefined) {
    return { runId: run.runId, caseId: oracleCase.id, pass: false, expectedDisposition: 'DIRECT_ANSWER', actualDisposition: 'ERROR', primaryFailureStage: 'ENGINE_ERROR', diagnosticFlags: ['no engine result recorded'] };
  }
  if (result.actualDisposition === 'ERROR') {
    return { runId: run.runId, caseId: oracleCase.id, pass: false, expectedDisposition: 'DIRECT_ANSWER', actualDisposition: 'ERROR', primaryFailureStage: 'ENGINE_ERROR', diagnosticFlags: [result.errorMessage ?? 'unknown error'] };
  }

  const expectedRuleIds = new Set(oracleCase.expectedRuleIds);
  const allExtractedRuleIds = ruleIdsOf([...run.sourceRuleIdByUnitId.keys()], run.sourceRuleIdByUnitId);
  const candidateRuleIds = result.retrieval ? ruleIdsOf(result.retrieval.candidatesBeforeRerank, run.sourceRuleIdByUnitId) : new Set<number>();
  const topKRuleIds = result.retrieval ? ruleIdsOf(result.retrieval.topK, run.sourceRuleIdByUnitId) : new Set<number>();
  const selectedRuleIds = result.resolution ? ruleIdsOf(result.resolution.selected, run.sourceRuleIdByUnitId) : new Set<number>();

  const missingFromExtraction = [...expectedRuleIds].filter((r) => !allExtractedRuleIds.has(r));
  const missingFromCandidates = [...expectedRuleIds].filter((r) => allExtractedRuleIds.has(r) && !candidateRuleIds.has(r));
  const missingFromTopK = [...expectedRuleIds].filter((r) => candidateRuleIds.has(r) && !topKRuleIds.has(r));
  const missingFromSelected = [...expectedRuleIds].filter((r) => topKRuleIds.has(r) && !selectedRuleIds.has(r));

  if (missingFromExtraction.length > 0) flags.push(`EXTRACTION_MISS: rule(s) ${missingFromExtraction.join(',')} never extracted this run`);
  if (missingFromCandidates.length > 0) flags.push(`RETRIEVAL_MISS: rule(s) ${missingFromCandidates.join(',')} extracted but never entered the candidate pool`);
  if (missingFromTopK.length > 0) flags.push(`RERANK_MISS: rule(s) ${missingFromTopK.join(',')} in candidate pool but not top-K after rerank`);
  if (missingFromSelected.length > 0) flags.push(`APPLICABILITY/RESOLUTION: rule(s) ${missingFromSelected.join(',')} in top-K but not selected`);

  const group = EVIDENCE_GROUPS_BY_RULE[oracleCase.expectedRuleIds[0]] ?? undefined;
  let evidenceGroupUncovered: readonly string[] = [];
  if (group !== undefined && result.resolution) {
    const selectedUnits = result.resolution.selected
      .map((id) => run.units.find((u) => u.unitId === id))
      .filter((u): u is PersistedKnowledgeUnit => u !== undefined);
    const coverage = evaluateEvidenceGroupCoverage(group, selectedUnits);
    if (!coverage.covered) {
      evidenceGroupUncovered = coverage.uncoveredClauseDescriptions;
      flags.push(`EVIDENCE_GROUP_UNCOVERED (rule ${group.ruleId}): ${coverage.uncoveredClauseDescriptions.join('; ')}`);
    }
  }

  let primaryFailureStage: FailureStage = 'NONE';
  if (missingFromExtraction.length > 0) primaryFailureStage = 'EXTRACTION_MISS';
  else if (missingFromCandidates.length > 0) primaryFailureStage = 'RETRIEVAL_MISS';
  else if (missingFromTopK.length > 0) primaryFailureStage = 'RERANK_MISS';
  else if (missingFromSelected.length > 0 || evidenceGroupUncovered.length > 0) primaryFailureStage = 'RESOLUTION_ERROR';
  else if (result.actualDisposition === 'HOLD') primaryFailureStage = 'UNEXPECTED_HOLD';
  else if (result.verification && !result.verification.verified) {
    primaryFailureStage = 'SYNTHESIS_ERROR';
    flags.push(...result.verification.violations.map((v) => `${v.code}: ${v.detail}`));
  }

  const ruleCoverageOk = missingFromExtraction.length === 0 && missingFromCandidates.length === 0 && missingFromTopK.length === 0 && missingFromSelected.length === 0 && evidenceGroupUncovered.length === 0;
  const pass = ruleCoverageOk && result.actualDisposition === 'DIRECT_ANSWER' && (result.verification?.verified ?? false);

  return { runId: run.runId, caseId: oracleCase.id, pass, expectedDisposition: 'DIRECT_ANSWER', actualDisposition: result.actualDisposition, primaryFailureStage, diagnosticFlags: flags };
}

function gradeNegativeCase(neg: NegativeCaseApplicabilityOracle, run: RunArtifacts): CaseVerdict {
  const result = run.results.find((r) => r.caseId === neg.id);
  const flags: string[] = [];

  if (result === undefined) {
    return { runId: run.runId, caseId: neg.id, pass: false, expectedDisposition: neg.expectedDisposition, actualDisposition: 'ERROR', primaryFailureStage: 'ENGINE_ERROR', diagnosticFlags: ['no engine result recorded (question text missing from oracle cross-reference)'] };
  }
  if (result.actualDisposition === 'ERROR') {
    return { runId: run.runId, caseId: neg.id, pass: false, expectedDisposition: neg.expectedDisposition, actualDisposition: 'ERROR', primaryFailureStage: 'ENGINE_ERROR', diagnosticFlags: [result.errorMessage ?? 'unknown error'] };
  }

  const candidateRuleIds = result.retrieval ? ruleIdsOf(result.retrieval.candidatesBeforeRerank, run.sourceRuleIdByUnitId) : new Set<number>();
  const selectedRuleIds = result.resolution ? ruleIdsOf(result.resolution.selected, run.sourceRuleIdByUnitId) : new Set<number>();

  let primaryFailureStage: FailureStage = 'NONE';
  let ok = true;

  if (neg.requiredCandidateRuleIds) {
    const missing = neg.requiredCandidateRuleIds.filter((r) => !candidateRuleIds.has(r));
    if (missing.length > 0) {
      ok = false;
      primaryFailureStage = 'RETRIEVAL_MISS';
      flags.push(`required candidate rule(s) ${missing.join(',')} never entered candidate pool — "не нашёл" неотличимо от "не применил"`);
    }
  }
  if (neg.requiredSelectedRuleIds) {
    const missing = neg.requiredSelectedRuleIds.filter((r) => !selectedRuleIds.has(r));
    if (missing.length > 0) {
      ok = false;
      if (primaryFailureStage === 'NONE') primaryFailureStage = 'RESOLUTION_ERROR';
      flags.push(`required selected rule(s) ${missing.join(',')} not selected`);
    }
  }
  if (neg.forbiddenSelectedRuleIds) {
    const wronglySelected = neg.forbiddenSelectedRuleIds.filter((r) => selectedRuleIds.has(r));
    if (wronglySelected.length > 0) {
      ok = false;
      primaryFailureStage = 'APPLICABILITY_ERROR';
      flags.push(`forbidden rule(s) ${wronglySelected.join(',')} were selected — narrow exception applied where it should not`);
    }
  }

  if (result.actualDisposition !== neg.expectedDisposition) {
    ok = false;
    if (neg.expectedDisposition === 'HOLD' && result.actualDisposition === 'DIRECT_ANSWER') {
      primaryFailureStage = 'EXPECTED_CLARIFICATION_MISSED';
      flags.push('expected HOLD/clarify, engine answered directly — the dangerous false-positive case');
    } else if (neg.expectedDisposition === 'DIRECT_ANSWER' && result.actualDisposition === 'HOLD') {
      primaryFailureStage = 'UNEXPECTED_HOLD';
      flags.push('expected a direct answer, engine held unexpectedly');
    }
  }

  if (neg.expectedMissingTriggerFacts && result.resolution) {
    const named = new Set(result.resolution.clarificationNeeds.triggerFacts);
    const unnamed = neg.expectedMissingTriggerFacts.filter((f) => !named.has(f));
    if (unnamed.length > 0) {
      ok = false;
      flags.push(`engine did not name missing trigger fact(s): ${unnamed.join(', ')}`);
    }
  }
  if (neg.expectedReasonCodes && result.resolution) {
    const actual = new Set(result.resolution.reasons);
    const missing = neg.expectedReasonCodes.filter((c) => !actual.has(c));
    if (missing.length > 0) {
      ok = false;
      flags.push(`missing expected reason code(s): ${missing.join(', ')}`);
    }
  }

  return { runId: run.runId, caseId: neg.id, pass: ok, expectedDisposition: neg.expectedDisposition, actualDisposition: result.actualDisposition, primaryFailureStage, diagnosticFlags: flags };
}

async function main() {
  const { inDir, outPath } = parseArgs(process.argv.slice(2));

  const positiveOracle = loadSemanticRuleOracle();
  const negativeOracle = loadNegativeCaseOracle();

  const summary = JSON.parse(readFileSync(path.join(inDir, 'run-summary.json'), 'utf8')) as { runIds: readonly string[] };
  const runDirs = readdirSync(inDir).filter((d) => summary.runIds.includes(d));

  const allVerdicts: CaseVerdict[] = [];
  for (const runId of summary.runIds) {
    const run = loadRunArtifacts(path.join(inDir, runId), runId);
    for (const c of positiveOracle) allVerdicts.push(gradePositiveCase(c, run));
    for (const n of negativeOracle) allVerdicts.push(gradeNegativeCase(n, run));
  }

  const byRun = new Map<string, CaseVerdict[]>();
  for (const v of allVerdicts) {
    const list = byRun.get(v.runId) ?? [];
    list.push(v);
    byRun.set(v.runId, list);
  }

  const perRunSummary = [...byRun.entries()].map(([runId, verdicts]) => ({
    runId,
    positivePassed: verdicts.filter((v) => v.expectedDisposition === 'DIRECT_ANSWER' && positiveOracle.some((c) => c.id === v.caseId) && v.pass).length,
    positiveTotal: positiveOracle.length,
    negativePassed: verdicts.filter((v) => negativeOracle.some((n) => n.id === v.caseId) && v.pass).length,
    negativeTotal: negativeOracle.length,
  }));

  const casesFailingInAnyRun = [...new Set(allVerdicts.filter((v) => !v.pass).map((v) => v.caseId))].sort();
  const passRateByCase = [...new Set(allVerdicts.map((v) => v.caseId))].map((caseId) => {
    const verdictsForCase = allVerdicts.filter((v) => v.caseId === caseId);
    return { caseId, passCount: verdictsForCase.filter((v) => v.pass).length, totalRuns: verdictsForCase.length };
  });

  const report = {
    gradedAt: new Date().toISOString(),
    runDirs,
    perRunSummary,
    passRateByCase,
    casesFailingInAnyRun,
    allVerdicts,
    note: 'Deterministic grading only — no LLM semantic judge this session (see final report for that gap).',
  };

  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(perRunSummary, null, 2));
  console.log(`\nCases failing in ANY run: ${casesFailingInAnyRun.join(', ') || '(none)'}`);
  console.log(`\nFull report: ${outPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('FATAL ERROR:', err);
    process.exit(1);
  });
}
