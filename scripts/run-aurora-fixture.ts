/**
 * Evaluation-only end-to-end benchmark runner (goal shift 2026-08-09).
 *
 * DOCX -> extraction (unreviewed) -> EvaluationKnowledgeSnapshot -> embed ->
 * for each question: QueryFrame -> retrieval -> applicability -> resolution
 * -> synthesis -> verification -> ActualDisposition. Grading against the
 * oracle happens ONLY after the full engine trace exists for every question
 * (`runEngineOnQuestion` below never receives anything from the oracle
 * except the question TEXT — never expectedAnswer/expectedRuleIds/
 * matchReason/reasonCodes). This is the "true end-to-end benchmark" goal
 * shift: no human review, no ReviewedKnowledgeSnapshot, no waiting.
 *
 * ORACLE HANDLING. This script legitimately reads the oracle (same
 * allowlisted role as scripts/run-eval-corpus.ts / scripts/test-extraction-
 * pack.ts, per oracle-isolation.test.ts's comments) — it is NOT in
 * ORACLE_BLIND_SCRIPTS and never will be, because it must load
 * expected_rule_ids/expected_answer to grade. The discipline instead is
 * DATA-FLOW: every artifact the engine itself consumes (QueryFrame
 * extraction messages, retrieval candidate text, synthesis prompt) is run
 * through `OracleTaintDetector.assertClean()` before use, so a leak would
 * throw immediately rather than silently inflate the score.
 *
 * Usage:
 *   npx tsx scripts/run-aurora-fixture.ts --mode=e2e --extraction-runs=2 --out=path/to/dir [--doc=path/to/source.docx]
 */
import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import {
  extractCanonicalDocument,
  toSourceBlockLocation,
} from '../src/lib/knowledge/docx-canonical-blocks';
import {
  extractKnowledgeUnits,
  type ExtractKnowledgeUnitsOptions,
  type ExtractKnowledgeUnitsResult,
  type SourceBlock,
} from '../src/lib/knowledge/knowledge-unit-extractor';
import {
  EXTRACTION_UNCERTAINTY_KINDS,
  extractedKnowledgeUnitSchema,
  type ExtractedKnowledgeUnit,
} from '../src/lib/knowledge/applicability/extraction';
import { validateParentRefs } from '../src/lib/knowledge/applicability/extraction-parent-refs';
import { triggerFactCatalog } from '../src/lib/knowledge/prompt-catalogs';
import {
  FOCUSED_REPAIR_MAX_ROUNDS,
  extractFocusedRepairUnits,
  extractKnowledgeUnitsWithCompletenessAudit,
  type FocusedRepairOptions,
  type FocusedRetryLog,
} from '../src/lib/knowledge/audited-extraction';
import type { BatchExtractionLog, BatchExtractor } from '../src/lib/knowledge/batch-extraction';
import {
  auditBlockCoverage,
  coverageAuditNeedsReview,
  type AuditBlockCoverageOptions,
  type BlockCoverageAuditResult,
} from '../src/lib/knowledge/extraction-coverage-auditor';
import { quoteSpansOverlap } from '../src/lib/knowledge/quote-locator';
import {
  ChatCompletionError,
  isRetryableChatCompletionError,
  type ChatMessage,
  type CompletionAttempt,
  type Provider,
} from '../src/lib/ai/chat-provider';
import {
  CostBudgetExceededError,
  CostLedger,
  PaidCallBudgetExceededError,
  UnverifiableCostError,
} from '../src/lib/ai/cost-ledger';
import {
  attributeAttemptCosts,
  CallTraceLog,
  type CallTraceCorrelation,
  type CallTraceEntry,
} from '../src/lib/ai/call-trace-log';
import {
  assignIdentity,
  type IdentityAssignmentResult,
  type PersistedKnowledgeUnit,
  type SourceBlockLocation,
} from '../src/lib/knowledge/applicability/identity-assignment';
import { buildRetrievalText } from '../src/lib/knowledge/applicability/retrieval-text';
import {
  embedCandidates,
  retrievalContractProbe,
  retrieveUnits,
  type EmbeddedCandidate,
  type RetrievalResult,
} from '../src/lib/knowledge/semantic-retrieval';
import { OpenAIEmbeddingProvider } from '../src/lib/ai/embedding-provider';
import { buildRerankPromptMessages, LlmRerankerProvider, rerankResponseSchema } from '../src/lib/ai/reranker-provider';
import { buildExtractionMessages, extractQueryFrame } from '../src/lib/knowledge/query-frame-extractor';
import { buildQueryFrame, rawQueryExtractionSchema, type ConversationMessage } from '../src/lib/knowledge/applicability/query-frame-builder';
import type { QueryFrame } from '../src/lib/knowledge/applicability/query-frame';
import { buildEvaluatedCandidates, effectiveTriggerInheritanceBehaviorProbe } from '../src/lib/eval/knowledge-unit-adapter';
import { resolveKnowledgeSet, type ResolutionDecision } from '../src/lib/knowledge/applicability/resolution';
import {
  applyDecisionRelevanceGate,
  buildBatchDecisionRelevancePromptMessages,
  batchDecisionRelevanceResponseSchema,
  evaluateDecisionRelevanceBatch,
  evaluateChallengeCounterfactuals,
  type DecisionRelevanceBatchTelemetry,
  type GateCandidateInput,
  type GatedCandidate,
} from '../src/lib/knowledge/applicability/decision-relevance';
import {
  buildChallengeCompatibilityMessages,
  challengeCompatibilityResponseSchema,
  resolveProbabilisticExclusionSafety,
  selectChallengeRecoveryCandidates,
  verifyChallengesAfterBasicVerification,
  type ChallengeCompatibilityDecision,
} from '../src/lib/knowledge/synthesis/challenge-compatibility';
import {
  buildEvidencePack,
  overriddenParentContextBehaviorProbe,
  type EvidencePack,
} from '../src/lib/knowledge/synthesis/evidence-pack';
import {
  synthesizeFromSelectedUnits,
  type AnswerGenerator,
  type SynthesisPrompt,
} from '../src/lib/knowledge/synthesis/synthesize';
import type { DraftAnswer } from '../src/lib/knowledge/synthesis/draft-answer';
import {
  internalReferenceLeakPolicyProbe,
  verifyAnswerClaims,
  type VerificationResult,
} from '../src/lib/knowledge/synthesis/verify-answer-claims';
import {
  buildConditionPreservationMessages,
  conditionPreservationResponseSchema,
  conditionedEvidenceOf,
  mergeConditionPreservationVerification,
  verifyConditionsAfterBasicVerification,
  type ConditionPreservationDecision,
} from '../src/lib/knowledge/synthesis/condition-preservation';
import { resolveExtractionRunConfig } from '../src/lib/ai/extraction-run';
import { PaidStructuredSemanticError, structured, StructuredOutputError } from '../src/lib/ai/structured-output';
import type { RequestContext } from '../src/lib/knowledge/applicability/eligibility';

import { buildEvaluationSnapshot, type EvaluationKnowledgeSnapshot } from '../src/lib/eval/evaluation-snapshot';
import { resolveAnswerDisposition, type EngineAnswerDisposition } from '../src/lib/eval/answer-disposition';
import {
  buildExtractionArtifact,
  computePipelineProbes,
  readExtractionArtifact,
  restoreEmbeddedCandidates,
  writeExtractionArtifact,
  EXTRACTION_ARTIFACT_VERSION,
  type ExtractionArtifact,
  type ExtractionAttemptLog,
  type ExtractionFingerprint,
} from '../src/lib/eval/extraction-artifact';
import {
  buildRawExtractionFingerprint,
  RawExtractionCheckpointStore,
} from '../src/lib/eval/raw-extraction-checkpoint';
import { buildQuestionJournalFingerprint, QuestionResultJournal } from '../src/lib/eval/question-result-journal';
import { computeQuestionBehaviorProbes } from '../src/lib/eval/question-behavior-probes';
import {
  buildDependencyGraphArtifact,
  buildDependencyGraphArtifactFingerprint,
  loadCompatibleDependencyGraphArtifact,
  writeDependencyGraphArtifact,
  type DependencyGraphArtifactConfig,
} from '../src/lib/eval/dependency-graph-artifact';
import {
  createDependencyGraph,
  expandDependencyClosure,
  hydrateDependencyGraph,
  serializeDependencyGraph,
  type DependencyGraph,
  type DependencyGraphDocument,
} from '../src/lib/knowledge/dependency-graph';
import {
  buildAuditedDependencyGraph,
  dependencyAuditSchema,
  dependencyGraphBuilderContractProbe,
  dependencyGraphSchema,
  FileDependencyGraphCheckpoint,
  type DependencyGraphStage,
} from '../src/lib/knowledge/dependency-graph-builder';
import { loadSemanticRuleOracle, ORACLE_PACK_DIR, SOURCE_DOCX_FILENAME } from '../src/lib/eval/semantic-rule-oracle';
import { loadNegativeCaseOracle } from '../src/lib/eval/negative-case-oracle';
import { loadSourceRulesFromDocx, type SourceRule } from '../src/lib/eval/source-rule-segmentation';
import { resolveSourceRuleId } from '../src/lib/eval/source-rule-mapping';
import {
  assertOracleTaintPolicy,
  buildOracleTaintDetector,
  ORACLE_TAINT_POLICY_VERSION,
  oracleTaintPolicyBehaviorProbe,
  OracleTaintError,
  type OracleTaintDetector,
} from '../src/lib/eval/oracle-taint';

// ─────────────────────────────────── CLI ────────────────────────────────────

const SUPPORTED_MODES = ['e2e'] as const;
type Mode = (typeof SUPPORTED_MODES)[number];
const ENGINE_PROFILES = ['quality', 'balanced', 'economy'] as const;
type EngineProfile = (typeof ENGINE_PROFILES)[number];
const DEPENDENCY_GRAPH_STAGE_VALUES = ['required', 'skip'] as const;
/** CLI-facing `--dependency-graph` value. Deliberately NOT named
 *  `DependencyGraphStage` -- that identifier is already imported from
 *  dependency-graph-builder.ts for the proposer/auditor/repairer call shape;
 *  unrelated concepts that happen to share a word. */
type DependencyGraphStageArg = (typeof DEPENDENCY_GRAPH_STAGE_VALUES)[number];

interface CliArgs {
  readonly mode: Mode;
  readonly extractionRuns: number;
  readonly outDir: string;
  readonly docPath: string;
  readonly batchSize: number;
  readonly maxCostUsd: number;
  readonly maxPaidCalls: number;
  /** Model for question-frame/reranker/relevance/synthesis only. Extraction
   * remains pinned independently in the reusable artifact fingerprint. */
  readonly questionModel?: string;
  readonly questionProvider?: Provider;
  readonly engineProfile: EngineProfile;
  /** `required` (default) runs the dependency-graph stage exactly as today.
   *  `skip` is an explicit, auditable measurement override: `ensureDependencyGraph`
   *  short-circuits BEFORE any provider call to an empty-edge graph, so only
   *  retrieval seeds reach the candidate pool. Never the default, never read
   *  from an env var (unlike --engine-profile above) -- one explicit switch
   *  only. See run-summary.json's dependencyGraphStage for how a skipped run
   *  stays distinguishable from a real measurement. */
  readonly dependencyGraphStage: DependencyGraphStageArg;
  /** Путь к сохранённому артефакту извлечения. Задан — фаза извлечения не
   *  делает НИ ОДНОГО платного вызова (см. `--reuse-extraction` ниже);
   *  `undefined` — сегодняшнее поведение, свежее извлечение. */
  readonly reuseExtraction?: string;
}

export const DEPENDENCY_CLOSURE_BOUNDS = { maxUnits: 64, maxDepth: 6 } as const;

export interface DependencyExpansion {
  readonly retrievalSeedUnitIds: readonly string[];
  readonly expandedUnitIds: readonly string[];
  /** Units reached through only TRUSTED REQUIRES/CO_REQUIRED edges. */
  readonly trustedMandatoryUnitIds: readonly string[];
}

/** Expands retrieval before probabilistic relevance. Alternatives enter the
 * candidate pool but remain classifier-controlled; mandatory dependencies
 * are protected from a probabilistic drop. Any bound hit fails closed. */
export function expandRetrievedDependencies(
  retrievalSeedUnitIds: readonly string[],
  graph: DependencyGraph,
  bounds: { readonly maxUnits: number; readonly maxDepth: number } = DEPENDENCY_CLOSURE_BOUNDS
): DependencyExpansion {
  const seeds = [...new Set(retrievalSeedUnitIds)];
  const complete = expandDependencyClosure(graph, seeds, bounds);
  if (complete.truncated) {
    throw new Error(
      `Dependency closure exceeded bounds maxUnits=${bounds.maxUnits}, maxDepth=${bounds.maxDepth}; refusing incomplete retrieval.`
    );
  }

  const mandatory = new Set<string>();
  for (const seed of seeds) {
    const closure = expandDependencyClosure(graph, [seed], {
      ...bounds,
      relations: ['REQUIRES', 'CO_REQUIRED'],
    });
    if (closure.truncated) {
      throw new Error(
        `Mandatory dependency closure exceeded bounds maxUnits=${bounds.maxUnits}, maxDepth=${bounds.maxDepth}; refusing incomplete retrieval.`
      );
    }
    for (const entry of closure.entries) {
      if (entry.depth > 0) mandatory.add(entry.unitId);
    }
  }

  const expandedUnitIds = [...seeds];
  const seen = new Set(seeds);
  for (const entry of complete.entries) {
    if (seen.has(entry.unitId)) continue;
    seen.add(entry.unitId);
    expandedUnitIds.push(entry.unitId);
  }
  return {
    retrievalSeedUnitIds: seeds,
    expandedUnitIds,
    trustedMandatoryUnitIds: expandedUnitIds.filter((unitId) => mandatory.has(unitId)),
  };
}

export function dependencyGraphQuestionFingerprint(
  dependencyGraphArtifactContentDigest: string,
  dependencyGraph: DependencyGraph
): unknown {
  return {
    dependencyGraphArtifactContentDigest,
    dependencyGraphFingerprint: dependencyGraph.fingerprint,
    bounds: DEPENDENCY_CLOSURE_BOUNDS,
    traversal: expandDependencyClosure.toString(),
    retrievalExpansion: expandRetrievedDependencies.toString(),
  };
}

const USAGE =
  'Usage: npx tsx scripts/run-aurora-fixture.ts --mode=e2e --extraction-runs=N --out=path/to/dir --max-cost-usd=N --max-paid-calls=N [--engine-profile=quality|balanced|economy] [--question-provider=anthropic|openai] [--question-model=MODEL] [--doc=path/to/source.docx] [--batch-size=N]';

export function parseArgs(argv: readonly string[]): CliArgs {
  // Опции со значением проверяются по префиксу, голые флаги — ТОЧНЫМ
  // совпадением. Раньше `--fresh-extraction` был в общем списке префиксов, и
  // `--fresh-extraction=false` проходил проверку «неизвестных аргументов», но
  // не совпадал с флагом — то есть молча игнорировался и запускал ПЛАТНЫЙ
  // свежий прогон. Подтверждено живьём (кросс-аудит 2026-08-10): вызов дошёл
  // до реального обращения к API.
  const knownOptions = [
    '--mode=',
    '--extraction-runs=',
    '--out=',
    '--doc=',
    '--batch-size=',
    '--max-cost-usd=',
    '--max-paid-calls=',
    '--question-model=',
    '--question-provider=',
    '--engine-profile=',
    '--reuse-extraction=',
    '--dependency-graph=',
  ];
  const knownFlags = ['--fresh-extraction'];
  const unknown = argv.filter(
    (a) => !knownOptions.some((k) => a.startsWith(k)) && !knownFlags.includes(a)
  );
  if (unknown.length > 0) {
    throw new Error(`Неизвестные аргументы: ${unknown.join(', ')}\n${USAGE}`);
  }

  const modeArg = argv.find((a) => a.startsWith('--mode='))?.slice('--mode='.length);
  const runsArg = argv.find((a) => a.startsWith('--extraction-runs='))?.slice('--extraction-runs='.length);
  const outArg = argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
  const docArg = argv.find((a) => a.startsWith('--doc='))?.slice('--doc='.length);
  const batchSizeArg = argv.find((a) => a.startsWith('--batch-size='))?.slice('--batch-size='.length);
  const maxCostUsdArg = argv.find((a) => a.startsWith('--max-cost-usd='))?.slice('--max-cost-usd='.length);
  const maxPaidCallsArg = argv.find((a) => a.startsWith('--max-paid-calls='))?.slice('--max-paid-calls='.length);
  const questionModelArg = argv.find((a) => a.startsWith('--question-model='))?.slice('--question-model='.length);
  const questionProviderArg = argv.find((a) => a.startsWith('--question-provider='))?.slice('--question-provider='.length);
  const engineProfileRaw = (
    argv.find((a) => a.startsWith('--engine-profile='))?.slice('--engine-profile='.length) ??
    process.env.AURORA_ENGINE_PROFILE ??
    'quality'
  ).trim().toLowerCase();
  const reuseArg = argv.find((a) => a.startsWith('--reuse-extraction='))?.slice('--reuse-extraction='.length);
  const freshFlag = argv.includes('--fresh-extraction');
  // Дефолт 'required' НЕ читается из env (в отличие от AURORA_ENGINE_PROFILE
  // выше) — намеренно один явный флаг и ни одного скрытого способа его
  // выставить (см. docstring CliArgs.dependencyGraphStage).
  const dependencyGraphStageRaw = (
    argv.find((a) => a.startsWith('--dependency-graph='))?.slice('--dependency-graph='.length) ?? 'required'
  ).trim().toLowerCase();

  // Взаимоисключающие по смыслу — молча предпочесть один другому значило бы
  // сделать не то, что просили, на платном прогоне.
  if (reuseArg && freshFlag) {
    throw new Error(`--reuse-extraction и --fresh-extraction взаимоисключающи.\n${USAGE}`);
  }
  if (reuseArg !== undefined && reuseArg.length === 0) {
    throw new Error(`--reuse-extraction требует путь к артефакту.\n${USAGE}`);
  }
  if (questionModelArg !== undefined && questionModelArg.trim().length === 0) {
    throw new Error(`--question-model требует непустой model ID.\n${USAGE}`);
  }
  const questionProviderRaw = (questionProviderArg ?? process.env.AURORA_QUESTION_PROVIDER)?.trim().toLowerCase();
  const questionModelRaw = (questionModelArg ?? process.env.AURORA_QUESTION_MODEL)?.trim();
  if (questionProviderRaw !== undefined && questionProviderRaw !== 'anthropic' && questionProviderRaw !== 'openai') {
    throw new Error(`--question-provider принимает anthropic|openai, получено "${questionProviderRaw}".\n${USAGE}`);
  }
  if (!(ENGINE_PROFILES as readonly string[]).includes(engineProfileRaw)) {
    throw new Error(`--engine-profile принимает ${ENGINE_PROFILES.join('|')}, получено "${engineProfileRaw}".\n${USAGE}`);
  }
  if (!(DEPENDENCY_GRAPH_STAGE_VALUES as readonly string[]).includes(dependencyGraphStageRaw)) {
    throw new Error(`--dependency-graph принимает ${DEPENDENCY_GRAPH_STAGE_VALUES.join('|')}, получено "${dependencyGraphStageRaw}".\n${USAGE}`);
  }
  if ((questionProviderRaw === undefined) !== (questionModelRaw === undefined)) {
    throw new Error(`question-stage override требует одновременно provider и model.\n${USAGE}`);
  }

  if (!modeArg || !outArg) {
    throw new Error(`--mode и --out обязательны.\n${USAGE}`);
  }
  if (!(SUPPORTED_MODES as readonly string[]).includes(modeArg)) {
    throw new Error(`Неподдержанный режим "${modeArg}". Поддержан только: ${SUPPORTED_MODES.join(', ')}.`);
  }

  // ОБЯЗАТЕЛЕН (Task 38, 2026-08-10) — явное требование после дня с $19.79
  // непроверенного спенда: "ни один следующий paid benchmark run не
  // запускается, если система заранее не печатает... dollar ceiling".
  // Дефолта нет НАМЕРЕННО: дефолт легко забыть переопределить и вернуться к
  // тому же непроверенному расходу, который и вызвал это требование.
  if (!maxCostUsdArg) {
    throw new Error(`--max-cost-usd обязателен — запуск не начнётся без явного потолка расходов.\n${USAGE}`);
  }
  const maxCostUsd = Number(maxCostUsdArg);
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
    throw new Error(`--max-cost-usd обязан быть положительным числом, получено "${maxCostUsdArg}".\n${USAGE}`);
  }
  if (!maxPaidCallsArg) {
    throw new Error(`--max-paid-calls обязателен — запуск не начнётся без жёсткого потолка платных вызовов.\n${USAGE}`);
  }
  const maxPaidCalls = Number(maxPaidCallsArg);
  if (!Number.isInteger(maxPaidCalls) || maxPaidCalls < 1) {
    throw new Error(`--max-paid-calls обязан быть положительным целым, получено "${maxPaidCallsArg}".\n${USAGE}`);
  }

  const extractionRuns = runsArg ? Number(runsArg) : 2;
  if (!Number.isInteger(extractionRuns) || extractionRuns < 1) {
    throw new Error(`--extraction-runs обязан быть положительным целым, получено "${runsArg}".\n${USAGE}`);
  }

  // Дефолт 4 -- достаточно мал, чтобы модель не "устала" на длинной генерации
  // и не забыла хвост документа (реальный наблюдённый провал: whole-document
  // вызов дал 28/10 правил, а в другом прогоне — 18/4), достаточно велик,
  // чтобы группировать несколько соседних блоков в одном вызове.
  const batchSize = batchSizeArg ? Number(batchSizeArg) : 4;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`--batch-size обязан быть положительным целым, получено "${batchSizeArg}".\n${USAGE}`);
  }

  return {
    mode: modeArg as Mode,
    extractionRuns,
    outDir: outArg,
    docPath: docArg ?? path.join(ORACLE_PACK_DIR, SOURCE_DOCX_FILENAME),
    batchSize,
    maxCostUsd,
    maxPaidCalls,
    ...(questionModelRaw && {
      questionModel: questionModelRaw,
    }),
    ...(questionProviderRaw && { questionProvider: questionProviderRaw as Provider }),
    engineProfile: engineProfileRaw as EngineProfile,
    dependencyGraphStage: dependencyGraphStageRaw as DependencyGraphStageArg,
    ...(reuseArg !== undefined && { reuseExtraction: reuseArg }),
  };
}

// ──────────────────────────── engine input/output ────────────────────────────

/** Ровно то, что engine видит про один вопрос. Никогда не расширять
 *  oracle-полями (expectedAnswer/expectedRuleIds/matchReason/reasonCodes) —
 *  это единственная защита от утечки помимо runtime taint-проверки. */
interface EngineQuestionInput {
  readonly caseId: string;
  readonly question: string;
}

interface EngineQuestionResult {
  readonly caseId: string;
  readonly question: string;
  readonly queryFrame: QueryFrame | null;
  readonly retrieval: RetrievalResult | null;
  readonly resolution: ResolutionDecision | null;
  readonly evidencePack: EvidencePack | null;
  readonly draft: DraftAnswer | null;
  readonly verification: VerificationResult | null;
  /** См. `resolveAnswerDisposition` (src/lib/eval/answer-disposition.ts) —
   *  в частности, почему провал верификации получает СВОЙ `UNVERIFIED_ANSWER`,
   *  а не понижается до `HOLD`. */
  readonly actualDisposition: EngineAnswerDisposition;
  readonly errorMessage: string | null;
  /** True iff `errorMessage` is a transport/schema failure class the caller
   *  may legitimately retry (same classification as batch-extraction's own
   *  retry policy) — false for a genuine engine bug or a taint trip, which
   *  must never be silently retried away. */
  readonly errorRetryable: boolean;
  /** Every retrieval candidate with its Decision Relevance Gate verdict —
   *  the full trace the architectural review requires for debugging real
   *  company documents later (§6): which candidates were filtered before
   *  ever reaching resolution, and why. `null` only if the pipeline never
   *  reached retrieval (a real engine error before that point). */
  readonly decisionRelevanceTrace: readonly GatedCandidate[] | null;
  /** unitId исключений, снятых ИСКЛЮЧИТЕЛЬНО вердиктом LLM-классификатора
   *  (`DecisionRelevanceGateResult.droppedByClassifier`, W1-D). Персистится
   *  отдельным полем, а не выводится из `decisionRelevanceTrace`: по трейсу
   *  видно, что вердикт был IRRELEVANT, но не видно, был ли он ЕДИНСТВЕННЫМ
   *  основанием снятия — а именно это поле и существует ради подсчёта по
   *  СОХРАНЁННЫМ прогонам, без повторного платного запуска. Не записать его
   *  здесь значило бы оставить ту гарантию наблюдаемой только в рантайме. */
  readonly decisionRelevanceDroppedByClassifier: readonly string[] | null;
  /** True means the answer path depended on an LLM-only IRRELEVANT verdict
   * and therefore may not be delivered as DIRECT_ANSWER. */
  readonly answerDependsOnProbabilisticExclusion: boolean | null;
  readonly challengeCompatibility: readonly ChallengeCompatibilityDecision[] | null;
  readonly probabilisticExclusionBlockingUnitIds: readonly string[] | null;
  readonly conditionPreservation: readonly ConditionPreservationDecision[] | null;
  readonly conditionPreservationBlockingUnitIds: readonly string[] | null;
  /** Retrieval seeds plus deterministic graph expansion used by the gate. */
  readonly dependencyExpansion: DependencyExpansion | null;
  readonly engineProvider: Provider;
  readonly engineModel: string;
  readonly engineProfile: EngineProfile;
}

interface EngineContext {
  readonly runId: string;
  readonly engineProfile: EngineProfile;
  readonly embeddedCandidates: readonly EmbeddedCandidate[];
  readonly unitsById: ReadonlyMap<string, PersistedKnowledgeUnit>;
  readonly dependencyGraph: DependencyGraph;
  readonly embeddingProvider: OpenAIEmbeddingProvider;
  readonly rerankerProvider: LlmRerankerProvider;
  readonly requestContext: RequestContext;
  readonly reviewedAt: string;
  readonly queryFrameRunConfig: ReturnType<typeof resolveExtractionRunConfig>;
  readonly answerGeneratorForCase: (caseId: string) => AnswerGenerator;
  readonly recoveryAnswerGeneratorForCase: (caseId: string) => AnswerGenerator;
  readonly decisionRelevanceRunConfig: ReturnType<typeof resolveExtractionRunConfig>;
  readonly challengeCompatibilityRunConfig: ReturnType<typeof resolveExtractionRunConfig>;
  readonly conditionPreservationRunConfig: ReturnType<typeof resolveExtractionRunConfig>;
  readonly recoveryChallengeCompatibilityRunConfig: ReturnType<typeof resolveExtractionRunConfig>;
  readonly recoveryConditionPreservationRunConfig: ReturnType<typeof resolveExtractionRunConfig>;
  readonly taintDetector: OracleTaintDetector;
  readonly ledger: CostLedger;
  readonly traceLog: CallTraceLog;
}

/**
 * Same classification everywhere a bounded retry decision is made in this
 * file: transport/schema failure classes are retryable, anything else is a
 * real bug and must surface immediately, never silently retried away.
 */
export function classifyStructuredError(error: unknown): ExtractionAttemptLog['outcome'] {
  if (error instanceof StructuredOutputError) {
    return error.reason === 'SCHEMA_MISMATCH'
      ? 'SCHEMA_MISMATCH'
      : error.reason === 'TRUNCATED_JSON'
        ? 'TRUNCATED_JSON'
        : 'OTHER_ERROR';
  }
  return error instanceof ChatCompletionError && isRetryableChatCompletionError(error)
    ? 'NETWORK_ERROR'
    : 'OTHER_ERROR';
}

/**
 * Both failure classes `classifyStructuredError` distinguishes carry the
 * REAL underlying attempts (incl. token usage) on the error object itself —
 * a SCHEMA_MISMATCH means the HTTP call succeeded and cost real tokens, only
 * local JSON validation failed afterward. `null` for any other error class
 * (a genuine bug, not a priced provider round-trip).
 */
function attemptsFromError(error: unknown): readonly CompletionAttempt[] | null {
  if (error instanceof StructuredOutputError) return error.attempts;
  if (error instanceof ChatCompletionError) return error.attempts;
  if (error instanceof PaidStructuredSemanticError) return error.attempts;
  return null;
}

/** Request/response half of one `CallTraceEntry` — everything except the
 *  bookkeeping fields (`timestamp`/`purpose`/`provider`/`model`/`outcome`/
 *  `errorMessage`) that the caller already knows or derives separately. */
type TraceInfo = Pick<CallTraceEntry, 'requestMessages' | 'responseText'>;

/**
 * Trace counterpart to `attemptsFromError` — same two failure classes, same
 * reasoning for why `ChatCompletionError` carries no response text: it means
 * NEITHER the primary provider NOR the fallback ever answered, so there is
 * no raw response to show, only the prompt that was sent. A SCHEMA_MISMATCH/
 * TRUNCATED_JSON (`StructuredOutputError`) is the opposite case and the one
 * that matters most for debugging — the HTTP call succeeded, so
 * `error.result.rawText` is a REAL, if invalid, response sitting right next
 * to `error.result.requestMessages`. This is exactly the pairing that would
 * have made the Task 36 43/43 SCHEMA_MISMATCH root cause obvious immediately.
 */
function traceFromError(error: unknown): TraceInfo | null {
  if (error instanceof StructuredOutputError) {
    return {
      requestMessages: error.result.requestMessages ?? [],
      responseText: error.result.rawText ?? null,
    };
  }
  if (error instanceof ChatCompletionError) {
    return { requestMessages: error.requestMessages ?? [], responseText: null };
  }
  if (error instanceof PaidStructuredSemanticError) {
    return { requestMessages: error.requestMessages, responseText: error.responseText };
  }
  return null;
}

/** Single point that shapes a `CallTraceEntry` and hands it to the log —
 *  provider/model come from the LAST attempt (the one that actually
 *  produced this outcome), not from a separately-threaded field, so a
 *  fallback that switched provider/model mid-call is still traced honestly. */
function recordTrace(
  traceLog: CallTraceLog,
  purpose: string,
  attempts: readonly CompletionAttempt[],
  trace: TraceInfo,
  outcome: 'SUCCESS' | 'ERROR',
  errorMessage: string | null,
  correlation: CallTraceCorrelation
): void {
  const last = attempts[attempts.length - 1];
  traceLog.record({
    callId: randomUUID(),
    correlation,
    timestamp: new Date().toISOString(),
    purpose,
    provider: last?.provider ?? 'unknown',
    model: last?.model ?? 'unknown',
    outcome,
    attempts: attributeAttemptCosts(attempts),
    requestMessages: trace.requestMessages,
    responseText: trace.responseText,
    errorMessage,
  });
}

/** Single reconciliation point for the one batched Decision Relevance call:
 * the same attempts feed both trace and ledger exactly once. */
export function recordDecisionRelevanceTelemetry(
  ledger: CostLedger,
  traceLog: CallTraceLog,
  telemetry: DecisionRelevanceBatchTelemetry,
  correlation: CallTraceCorrelation
): void {
  recordTrace(
    traceLog,
    'decision-relevance',
    telemetry.attempts,
    { requestMessages: telemetry.requestMessages, responseText: telemetry.responseText },
    'SUCCESS',
    null,
    correlation
  );
  ledger.record('decision-relevance', telemetry.attempts);
}

export function recordEmbeddingAttempt(
  purpose: 'corpus-embedding' | 'query-embedding',
  ledger: CostLedger,
  traceLog: CallTraceLog,
  attempt: CompletionAttempt,
  texts: readonly string[],
  correlation: CallTraceCorrelation
): void {
  recordTrace(
    traceLog,
    purpose,
    [attempt],
    { requestMessages: [{ role: 'user', content: `[embedding batch: ${texts.length} text(s)]` }], responseText: null },
    attempt.outcome === 'SUCCESS' ? 'SUCCESS' : 'ERROR',
    attempt.outcome === 'SUCCESS' ? null : attempt.errorCode ?? `HTTP ${attempt.statusCode ?? 'transport error'}`,
    correlation
  );
  ledger.record(purpose, [attempt]);
}

/**
 * Counterpart to `withStructuredRetry`'s catch-path discipline, for the
 * three call sites that don't go through it: query-frame, reranker, and
 * synthesis are each a SINGLE un-retried `structured()` call inside
 * `runEngineOnQuestion` — retried only as a whole QUESTION by
 * `runEngineOnQuestionWithRetry`, not internally. Without this, a
 * SCHEMA_MISMATCH here (a real, billed provider attempt) was invisible to
 * both the ledger and the trace — same bug class `withStructuredRetry`
 * itself was fixed for in 095feb0, just at three sites that predated this
 * helper existing (Codex review, 2026-08-10, finding 2). Trace is recorded
 * before the ledger for the same reason as `withStructuredRetry` (finding 5):
 * `ledger.record()` can itself throw (budget), and the tripping call must
 * still land in call-trace.jsonl.
 */
export async function recordOnFailure<T>(
  purpose: string,
  ledger: CostLedger,
  traceLog: CallTraceLog,
  correlation: CallTraceCorrelation,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const failedAttempts = attemptsFromError(error);
    const failedTrace = traceFromError(error);
    if (failedAttempts && failedTrace) {
      const message = error instanceof Error ? error.message : String(error);
      recordTrace(traceLog, purpose, failedAttempts, failedTrace, 'ERROR', message, correlation);
    }
    if (failedAttempts) ledger.record(purpose, failedAttempts);
    throw error;
  }
}

/**
 * Same bounded retry class as scripts/run-extraction.ts's
 * extractKnowledgeUnitsWithRetry — structured() deliberately doesn't retry
 * SCHEMA_MISMATCH/TRUNCATED_JSON itself (caller's decision per its own
 * docstring), and this is the caller. Retries on schema/transport failure
 * classes only, never to "fish" for a more favorable extraction — every
 * attempt (including failures) is logged, and this run is recorded as a
 * failure if maxAttempts is exhausted (Step 3 of the goal-shift spec: don't
 * silently retry beyond the bounded transport/schema policy).
 *
 * Generic over any single structured() call (extraction batch, coverage
 * audit, ...) — the classification/retry policy is identical, only the
 * underlying call and its log label differ. A real full-benchmark run
 * (full-smoke4, 2026-08-09) crashed the whole run on a single transient
 * "fetch failed" INSIDE the coverage-audit step specifically, because that
 * call had no retry wrapper at all while the extraction call did — this
 * generalization closes that gap instead of duplicating the same
 * classification logic a second time for the auditor call.
 *
 * OWNS ledger recording for every attempt this loop sees, success or
 * failure (Task 38 fix, 2026-08-10): a prior version recorded only the
 * final successful attempt, so every retried-away SCHEMA_MISMATCH/
 * NETWORK_ERROR attempt's real token cost — the exact failure mode behind
 * 43/43 identical schema failures earlier this session — was invisible to
 * the ledger. A dollar ceiling built on that undercount could never
 * actually trip at the real spend.
 *
 * OWNS call-trace recording the same way, for the same reason (2026-08-10):
 * a retried-away SCHEMA_MISMATCH has a real raw response sitting right next
 * to the prompt that produced it — exactly the pairing that would have
 * shortened the Task 36 investigation. `getTrace` mirrors `getAttempts`:
 * caller-supplied because `T` differs per call site (`ExtractKnowledgeUnitsResult`
 * nests its `StructuredResult` under `.structuredResult`; `BlockCoverageAuditResult`
 * carries `requestMessages`/`rawResponseText` directly).
 */
export async function withStructuredRetry<T>(
  call: () => Promise<T>,
  maxAttempts: number,
  label: string,
  ledger: CostLedger,
  traceLog: CallTraceLog,
  purpose: string,
  getAttempts: (result: T) => readonly CompletionAttempt[],
  getTrace: (result: T) => TraceInfo,
  correlation: CallTraceCorrelation
): Promise<{ result: T; attemptLog: ExtractionAttemptLog[] }> {
  const attemptLog: ExtractionAttemptLog[] = [];
  let previousSchemaFailureSignature: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await call();
      attemptLog.push({ attempt, outcome: 'SUCCESS', message: null });
      const attempts = getAttempts(result);
      // Trace BEFORE ledger (Codex review, 2026-08-10, finding 5): ledger.record()
      // can throw (budget ceiling / unverifiable cost) — the call that trips it
      // must still land in call-trace.jsonl, not vanish because the throw cut
      // the function off before the trace line ran.
      recordTrace(traceLog, purpose, attempts, getTrace(result), 'SUCCESS', null, correlation);
      ledger.record(purpose, attempts);
      return { result, attemptLog };
    } catch (error) {
      const outcome = classifyStructuredError(error);
      const retryable = outcome !== 'OTHER_ERROR';
      const message = error instanceof Error ? error.message : String(error);
      attemptLog.push({ attempt, outcome, message });
      const failedAttempts = attemptsFromError(error);
      const failedTrace = traceFromError(error);
      if (failedAttempts && failedTrace) {
        recordTrace(traceLog, purpose, failedAttempts, failedTrace, 'ERROR', message, correlation);
      }
      if (failedAttempts) ledger.record(purpose, failedAttempts);
      console.warn(`[${label} attempt ${attempt}/${maxAttempts}] failed (${outcome}): ${message}`);
      // A second response with the same schema issue shape is evidence of a
      // deterministic prompt/schema incompatibility, not transport noise.
      // Give schema repair one fresh sample, then stop paying for identical
      // failures. Different signatures and transient transport failures keep
      // the existing bounded retry policy.
      if (error instanceof StructuredOutputError && error.reason === 'SCHEMA_MISMATCH') {
        const signature = JSON.stringify(
          error.issues.map((issue) => ({ path: issue.path, code: issue.code })).sort((a, b) =>
            `${a.path}:${a.code}`.localeCompare(`${b.path}:${b.code}`)
          )
        );
        if (signature === previousSchemaFailureSignature) throw error;
        previousSchemaFailureSignature = signature;
      } else {
        previousSchemaFailureSignature = null;
      }
      if (!retryable || attempt === maxAttempts) throw error;
    }
  }
  throw new Error(`withStructuredRetry(${label}): unreachable`);
}

async function extractKnowledgeUnitsWithRetry(
  options: ExtractKnowledgeUnitsOptions,
  maxAttempts: number,
  ledger: CostLedger,
  traceLog: CallTraceLog,
  correlation: CallTraceCorrelation
): Promise<{ result: ExtractKnowledgeUnitsResult; attemptLog: ExtractionAttemptLog[] }> {
  return withStructuredRetry(
    () => extractKnowledgeUnits(options),
    maxAttempts,
    'extraction',
    ledger,
    traceLog,
    'extraction',
    (r) => r.structuredResult.attempts,
    (r) => ({
      requestMessages: r.structuredResult.requestMessages ?? [],
      responseText: r.structuredResult.rawText ?? null,
    }),
    correlation
  );
}

/** Observed counterpart of the compact finding-scoped repair call. It uses
 * the same bounded retry, paid-call reservation (from options.runConfig),
 * cost ledger and request/response trace contract as normal extraction. */
export async function extractFocusedRepairUnitsWithRetry(
  options: FocusedRepairOptions,
  maxAttempts: number,
  ledger: CostLedger,
  traceLog: CallTraceLog,
  correlation: CallTraceCorrelation,
  call: (options: FocusedRepairOptions) => Promise<ExtractKnowledgeUnitsResult> = extractFocusedRepairUnits
): Promise<{ result: ExtractKnowledgeUnitsResult; attemptLog: ExtractionAttemptLog[] }> {
  return withStructuredRetry(
    () => call(options),
    maxAttempts,
    'focused repair',
    ledger,
    traceLog,
    'focused-repair',
    (result) => result.structuredResult.attempts,
    (result) => ({
      requestMessages: result.structuredResult.requestMessages ?? [],
      responseText: result.structuredResult.rawText ?? null,
    }),
    correlation
  );
}

export interface TaintResampleLog {
  readonly blockAnchor: string;
  readonly round: number;
}

export interface MalformedExceptionFinding {
  readonly unitId: string;
  readonly blockAnchor: string;
  readonly missingFields: readonly ('parentRuleRef' | 'triggerCondition')[];
}

export interface ExceptionRepairLog {
  readonly blockAnchor: string;
  readonly round: number;
  readonly malformed: readonly MalformedExceptionFinding[];
}

export interface ExceptionRepairOptions extends Omit<ExtractKnowledgeUnitsOptions, 'blocks'> {
  readonly block: SourceBlock;
  readonly malformed: readonly MalformedExceptionFinding[];
}

export const exceptionRepairResponseSchema = z.strictObject({
  units: z.array(extractedKnowledgeUnitSchema).readonly(),
});

const EXCEPTION_REPAIR_SYSTEM_PROMPT = `Ты заново извлекаешь ВСЕ единицы знания из одного блока, потому что предыдущее извлечение создало структурно неполные EXCEPTION_RULE.

Верни полный replacement для блока, не только исправленные units.
kind — СТРОГО одно из: "PROCEDURE_STEP", "EXCEPTION_RULE", "TERM_DEFINITION", "DELIVERY_RULE", "PRICE_RULE".
Каждый unit обязан иметь ТОЧНО эту объектную форму (без дополнительных ключей):
{"kind":"PROCEDURE_STEP","statement":"...","facets":{},"triggerCondition":null,"numericConstraint":null,"extractionRef":"u1","parentExtractionRef":null,"sourceSpan":{"anchor":"ДАННЫЙ_ANCHOR","quote":"ДОСЛОВНАЯ ЦИТАТА"},"evidenceByField":{"statement":{"anchor":"ДАННЫЙ_ANCHOR","quote":"ДОСЛОВНАЯ ЦИТАТА"}},"uncertainties":[]}
Ключи id, type, content и evidence ЗАПРЕЩЕНЫ. Не переименовывай kind/statement/sourceSpan/evidenceByField в эти или другие альтернативы.
facets — объект допустимых фасет, не массив. triggerCondition — null либо {"all":[{"fact":"helperPresent","equals":true}]}.
В triggerCondition разрешён ТОЛЬКО этот единый каталог фактов и значений:
${triggerFactCatalog({ booleanAsJsonLiteral: true })}
Никаких других fact нет. Каталогизированное условие ОБЯЗАНО быть в triggerCondition у unit ЛЮБОГО kind, включая PROCEDURE_STEP и TERM_DEFINITION; добавь для него evidenceByField.triggerCondition.
В частности, отсутствие/наличие ресурса, необходимого для действия (например, воды), — это КАТАЛОГИЗИРОВАННЫЙ trigger resourceAvailability (см. каталог выше), а НЕ UNRECOGNIZED_TRIGGER_CONDITION. Правило, которое заменяет базовый способ действия допустимой альтернативой при отсутствии ресурса («при отсутствии воды допустим кожный антисептик»), — EXCEPTION_RULE с parentExtractionRef на базовый unit и triggerCondition={"all":[{"fact":"resourceAvailability","equals":"UNAVAILABLE"}]}, а не PROCEDURE_STEP с prose-only условием.
numericConstraint — null либо {"factKey":"...","value":1,"unit":"..."}.
extractionRef каждого unit уникален в этом ответе. parentExtractionRef — null либо extractionRef ДРУГОГО существующего unit из этого же ответа.
sourceSpan и каждое evidenceByField.* — объекты {"anchor":"...","quote":"..."}; evidenceByField.statement обязателен, а evidence для facets/triggerCondition/numericConstraint обязателен, когда поле заполнено.
uncertainties — всегда массив объектов ТОЧНО формы {"kind":"ОДИН_ИЗ_РАЗРЕШЁННЫХ_KIND","description":"...","quote":"ДОСЛОВНАЯ ЦИТАТА"}; строки и произвольные объекты запрещены. uncertainty.kind — СТРОГО одно из: ${EXTRACTION_UNCERTAINTY_KINDS.map((kind) => `"${kind}"`).join(', ')}. Для самостоятельного условия, которого нет в trigger-каталоге, используй именно "UNRECOGNIZED_TRIGGER_CONDITION", не "OTHER".
Таксономия обязательна:
- настоящий EXCEPTION_RULE является оговоркой, изменяющей отдельное базовое правило, и обязан иметь parentExtractionRef на существующий unit этого же ответа и известный triggerCondition;
- самостоятельное условное действие (если X, сделать Y) — PROCEDURE_STEP, parentExtractionRef=null; если X выражается закрытым каталогом, triggerCondition обязателен, иначе triggerCondition=null и обязательна uncertainty kind=UNRECOGNIZED_TRIGGER_CONDITION с дословной цитатой X;
- поясняющая семантика или значение термина — TERM_DEFINITION, parentExtractionRef=null, triggerCondition=null.
Не сохраняй EXCEPTION_RULE без родителя или без известного triggerCondition. Не изобретай родителя либо trigger: переклассифицируй по функции текста.
Все sourceSpan/evidence quote должны быть дословными фрагментами исходного блока, а anchor должен точно совпадать с данным anchor.
Ответ СТРОГО JSON: {"units": [...]}`;

// The malformed-exception policy originally shared RawCheckpoint's focused
// repair contract. Keep its old digest component frozen so upgrading this
// prompt invalidates only the newly split exception-repair stages, not
// already-paid focused-repair calls.
const LEGACY_EXCEPTION_REPAIR_POLICY_FINGERPRINT =
  '8afd25c2324514d0573c5d419852122c2f03e27686d853d8933d902e383893bd';

export function findMalformedExceptions(
  units: readonly PersistedKnowledgeUnit[]
): MalformedExceptionFinding[] {
  return units.flatMap((unit) => {
    if (unit.kind !== 'EXCEPTION_RULE') return [];
    const missingFields: ('parentRuleRef' | 'triggerCondition')[] = [];
    if (unit.parentRuleRef === null) missingFields.push('parentRuleRef');
    if (unit.triggerCondition === null) missingFields.push('triggerCondition');
    return missingFields.length === 0
      ? []
      : [{ unitId: unit.unitId, blockAnchor: unit.sourceSpan.anchor, missingFields }];
  });
}

export function buildExceptionRepairPromptMessages(
  options: Pick<ExceptionRepairOptions, 'block' | 'malformed'>
): ChatMessage[] {
  const defects = options.malformed.map((finding) => ({
    malformedUnitRef: finding.unitId,
    missingFields: finding.missingFields,
  }));
  return [
    { role: 'system', content: EXCEPTION_REPAIR_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Anchor: ${options.block.anchor}\n\nИсходный блок:\n${options.block.text}\n\nСтруктурные дефекты предыдущего результата:\n${JSON.stringify(defects)}\n\nВерни полный исправленный replacement этого блока.`,
    },
  ];
}

export function exceptionRepairPolicyFingerprint(): string {
  return createHash('sha256').update(JSON.stringify(buildExceptionRepairPromptMessages({
    block: { anchor: '__probe__', text: '__source__' },
    malformed: [{
      unitId: '__unit__',
      blockAnchor: '__probe__',
      missingFields: ['parentRuleRef', 'triggerCondition'],
    }],
  })), 'utf8').digest('hex');
}

export async function extractExceptionRepairUnits(
  options: ExceptionRepairOptions
): Promise<ExtractKnowledgeUnitsResult> {
  const structuredResult = await structured<{ units: readonly ExtractedKnowledgeUnit[] }>({
    schema: exceptionRepairResponseSchema,
    messages: buildExceptionRepairPromptMessages(options),
    runConfig: options.runConfig,
    ...(options.maxTokens !== undefined && { maxTokens: options.maxTokens }),
    ...(options.temperature !== undefined && { temperature: options.temperature }),
    ...(options.signal && { signal: options.signal }),
  });
  return { units: validateParentRefs(structuredResult.data.units), structuredResult };
}

interface TaintResampleCheckpoint {
  loadTaintExtraction(round: number, block: SourceBlock): readonly ExtractedKnowledgeUnit[] | undefined;
  saveTaintExtraction(round: number, block: SourceBlock, units: readonly ExtractedKnowledgeUnit[]): void;
  loadTaintAudit(round: number, options: AuditBlockCoverageOptions): BlockCoverageAuditResult | undefined;
  saveTaintAudit(round: number, options: AuditBlockCoverageOptions, result: BlockCoverageAuditResult): void;
}

interface ExceptionRepairCheckpoint {
  loadExceptionRepair(round: number, block: SourceBlock, requestMessages: readonly ChatMessage[]): readonly ExtractedKnowledgeUnit[] | undefined;
  saveExceptionRepair(round: number, block: SourceBlock, requestMessages: readonly ChatMessage[], units: readonly ExtractedKnowledgeUnit[]): void;
  loadExceptionRepairAudit(round: number, options: AuditBlockCoverageOptions): BlockCoverageAuditResult | undefined;
  saveExceptionRepairAudit(round: number, options: AuditBlockCoverageOptions, result: BlockCoverageAuditResult): void;
}

/** Identity assignment may intentionally drop units whose evidence cannot be
 * resolved or whose stable id is ambiguous. That is useful diagnostic
 * behaviour, but a trusted extraction must never silently persist the
 * reduced set after coverage was audited against the pre-identity units. */
export function assertTrustedIdentity(
  identity: IdentityAssignmentResult,
  context: string
): void {
  if (identity.unresolvedEvidence.length === 0 && identity.ambiguousDuplicates.length === 0) return;
  throw new Error(
    `${context}: identity assignment is not trusted (` +
      `${identity.unresolvedEvidence.length} unresolved evidence, ` +
      `${identity.ambiguousDuplicates.length} ambiguous duplicate group(s))`
  );
}

/**
 * Targeted per-block resample when the retrieval-candidate taint check trips
 * — a cheaper first attempt than discarding the whole extraction run
 * (`runOneExtractionRunWithTaintRetry`'s whole-run auto-retry remains the
 * safety-net fallback, unchanged, if this doesn't converge). Session data
 * (2026-08-09) showed the two known false-positive collisions on this
 * fixture individually colliding often enough that even 6 whole-run
 * attempts sometimes exhaust (`full-smoke7`) — each whole-run attempt
 * re-extracts all 15 blocks and runs coverage audit on all 15 before even
 * reaching the taint check, when the actual problem is usually 1-2 blocks'
 * specific wording.
 *
 * Checks each retrieval candidate INDIVIDUALLY (`assertClean`'s per-string
 * check never compares across array items, so probing one candidate at a
 * time produces identical per-item verdicts to checking the whole batch at
 * once — same detection semantics, just localized) to find exactly which
 * unit(s) are tainted, re-extracts just their source block(s) fresh, and
 * REPLACES that block's units entirely — not additive like the focused-retry
 * completeness path: the old units are exactly what's tainted, there is
 * nothing to preserve alongside a fresh sample. Bounded rounds; if a round
 * still finds taint after resampling every affected block, it tries again
 * up to `maxRounds`, then returns whatever it has — the caller's own,
 * unchanged, authoritative final `assertClean` call is the real safety gate
 * and will throw if this didn't fully converge, falling back to the
 * existing whole-run retry exactly as before this function existed.
 */
export async function resolveTaintedCandidates(
  initialUnits: readonly PersistedKnowledgeUnit[],
  blocksByAnchor: ReadonlyMap<string, SourceBlockLocation>,
  sourceRevisionHash: string,
  taintDetector: OracleTaintDetector,
  extractor: BatchExtractor,
  auditor: (options: AuditBlockCoverageOptions) => Promise<BlockCoverageAuditResult>,
  optionsPerBatch: Omit<ExtractKnowledgeUnitsOptions, 'blocks'>,
  maxRounds: number,
  checkpoint?: TaintResampleCheckpoint
): Promise<{
  units: PersistedKnowledgeUnit[];
  resampleLogs: TaintResampleLog[];
  auditResults: BlockCoverageAuditResult[];
}> {
  let units = [...initialUnits];
  const resampleLogs: TaintResampleLog[] = [];
  const auditResults: BlockCoverageAuditResult[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const unitsById = new Map(units.map((u) => [u.unitId, u]));
    const candidates = units.map((u) => ({ unitId: u.unitId, retrievalText: buildRetrievalText(u, unitsById) }));

    const taintedUnitIds = new Set<string>();
    for (const candidate of candidates) {
      try {
        assertOracleTaintPolicy(taintDetector, 'ARTIFACT', [candidate], 'targeted taint probe');
      } catch (err) {
        if (!(err instanceof OracleTaintError)) throw err;
        taintedUnitIds.add(candidate.unitId);
      }
    }
    if (taintedUnitIds.size === 0) return { units, resampleLogs, auditResults };

    const affectedAnchors = new Set(
      units.filter((u) => taintedUnitIds.has(u.unitId)).map((u) => u.sourceSpan.anchor)
    );

    for (const anchor of affectedAnchors) {
      const block = blocksByAnchor.get(anchor);
      if (block === undefined) continue;

      const sourceBlock = { anchor: block.anchor, text: block.text, ...(block.kind !== undefined && { kind: block.kind }) };
      const restoredExtraction = checkpoint?.loadTaintExtraction(round, sourceBlock);
      const retryResult = restoredExtraction === undefined ? await extractor({
        ...optionsPerBatch,
        blocks: [sourceBlock],
      }) : { units: [...restoredExtraction], structuredResult: {} as never };
      if (restoredExtraction === undefined) checkpoint?.saveTaintExtraction(round, sourceBlock, retryResult.units);
      // Prefix extractionRef AND parentExtractionRef together, exactly like
      // resolveMalformedExceptions does just below (2026-08-12 live bug):
      // this used to force parentExtractionRef to null unconditionally, which
      // discarded a VALID same-response sibling link (validateParentRefs
      // inside `extractor` already resolves any parentExtractionRef to
      // another unit in this same batch, or nulls it as DANGLING_PARENT_REF —
      // there is no other kind of non-null value to receive here). Live
      // trace: the model correctly linked an EXCEPTION_RULE to its sibling
      // base rule within the same single-block response, and this line threw
      // that correct link away, which coverage-audit then (correctly) flagged
      // as a malformed exception with a missing parent — a defect the code
      // itself introduced, not the model.
      const taintRetryPrefix = `taint-retry-${anchor}-`;
      const namespaced = retryResult.units.map((u) => ({
        ...u,
        extractionRef: `${taintRetryPrefix}${u.extractionRef}`,
        parentExtractionRef: u.parentExtractionRef === null ? null : `${taintRetryPrefix}${u.parentExtractionRef}`,
      }));

      // A taint retry replaces every unit for the block, so the previous
      // coverage verdict no longer says anything about the replacement.
      // Audit the exact replacement before it can enter a trusted snapshot.
      const taintAuditOptions: AuditBlockCoverageOptions = {
        blockAnchor: block.anchor,
        blockText: block.text,
        ...(block.kind !== undefined && { blockKind: block.kind }),
        extractedStatements: namespaced.map((u) => ({
          kind: u.kind,
          statement: u.statement,
          quote: u.sourceSpan.quote,
          extractionRef: u.extractionRef,
          parentExtractionRef: u.parentExtractionRef,
          triggerCondition: u.triggerCondition,
          numericConstraint: u.numericConstraint,
          uncertainties: u.uncertainties,
        })),
        runConfig: optionsPerBatch.runConfig,
      };
      const restoredAudit = checkpoint?.loadTaintAudit(round, taintAuditOptions);
      const audit = restoredAudit ?? await auditor(taintAuditOptions);
      if (restoredAudit === undefined) checkpoint?.saveTaintAudit(round, taintAuditOptions, audit);
      auditResults.push(audit);
      if (coverageAuditNeedsReview(audit)) {
        throw new Error(
          `targeted taint resample: replacement for block "${anchor}" did not pass coverage audit`
        );
      }

      const identity = assignIdentity(namespaced, blocksByAnchor, sourceRevisionHash);
      assertTrustedIdentity(identity, `targeted taint resample for block "${anchor}"`);
      units = [...units.filter((u) => u.sourceSpan.anchor !== anchor), ...identity.units];
      // Parent ids are derived data. Replacing a block may remove a parent
      // that an unaffected unit referenced; never retain that stale edge.
      const liveIds = new Set(units.map((u) => u.unitId));
      units = units.map((u) =>
        u.parentRuleRef !== null && !liveIds.has(u.parentRuleRef)
          ? { ...u, parentRuleRef: null }
          : u
      );
      resampleLogs.push({ blockAnchor: anchor, round });
    }
  }

  return { units, resampleLogs, auditResults };
}

/** Bounded structural repair before the trusted-artifact boundary. Each
 * affected block is replaced wholesale, then coverage and identity are
 * re-proven for the exact replacement. */
export async function resolveMalformedExceptions(
  initialUnits: readonly PersistedKnowledgeUnit[],
  blocksByAnchor: ReadonlyMap<string, SourceBlockLocation>,
  sourceRevisionHash: string,
  repairExtractor: (options: ExceptionRepairOptions) => Promise<ExtractKnowledgeUnitsResult>,
  auditor: (options: AuditBlockCoverageOptions) => Promise<BlockCoverageAuditResult>,
  optionsPerCall: Omit<ExtractKnowledgeUnitsOptions, 'blocks'>,
  maxRounds: number,
  checkpoint?: ExceptionRepairCheckpoint
): Promise<{
  units: PersistedKnowledgeUnit[];
  repairLogs: ExceptionRepairLog[];
  auditResults: BlockCoverageAuditResult[];
}> {
  let units = [...initialUnits];
  const repairLogs: ExceptionRepairLog[] = [];
  const auditResults: BlockCoverageAuditResult[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const malformed = findMalformedExceptions(units);
    if (malformed.length === 0) return { units, repairLogs, auditResults };
    const byAnchor = new Map<string, MalformedExceptionFinding[]>();
    for (const finding of malformed) {
      byAnchor.set(finding.blockAnchor, [...(byAnchor.get(finding.blockAnchor) ?? []), finding]);
    }

    for (const [anchor, blockFindings] of byAnchor) {
      const block = blocksByAnchor.get(anchor);
      if (!block) throw new Error(`malformed exception repair: block "${anchor}" not found`);
      const sourceBlock: SourceBlock = {
        anchor: block.anchor,
        text: block.text,
        ...(block.kind !== undefined && { kind: block.kind }),
      };
      const repairOptions: ExceptionRepairOptions = {
        ...optionsPerCall,
        block: sourceBlock,
        malformed: blockFindings,
      };
      const repairMessages = buildExceptionRepairPromptMessages(repairOptions);
      const restored = checkpoint?.loadExceptionRepair(round, sourceBlock, repairMessages);
      const result = restored === undefined
        ? await repairExtractor(repairOptions)
        : { units: [...restored], structuredResult: {} as never };
      if (restored === undefined) checkpoint?.saveExceptionRepair(round, sourceBlock, repairMessages, result.units);

      const prefix = `exception-repair-${round}-${anchor}-`;
      const namespaced = result.units.map((unit) => ({
        ...unit,
        extractionRef: `${prefix}${unit.extractionRef}`,
        parentExtractionRef:
          unit.parentExtractionRef === null ? null : `${prefix}${unit.parentExtractionRef}`,
      }));
      const auditOptions: AuditBlockCoverageOptions = {
        blockAnchor: block.anchor,
        blockText: block.text,
        ...(block.kind !== undefined && { blockKind: block.kind }),
        extractedStatements: namespaced.map((unit) => ({
          kind: unit.kind,
          statement: unit.statement,
          quote: unit.sourceSpan.quote,
          extractionRef: unit.extractionRef,
          parentExtractionRef: unit.parentExtractionRef,
          triggerCondition: unit.triggerCondition,
          numericConstraint: unit.numericConstraint,
          uncertainties: unit.uncertainties,
        })),
        runConfig: optionsPerCall.runConfig,
      };
      const restoredAudit = checkpoint?.loadExceptionRepairAudit(round, auditOptions);
      const audit = restoredAudit ?? await auditor(auditOptions);
      if (restoredAudit === undefined) checkpoint?.saveExceptionRepairAudit(round, auditOptions, audit);
      auditResults.push(audit);
      if (coverageAuditNeedsReview(audit)) {
        throw new Error(`malformed exception repair: replacement for block "${anchor}" did not pass coverage audit`);
      }

      const identity = assignIdentity(namespaced, blocksByAnchor, sourceRevisionHash);
      assertTrustedIdentity(identity, `malformed exception repair for block "${anchor}"`);
      units = [...units.filter((unit) => unit.sourceSpan.anchor !== anchor), ...identity.units];
      const liveIds = new Set(units.map((unit) => unit.unitId));
      units = units.map((unit) =>
        unit.parentRuleRef !== null && !liveIds.has(unit.parentRuleRef)
          ? { ...unit, parentRuleRef: null }
          : unit
      );
      repairLogs.push({ blockAnchor: anchor, round, malformed: blockFindings });
    }
  }

  const remaining = findMalformedExceptions(units);
  if (remaining.length > 0) {
    throw new Error(
      `malformed exception repair did not converge after ${maxRounds} round(s): ` +
        remaining.map((finding) => `${finding.unitId}[${finding.missingFields.join(',')}]`).join('; ')
    );
  }
  return { units, repairLogs, auditResults };
}

const answerSchema = z.strictObject({
  text: z.string(),
  citedUnitIds: z.array(z.string()).readonly(),
});

/**
 * Label for the upstream decision-relevance rationale rendered per evidence
 * item (Fix 3, 2026-08-11 — threading `decisionRelevance.trace[].relevance.
 * reason` through so synthesis does not have to re-derive a bridging
 * judgement an earlier stage already made). Deliberately given BOTH an
 * inline self-explanatory label here AND a dedicated system-prompt sentence
 * below — the same double-reinforcement OVERRIDDEN_PARENT_CONTEXT gets
 * (inline "РОЛЬ:" line + its own system sentence), because both are status
 * distinctions the model must not blur: this text explains why a unit was
 * included, it is never itself a fact the answer may state or cite.
 */
const RELEVANCE_RATIONALE_LABEL = 'ПОМЕТКА ПРЕДЫДУЩЕГО ЭТАПА (служебная, не текст источника)';

/**
 * Fix 3 (2026-08-11): carries the classifier's OWN rationale for why a unit
 * is relevant into synthesis, instead of letting synthesis re-derive a
 * bridging judgement an earlier stage already made and explained (root cause
 * of the Q08 refusal-while-holding-the-answer failure).
 *
 * Only RELEVANT/CONDITIONALLY_RELEVANT entries qualify — an IRRELEVANT
 * verdict must never be rendered as if it were a positive relevance
 * rationale, even for a unit that ends up in the evidence pack through a
 * different, deterministic path (e.g. an INACTIVE-trigger unit kept as
 * negative evidence, or a challenge candidate promoted by recovery). Pulled
 * out as its own pure, exported function — rather than left inline at the
 * call site — specifically so this filtering rule has a unit test that does
 * not require a paid call or the full engine pipeline.
 */
export function buildRelevanceRationaleByUnitId(
  trace: readonly GatedCandidate[]
): ReadonlyMap<string, string> {
  return new Map(
    trace
      .filter((entry) => entry.relevance.verdict !== 'IRRELEVANT')
      .map((entry) => [entry.unitId, entry.relevance.reason] as const)
  );
}

/**
 * Pure prompt builder — no network call. Exported so tests can assert on the
 * exact rendered prompt without a paid completion (mirrors
 * `buildExceptionRepairPromptMessages` elsewhere in this file). Also fed into
 * `buildQuestionJournalFingerprint` below via `.toString()`: THIS function,
 * not `buildRealAnswerGenerator`, is what must change identity whenever the
 * synthesis prompt's behavior changes.
 */
export function buildRealAnswerPromptMessages(prompt: SynthesisPrompt): ChatMessage[] {
  const evidenceText = prompt.evidence
    .map((e) => `[${e.unitId}] ${e.statement}${e.numericConstraint ? ` (${e.numericConstraint.factKey}: ${e.numericConstraint.value} ${e.numericConstraint.unit})` : ''}${(e.presentationConditions?.length ?? 0) > 0 ? `\nУСЛОВИЯ ПРИМЕНИМОСТИ: ${e.presentationConditions!.map((condition) => `"${condition}"`).join('; ')}` : ''}${e.applicabilityMode === 'NEGATIVE' ? '\nРЕЖИМ: условие достоверно НЕ выполнено; используй правило только как основание для отказа/отрицания, никогда как разрешение.' : e.applicabilityMode === 'CONDITIONAL' ? '\nРЕЖИМ: условие неизвестно; правило можно сообщить только как явно условную ветку, никогда как безусловное разрешение.' : ''}${e.relevanceRationale ? `\n${RELEVANCE_RATIONALE_LABEL}: "${e.relevanceRationale}"` : ''}`)
    .join('\n');
  const supportingContextText = prompt.supportingContext
    .map((e) =>
      `[${e.unitId}] ${e.statement}${e.numericConstraint ? ` (${e.numericConstraint.factKey}: ${e.numericConstraint.value} ${e.numericConstraint.unit})` : ''}\n` +
      `РОЛЬ: OVERRIDDEN_PARENT_CONTEXT — это НЕ действующее правило. Оно переопределено выбранным исключением [${e.overriddenByUnitId}]. ` +
      `Разрешено использовать только его дополнительные процедурные детали, не противоречащие [${e.overriddenByUnitId}]; выбранное исключение всегда имеет приоритет. ` +
      `Если ответ использует этот контекст, citedUnitIds обязан включать и [${e.unitId}], и [${e.overriddenByUnitId}].`
    )
    .join('\n');
  return [
    {
      role: 'system',
      content:
        'Ты отвечаешь на вопрос СТРОГО на основе перечисленных unit\'ов знания — не добавляй ничего от себя. ' +
        'citedUnitIds обязан перечислять id ровно тех unit\'ов, на утверждениях которых построен ответ. ' +
        'OVERRIDDEN_PARENT_CONTEXT никогда не является самостоятельным разрешением или запретом: выбранное исключение имеет безусловный приоритет, и контекст всегда цитируется вместе с ним. ' +
        'Каждое УСЛОВИЕ ПРИМЕНИМОСТИ явно привяжи к соответствующему правилу; условное правило запрещено подавать как безусловное. ' +
        'Каждый перечисленный ниже unit уже прошёл проверку релевантности на предыдущем этапе конвейера — не отказывайся отвечать фразой вида «в предоставленных данных нет ответа», если хотя бы один unit отвечает на вопрос по существу, пусть и другими словами, чем в вопросе; это не отменяет обязанность сослаться на использованный unit в citedUnitIds. ' +
        'Если УСЛОВИЯ ПРИМЕНИМОСТИ одного правила перечисляют несколько альтернатив через «либо»/«или», ответ обязан назвать все альтернативы этого правила — пропускать часть перечня запрещено, даже если вопрос назвал лишь некоторые из них; формулировку можно менять, смысл каждой альтернативы — нет. ' +
        `Строка «${RELEVANCE_RATIONALE_LABEL}» у unit'а — объяснение предыдущего этапа конвейера, почему unit сочли относящимся к вопросу: это не факт документа, и ссылаться на неё как на источник или приводить её в тексте ответа запрещено. ` +
        `${prompt.answerTextPolicy} ` +
        'Ответ СТРОГО JSON: {"text": "...", "citedUnitIds": ["..."]}',
    },
    {
      role: 'user',
      content:
        `Вопрос: "${prompt.question}"\n\nДействующее выбранное знание:\n${evidenceText}` +
        (supportingContextText.length > 0
          ? `\n\nНеоперативный контекст переопределённых прямых родителей:\n${supportingContextText}`
          : ''),
    },
  ];
}

function buildRealAnswerGenerator(
  runConfig: ReturnType<typeof resolveExtractionRunConfig>,
  ledger: CostLedger,
  traceLog: CallTraceLog,
  runId: string,
  caseId: string,
  engineProfile: EngineProfile,
  purpose = 'synthesis'
): AnswerGenerator {
  return async (prompt) => {
    const correlation: CallTraceCorrelation = {
      runId, stage: purpose, caseId, engineProvider: runConfig.provider, engineModel: runConfig.model,
      engineProfile,
    };
    const result = await recordOnFailure(purpose, ledger, traceLog, correlation, () =>
      structured({
        schema: answerSchema,
        messages: buildRealAnswerPromptMessages(prompt),
        runConfig,
      })
    );
    recordTrace(
      traceLog,
      purpose,
      result.attempts,
      { requestMessages: result.requestMessages ?? [], responseText: result.rawText ?? null },
      'SUCCESS',
      null,
      correlation
    );
    ledger.record(purpose, result.attempts);
    return { text: result.data.text, citedUnitIds: result.data.citedUnitIds };
  };
}

/**
 * Единственная функция, которой разрешено касаться движка. Вход — ровно
 * `{caseId, question}`, ничего из oracle. `taintDetector.assertClean` бежит
 * на каждом артефакте ПЕРЕД тем, как он уходит дальше по пайплайну —
 * машинная проверка того же правила, которое `EngineQuestionInput`
 * утверждает типом.
 */
async function runEngineOnQuestion(
  input: EngineQuestionInput,
  ctx: EngineContext
): Promise<EngineQuestionResult> {
  const base = {
    caseId: input.caseId,
    question: input.question,
    engineProvider: ctx.queryFrameRunConfig.provider,
    engineModel: ctx.queryFrameRunConfig.model,
    engineProfile: ctx.engineProfile,
  };
  try {
    const message: ConversationMessage = { id: `${input.caseId}-q`, role: 'user', text: input.question };
    assertOracleTaintPolicy(ctx.taintDetector, 'ENGINE_INPUT', [message], `engine input (QueryFrame messages, ${input.caseId})`);

    const queryCorrelation: CallTraceCorrelation = {
      runId: ctx.runId, stage: 'query-frame', caseId: input.caseId,
      engineProvider: ctx.queryFrameRunConfig.provider, engineModel: ctx.queryFrameRunConfig.model,
      engineProfile: ctx.engineProfile,
    };
    const { queryFrame, structuredResult: queryFrameResult } = await recordOnFailure(
      'query-frame',
      ctx.ledger,
      ctx.traceLog,
      queryCorrelation,
      () => extractQueryFrame({ messages: [message], runConfig: ctx.queryFrameRunConfig })
    );
    recordTrace(
      ctx.traceLog,
      'query-frame',
      queryFrameResult.attempts,
      { requestMessages: queryFrameResult.requestMessages ?? [], responseText: queryFrameResult.rawText ?? null },
      'SUCCESS',
      null,
      queryCorrelation
    );
    ctx.ledger.record('query-frame', queryFrameResult.attempts);

    const rerankerCorrelation: CallTraceCorrelation = {
      runId: ctx.runId, stage: 'reranker', caseId: input.caseId,
      engineProvider: ctx.queryFrameRunConfig.provider, engineModel: ctx.queryFrameRunConfig.model,
      engineProfile: ctx.engineProfile,
    };
    const retrieval = await recordOnFailure('reranker', ctx.ledger, ctx.traceLog, rerankerCorrelation, () =>
      retrieveUnits(input.question, ctx.embeddedCandidates, {
        embeddingProvider: ctx.embeddingProvider,
        rerankerProvider: ctx.rerankerProvider,
      })
    );
    const rerankerAttempts = ctx.rerankerProvider.drainAttempts();
    recordTrace(ctx.traceLog, 'reranker', rerankerAttempts, ctx.rerankerProvider.drainTrace(), 'SUCCESS', null, rerankerCorrelation);
    ctx.ledger.record('reranker', rerankerAttempts);

    const dependencyExpansion = expandRetrievedDependencies(retrieval.topK, ctx.dependencyGraph);
    const trustedMandatoryUnitIds = new Set(dependencyExpansion.trustedMandatoryUnitIds);
    const candidateUnits = dependencyExpansion.expandedUnitIds
      .map((id) => ctx.unitsById.get(id))
      .filter((u): u is PersistedKnowledgeUnit => u !== undefined);
    const evaluatedCandidates = buildEvaluatedCandidates(
      candidateUnits,
      ctx.unitsById,
      queryFrame,
      ctx.requestContext,
      ctx.reviewedAt
    );

    // Decision Relevance Gate (architectural correction, 2026-08-09): a
    // retrieval top-K candidate no longer automatically gains the right to
    // influence resolveKnowledgeSet purely by topical adjacency. See
    // decision-relevance.ts's module docstring for the full rationale.
    const gateInputs: GateCandidateInput[] = candidateUnits.map((u, i) => ({
      evaluated: evaluatedCandidates[i],
      statement: u.statement,
      quote: u.sourceSpan.quote,
      trustedMandatoryDependency: trustedMandatoryUnitIds.has(u.unitId),
    }));
    const { result: decisionRelevance } = await withStructuredRetry(
      () => applyDecisionRelevanceGate(
        gateInputs,
        input.question,
        ctx.decisionRelevanceRunConfig,
        evaluateDecisionRelevanceBatch
      ),
      3,
      'decision relevance',
      ctx.ledger,
      ctx.traceLog,
      'decision-relevance',
      (result) => result.classifierTelemetry?.attempts ?? [],
      (result) => ({
        requestMessages: result.classifierTelemetry?.requestMessages ?? [],
        responseText: result.classifierTelemetry?.responseText ?? null,
      }),
      { runId: ctx.runId, stage: 'decision-relevance', caseId: input.caseId }
    );

    const resolution = resolveKnowledgeSet(decisionRelevance.relevant, queryFrame);
    const relevanceRationaleByUnitId = buildRelevanceRationaleByUnitId(decisionRelevance.trace);

    if (resolution.disposition !== 'ANSWER') {
      return {
        ...base,
        queryFrame,
        retrieval,
        resolution,
        evidencePack: null,
        draft: null,
        verification: null,
        actualDisposition: 'HOLD',
        errorMessage: null,
        errorRetryable: false,
        decisionRelevanceTrace: decisionRelevance.trace,
        decisionRelevanceDroppedByClassifier: decisionRelevance.droppedByClassifier,
        answerDependsOnProbabilisticExclusion: decisionRelevance.answerDependsOnProbabilisticExclusion,
        challengeCompatibility: null,
        probabilisticExclusionBlockingUnitIds: null,
        conditionPreservation: null,
        conditionPreservationBlockingUnitIds: null,
        dependencyExpansion,
      };
    }

    const evidenceUnitIds = new Set([
      ...resolution.selected,
      ...(resolution.negativeEvidence ?? []),
      ...resolution.overridden.flatMap((edge) => [edge.unitId, edge.byUnitId]),
    ]);
    const selectedUnits = [...evidenceUnitIds]
      .map((id) => ctx.unitsById.get(id))
      .filter((u): u is PersistedKnowledgeUnit => u !== undefined);
    const evidencePack = buildEvidencePack(selectedUnits, resolution, relevanceRationaleByUnitId);
    assertOracleTaintPolicy(ctx.taintDetector, 'ENGINE_INPUT', evidencePack, `engine input (EvidencePack, ${input.caseId})`);

    const draft = await synthesizeFromSelectedUnits(
      evidencePack,
      input.question,
      ctx.answerGeneratorForCase(input.caseId)
    );
    assertOracleTaintPolicy(ctx.taintDetector, 'GENERATED_OUTPUT', draft, `engine output (DraftAnswer, ${input.caseId})`);

    const verification = verifyAnswerClaims(draft, evidencePack);
    const conditionPreservation = await recordOnFailure(
      'condition-preservation', ctx.ledger, ctx.traceLog,
      { runId: ctx.runId, stage: 'condition-preservation', caseId: input.caseId },
      () => verifyConditionsAfterBasicVerification(verification.verified, {
        question: input.question, draft, pack: evidencePack, runConfig: ctx.conditionPreservationRunConfig,
      })
    );
    if (conditionPreservation !== null && conditionPreservation.attempts.length > 0) {
      recordTrace(ctx.traceLog, 'condition-preservation', conditionPreservation.attempts,
        { requestMessages: conditionPreservation.requestMessages, responseText: conditionPreservation.responseText },
        'SUCCESS', null, { runId: ctx.runId, stage: 'condition-preservation', caseId: input.caseId });
      ctx.ledger.record('condition-preservation', conditionPreservation.attempts);
    }
    const finalVerification: VerificationResult = mergeConditionPreservationVerification(verification, conditionPreservation);
    const counterfactuals = evaluateChallengeCounterfactuals(decisionRelevance, queryFrame);
    const compatibility = await recordOnFailure(
      'challenge-compatibility',
      ctx.ledger,
      ctx.traceLog,
      { runId: ctx.runId, stage: 'challenge-compatibility', caseId: input.caseId },
      () =>
        verifyChallengesAfterBasicVerification(verification.verified, {
          question: input.question,
          draft,
          challenges: decisionRelevance.challengeCandidates,
          pack: evidencePack,
          resolution,
          counterfactuals,
          runConfig: ctx.challengeCompatibilityRunConfig,
        })
    );
    if (compatibility !== null && compatibility.attempts.length > 0) {
      recordTrace(
        ctx.traceLog,
        'challenge-compatibility',
        compatibility.attempts,
        { requestMessages: compatibility.requestMessages, responseText: compatibility.responseText },
        'SUCCESS',
        null,
        { runId: ctx.runId, stage: 'challenge-compatibility', caseId: input.caseId }
      );
      ctx.ledger.record('challenge-compatibility', compatibility.attempts);
    }
    let exclusionSafety = resolveProbabilisticExclusionSafety(
      decisionRelevance,
      counterfactuals,
      compatibility
    );

    let finalResolution = resolution;
    let finalEvidencePack = evidencePack;
    let finalDraft = draft;
    let deliveredVerification = finalVerification;
    let finalCompatibility = compatibility;
    let finalConditionPreservation = conditionPreservation;

    // At most one bounded recovery round. Only deterministic prerequisites or
    // an exact provider proof of omitted (but non-contradictory) required
    // content may be promoted. Exceptions and genuine conflicts never enter.
    const recoveryCandidates = selectChallengeRecoveryCandidates(decisionRelevance, compatibility);
    if (recoveryCandidates.length > 0) {
      const promotedIds = new Set(recoveryCandidates.map((candidate) => candidate.unitId));
      const recoveredRelevant = [
        ...decisionRelevance.relevant,
        ...recoveryCandidates.map((candidate) => ({ ...candidate.evaluated, semanticRelevance: 'RELEVANT' as const })),
      ];
      const recoveredResolution = resolveKnowledgeSet(recoveredRelevant, queryFrame);
      if (recoveredResolution.disposition === 'ANSWER') {
        const recoveredUnits = [...recoveredResolution.selected, ...(recoveredResolution.negativeEvidence ?? [])]
          .map((id) => ctx.unitsById.get(id))
          .filter((unit): unit is PersistedKnowledgeUnit => unit !== undefined);
        const recoveredPack = buildEvidencePack(recoveredUnits, recoveredResolution, relevanceRationaleByUnitId);
        assertOracleTaintPolicy(ctx.taintDetector, 'ENGINE_INPUT', recoveredPack, `recovery engine input (EvidencePack, ${input.caseId})`);
        const recoveredDraft = await synthesizeFromSelectedUnits(
          recoveredPack, input.question, ctx.recoveryAnswerGeneratorForCase(input.caseId)
        );
        assertOracleTaintPolicy(ctx.taintDetector, 'GENERATED_OUTPUT', recoveredDraft, `recovery engine output (DraftAnswer, ${input.caseId})`);
        const recoveredBasicVerification = verifyAnswerClaims(recoveredDraft, recoveredPack);
        const recoveredCondition = await recordOnFailure(
          'recovery-condition-preservation', ctx.ledger, ctx.traceLog,
          { runId: ctx.runId, stage: 'recovery-condition-preservation', caseId: input.caseId },
          () => verifyConditionsAfterBasicVerification(recoveredBasicVerification.verified, {
            question: input.question, draft: recoveredDraft, pack: recoveredPack,
            runConfig: ctx.recoveryConditionPreservationRunConfig,
          })
        );
        if (recoveredCondition !== null && recoveredCondition.attempts.length > 0) {
          recordTrace(ctx.traceLog, 'recovery-condition-preservation', recoveredCondition.attempts,
            { requestMessages: recoveredCondition.requestMessages, responseText: recoveredCondition.responseText },
            'SUCCESS', null, { runId: ctx.runId, stage: 'recovery-condition-preservation', caseId: input.caseId });
          ctx.ledger.record('recovery-condition-preservation', recoveredCondition.attempts);
        }
        const recoveredVerification = mergeConditionPreservationVerification(
          recoveredBasicVerification, recoveredCondition
        );
        const remainingGate = {
          ...decisionRelevance,
          relevant: recoveredRelevant,
          droppedByClassifier: decisionRelevance.droppedByClassifier.filter((id) => !promotedIds.has(id)),
          challengeCandidates: decisionRelevance.challengeCandidates.filter((item) => !promotedIds.has(item.unitId)),
        };
        const recoveredCounterfactuals = evaluateChallengeCounterfactuals(remainingGate, queryFrame);
        const recoveredCompatibility = await recordOnFailure(
          'recovery-challenge-compatibility', ctx.ledger, ctx.traceLog,
          { runId: ctx.runId, stage: 'recovery-challenge-compatibility', caseId: input.caseId },
          () => verifyChallengesAfterBasicVerification(recoveredBasicVerification.verified, {
            question: input.question, draft: recoveredDraft,
            challenges: remainingGate.challengeCandidates, pack: recoveredPack,
            resolution: recoveredResolution, counterfactuals: recoveredCounterfactuals,
            runConfig: ctx.recoveryChallengeCompatibilityRunConfig,
          })
        );
        if (recoveredCompatibility !== null && recoveredCompatibility.attempts.length > 0) {
          recordTrace(ctx.traceLog, 'recovery-challenge-compatibility', recoveredCompatibility.attempts,
            { requestMessages: recoveredCompatibility.requestMessages, responseText: recoveredCompatibility.responseText },
            'SUCCESS', null, { runId: ctx.runId, stage: 'recovery-challenge-compatibility', caseId: input.caseId });
          ctx.ledger.record('recovery-challenge-compatibility', recoveredCompatibility.attempts);
        }
        finalResolution = recoveredResolution;
        finalEvidencePack = recoveredPack;
        finalDraft = recoveredDraft;
        deliveredVerification = recoveredVerification;
        finalConditionPreservation = recoveredCondition;
        finalCompatibility = recoveredCompatibility;
        exclusionSafety = resolveProbabilisticExclusionSafety(
          remainingGate, recoveredCounterfactuals, recoveredCompatibility
        );
      }
    }

    return {
      ...base,
      queryFrame,
      retrieval,
      resolution: finalResolution,
      evidencePack: finalEvidencePack,
      draft: finalDraft,
      verification: deliveredVerification,
      // НЕ безусловный 'DIRECT_ANSWER' (дыра в гарантии, закрытая W1-A):
      // ответ, провалившийся собственную проверку заземления, больше не
      // предъявляется как прямой ответ. Черновик и нарушения остаются в
      // артефакте целиком — провал должен быть ВИДЕН, а не спрятан.
      actualDisposition: resolveAnswerDisposition(deliveredVerification, exclusionSafety),
      errorMessage: null,
      errorRetryable: false,
      decisionRelevanceTrace: decisionRelevance.trace,
      decisionRelevanceDroppedByClassifier: decisionRelevance.droppedByClassifier,
      answerDependsOnProbabilisticExclusion: exclusionSafety.answerDependsOnProbabilisticExclusion,
      challengeCompatibility: finalCompatibility?.decisions ?? null,
      probabilisticExclusionBlockingUnitIds: exclusionSafety.blockingUnitIds,
      conditionPreservation: finalConditionPreservation?.decisions ?? null,
      conditionPreservationBlockingUnitIds: finalConditionPreservation?.blockingUnitIds ?? null,
      dependencyExpansion,
    };
  } catch (err) {
    // A cost-budget trip must never be absorbed into a per-question ERROR
    // result (Codex review, 2026-08-10, finding 1): swallowing it here meant
    // the run just moved on to the NEXT question — which could make MORE
    // paid calls — instead of aborting like every other budget trip does.
    // Re-throw immediately; main()'s try/catch is the one place that's
    // allowed to turn this into "run stopped."
    if (
      err instanceof CostBudgetExceededError ||
      err instanceof PaidCallBudgetExceededError ||
      err instanceof UnverifiableCostError
    ) throw err;

    // A genuine OracleTaintError (assertClean above) is NEVER retryable here —
    // classifyStructuredError correctly falls through to OTHER_ERROR for it,
    // same as any other real bug. Only transport/schema failure classes are.
    return {
      ...base,
      queryFrame: null,
      retrieval: null,
      resolution: null,
      evidencePack: null,
      draft: null,
      verification: null,
      actualDisposition: 'ERROR',
      errorMessage: err instanceof Error ? err.message : String(err),
      errorRetryable: classifyStructuredError(err) !== 'OTHER_ERROR',
      decisionRelevanceTrace: null,
      decisionRelevanceDroppedByClassifier: null,
      answerDependsOnProbabilisticExclusion: null,
      challengeCompatibility: null,
      probabilisticExclusionBlockingUnitIds: null,
      conditionPreservation: null,
      conditionPreservationBlockingUnitIds: null,
      dependencyExpansion: null,
    };
  }
}

/** Max attempts for one question's engine pipeline on a transient
 *  transport/schema failure. A real full-benchmark run (full-smoke8,
 *  2026-08-09) hit widespread transient "fetch failed" during a period of
 *  provider instability — 15 of 16 questions came back ERROR, each from a
 *  single unretried blip, even though extraction and coverage-audit (both
 *  already bounded-retried) succeeded moments earlier in the same run.
 *  `runEngineOnQuestion` is a pure, self-contained function (no shared state
 *  across calls), so retrying it wholesale needs no rewiring — unlike the
 *  taint-check retry, this never touches which content is treated as
 *  tainted (see `errorRetryable`'s docstring). */
const MAX_ENGINE_QUESTION_RETRY_ATTEMPTS = 3;

async function runEngineOnQuestionWithRetry(
  input: EngineQuestionInput,
  ctx: EngineContext
): Promise<EngineQuestionResult> {
  let result: EngineQuestionResult = await runEngineOnQuestion(input, ctx);
  for (
    let attempt = 2;
    result.actualDisposition === 'ERROR' && result.errorRetryable && attempt <= MAX_ENGINE_QUESTION_RETRY_ATTEMPTS;
    attempt++
  ) {
    console.warn(
      `[engine ${input.caseId}] попытка ${attempt}/${MAX_ENGINE_QUESTION_RETRY_ATTEMPTS} после (retryable): ${result.errorMessage}`
    );
    result = await runEngineOnQuestion(input, ctx);
  }
  return result;
}

// ──────────────────────────── one extraction run ────────────────────────────

interface ExtractionRunOutcome {
  readonly runId: string;
  readonly snapshot: EvaluationKnowledgeSnapshot;
  readonly sourceRuleIdByUnitId: ReadonlyMap<string, number | null>;
  readonly results: readonly EngineQuestionResult[];
  readonly extractionAttemptLog: readonly ExtractionAttemptLog[];
  readonly batchLogs: readonly BatchExtractionLog[];
  readonly auditResults: readonly BlockCoverageAuditResult[];
  readonly focusedRetryLogs: readonly FocusedRetryLog[];
  /** `null` only for `--dependency-graph=skip` — see ReadyDependencyGraph. */
  readonly dependencyGraphArtifactPath: string | null;
  readonly dependencyGraphArtifactContentDigest: string;
  readonly dependencyGraphFingerprint: string;
  readonly dependencyGraphRestored: boolean;
  /** Артефакт извлечения. `null` в режиме `--reuse-extraction` — прогон
   *  ничего нового не извлекал, перезаписывать нечем и незачем. */
  readonly artifact: ExtractionArtifact | null;
}

/** Максимум выходных токенов на один вызов извлечения. Участвует в отпечатке
 *  артефакта: тот же промпт с другим потолком может дать другой набор units
 *  (обрезанный ответ), значит кэш от него — про другой прогон. */
const EXTRACTION_MAX_TOKENS = 16000;

function budgetedRunConfig(
  ledger: CostLedger,
  purpose: string,
  promptVersion: string,
  provider: Provider,
  model: string
): ReturnType<typeof resolveExtractionRunConfig> {
  return resolveExtractionRunConfig({
    promptVersion,
    provider,
    model,
    beforeProviderAttempt: () => ledger.reservePaidCall(purpose),
  });
}

const DEPENDENCY_GRAPH_STAGE_MAX_ATTEMPTS = 3;
const DEPENDENCY_GRAPH_STAGE_MAX_TOKENS = 16_000;

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function dependencyGraphArtifactConfig(
  artifact: ExtractionArtifact
): DependencyGraphArtifactConfig {
  const contract = dependencyGraphBuilderContractProbe();
  return {
    provider: artifact.fingerprint.extractionProvider,
    model: artifact.fingerprint.extractionModel,
    prompt: sha256Json(contract),
    schema: sha256Json({
      proposal: dependencyGraphSchema._zod.def,
      audit: dependencyAuditSchema._zod.def,
    }),
    policy: sha256Json({
      contract,
      maxStageAttempts: DEPENDENCY_GRAPH_STAGE_MAX_ATTEMPTS,
      maxTokens: DEPENDENCY_GRAPH_STAGE_MAX_TOKENS,
    }),
  };
}

export function dependencyGraphSidecarPath(
  extractionArtifactPath: string,
  exactFingerprintDigest?: string
): string {
  const suffix = exactFingerprintDigest === undefined ? '' : `-${exactFingerprintDigest.slice(0, 16)}`;
  return path.join(path.dirname(extractionArtifactPath), `dependency-graph-artifact${suffix}.json`);
}

interface ReadyDependencyGraph {
  readonly graph: DependencyGraph;
  /** `null` only for `--dependency-graph=skip`: no sidecar artifact is ever
   *  read or written for a skipped run, so there is no path to record. */
  readonly artifactPath: string | null;
  readonly artifactContentDigest: string;
  readonly restored: boolean;
}

/** Reason recorded in run-summary.json's `dependencyGraphSkipReason` — the
 *  only place a human auditing a skipped run's artifacts needs to look to
 *  see WHY the stage didn't run. Named as a constant (not inlined) so
 *  `resolveDependencyGraphSummaryFields`'s test can assert on it directly. */
const DEPENDENCY_GRAPH_SKIP_REASON =
  'Явный флаг --dependency-graph=skip: граф зависимостей пропущен, ни одного provider-вызова для proposal/audit/repair не сделано. ' +
  'Граф — все units как изолированные конечные точки, edges пуст; expandRetrievedDependencies выродился в тождество, ' +
  'в кандидатный пул попадают только retrieval seeds (поведение до commit a0a17ba). ' +
  'grade-aurora-fixture.ts откажется засчитать этот прогон как acceptance score без --accept-skipped-graph.';

/** Единственное место, решающее форму двух `dependencyGraph*` полей
 *  run-summary.json — вынесено из полутора-тысячестрочного `main()`, чтобы
 *  «пропуск виден в run-summary.json» проверялось тестом напрямую. REQUIRED
 *  отдаёт РОВНО {dependencyGraphStage}: отсутствующий флаг обязан оставлять
 *  форму run-summary.json байт-в-байт вчерашней (никакого лишнего ключа). */
export function resolveDependencyGraphSummaryFields(
  dependencyGraphStage: DependencyGraphStageArg
): { readonly dependencyGraphStage: 'REQUIRED' } | { readonly dependencyGraphStage: 'SKIPPED'; readonly dependencyGraphSkipReason: string } {
  return dependencyGraphStage === 'skip'
    ? { dependencyGraphStage: 'SKIPPED', dependencyGraphSkipReason: DEPENDENCY_GRAPH_SKIP_REASON }
    : { dependencyGraphStage: 'REQUIRED' };
}

/** Exported for tests only: production call sites are both inside this
 *  module. Letting a test pass its own `buildGraph` is what makes it
 *  possible to prove the REQUIRED path still invokes the graph stage and the
 *  `skip` path invokes it zero times without either path ever reaching a
 *  real provider (mirrors the extractor/auditor DI pattern already used by
 *  `resolveTaintedCandidates`). */
export async function ensureDependencyGraph(
  runId: string,
  extractionArtifactPath: string,
  extractionArtifact: ExtractionArtifact,
  ledger: CostLedger,
  traceLog: CallTraceLog,
  dependencyGraphStage: DependencyGraphStageArg,
  // Injectable purely for tests (mirrors the extractor/auditor DI pattern
  // `resolveTaintedCandidates` already uses): lets a test prove the
  // REQUIRED path still invokes the graph stage, and the skip path invokes
  // it zero times, without EITHER path making a real provider call.
  buildGraph: typeof buildAuditedDependencyGraph = buildAuditedDependencyGraph
): Promise<ReadyDependencyGraph> {
  if (extractionArtifact.phase !== 'COMPLETE') {
    throw new Error('Dependency graph requires a COMPLETE extraction artifact.');
  }
  const units = extractionArtifact.snapshot.units;

  if (dependencyGraphStage === 'skip') {
    // Short-circuits BEFORE any provider call and before any sidecar-artifact
    // I/O: every unit becomes an isolated endpoint, edges stays empty. What
    // keeps a skipped run from being mistaken for a real measurement lives
    // downstream (run-summary.json's dependencyGraphStage, the grader's
    // refusal without --accept-skipped-graph) — not here.
    const graph = createDependencyGraph({
      units: units.map((unit) => ({
        unitId: unit.unitId,
        sourceSpan: unit.sourceSpan,
        evidenceByField: unit.evidenceByField,
      })),
      edges: [],
    });
    return {
      graph,
      artifactPath: null,
      artifactContentDigest: sha256Json({
        dependencyGraphStage: 'SKIPPED',
        extractionArtifactContentDigest: extractionArtifact.contentDigest,
      }),
      restored: false,
    };
  }

  const config = dependencyGraphArtifactConfig(extractionArtifact);
  const expectedFingerprint = buildDependencyGraphArtifactFingerprint(
    extractionArtifact,
    units,
    config
  );
  // Versioned sidecars allow a graph-policy change to build a new exact graph
  // without altering or invalidating the frozen COMPLETE-v6 extraction.
  const artifactPath = dependencyGraphSidecarPath(
    extractionArtifactPath,
    sha256Json(expectedFingerprint)
  );
  const restored = loadCompatibleDependencyGraphArtifact(artifactPath, expectedFingerprint);
  if (restored !== undefined) {
    return {
      graph: hydrateDependencyGraph(restored.graph, units),
      artifactPath,
      artifactContentDigest: restored.contentDigest,
      restored: true,
    };
  }

  const provider = config.provider as Provider;
  if (provider !== 'anthropic' && provider !== 'openai') {
    throw new Error(`Unsupported dependency graph provider: ${config.provider}`);
  }
  const makeStage = <T>(purpose: string, stage: string): DependencyGraphStage<T> => {
    const runConfig = budgetedRunConfig(
      ledger,
      purpose,
      `aurora-fixture-${stage}-v1`,
      provider,
      config.model
    );
    return async (request) => {
      const { result } = await withStructuredRetry(
        () => structured({
          schema: request.schema,
          messages: [...request.messages],
          runConfig,
          maxTokens: DEPENDENCY_GRAPH_STAGE_MAX_TOKENS,
        }),
        DEPENDENCY_GRAPH_STAGE_MAX_ATTEMPTS,
        stage,
        ledger,
        traceLog,
        purpose,
        (value) => value.attempts,
        (value) => ({
          requestMessages: value.requestMessages ?? [],
          responseText: value.rawText ?? null,
        }),
        { runId, stage, engineProvider: provider, engineModel: config.model }
      );
      return result.data;
    };
  };

  const graph = await buildGraph({
    units,
    proposer: makeStage('dependency-graph-proposal', 'dependency-graph-proposal'),
    auditor: makeStage('dependency-graph-audit', 'dependency-graph-audit'),
    repairer: makeStage('dependency-graph-repair', 'dependency-graph-repair'),
    exactRequestFingerprint: {
      extractionArtifactContentDigest: extractionArtifact.contentDigest,
      config,
      maxStageAttempts: DEPENDENCY_GRAPH_STAGE_MAX_ATTEMPTS,
      maxTokens: DEPENDENCY_GRAPH_STAGE_MAX_TOKENS,
    },
    checkpoint: new FileDependencyGraphCheckpoint(`${artifactPath}.stage-journal.json`),
  });
  const graphDocument: DependencyGraphDocument = serializeDependencyGraph(graph);
  const artifact = buildDependencyGraphArtifact(expectedFingerprint, graphDocument);
  writeDependencyGraphArtifact(artifactPath, artifact);
  return { graph, artifactPath, artifactContentDigest: artifact.contentDigest, restored: false };
}

/** Shared by both `ensureDependencyGraph` call sites so the skip/required
 *  wording can't drift between the fresh-extraction and --reuse-extraction
 *  paths. */
function logDependencyGraphReady(ready: ReadyDependencyGraph): void {
  if (ready.artifactPath === null) {
    console.log(
      `  граф зависимостей ПРОПУЩЕН (--dependency-graph=skip): ${ready.graph.units.size} unit(s) как изолированные конечные точки, edges: 0 — ни одного provider-вызова`
    );
    return;
  }
  console.log(
    `  граф зависимостей ${ready.restored ? 'переиспользован' : 'построен и сохранён'}: ` +
      `${ready.artifactPath} (${ready.graph.edges.length} edge(s))`
  );
}

export function dependencyGraphStructuredCallCeiling(): number {
  // proposal + initial/final audits around at most two focused repairs
  return 1 + (2 + 1) + 2;
}

export function resolveQuestionStageTarget(
  args: Pick<CliArgs, 'questionProvider' | 'questionModel' | 'engineProfile'>,
  extraction: { readonly provider: Provider; readonly model: string }
): { provider: Provider; model: string } {
  const profileTarget = args.engineProfile === 'balanced'
    ? { provider: 'anthropic' as const, model: 'claude-haiku-4-5' }
    : args.engineProfile === 'economy'
      ? { provider: 'openai' as const, model: 'gpt-4o-mini' }
      : extraction;
  return {
    provider: args.questionProvider ?? profileTarget.provider,
    model: args.questionModel ?? profileTarget.model,
  };
}

/**
 * Цикл вопросов — ОБЩИЙ для свежего извлечения и для переиспользования
 * артефакта. Вынесен именно ради этого: движок обязан видеть ровно один и тот
 * же путь в обоих режимах, иначе `--reuse-extraction` мерил бы не то, что
 * меряет обычный прогон, и сравнивать их было бы нельзя.
 */
async function runQuestionsAgainstSnapshot(
  runId: string,
  snapshot: EvaluationKnowledgeSnapshot,
  embeddedCandidates: readonly EmbeddedCandidate[],
  unitsById: ReadonlyMap<string, PersistedKnowledgeUnit>,
  dependencyGraph: DependencyGraph,
  dependencyGraphArtifactContentDigest: string,
  deps: ExtractionRunDeps,
  artifactContentDigest: string
): Promise<EngineQuestionResult[]> {
  const reviewedAt = new Date().toISOString();
  const questionModel = deps.questionModel;
  const questionProvider = deps.questionProvider;
  const rerankerProvider = new LlmRerankerProvider(
    budgetedRunConfig(deps.ledger, 'reranker', 'aurora-fixture-reranker-v1', questionProvider, questionModel)
  );
  let activeQuestionCaseId: string | undefined;
  const queryEmbeddingProvider = new OpenAIEmbeddingProvider(
    () => deps.ledger.reservePaidCall('query-embedding'),
    (attempt, texts) => recordEmbeddingAttempt(
      'query-embedding', deps.ledger, deps.traceLog, attempt, texts,
      { runId, stage: 'query-embedding', ...(activeQuestionCaseId && { caseId: activeQuestionCaseId }) }
    )
  );
  const journalFingerprint = buildQuestionJournalFingerprint(artifactContentDigest, {
    dependencyGraph: dependencyGraphQuestionFingerprint(
      dependencyGraphArtifactContentDigest,
      dependencyGraph
    ),
    provider: questionProvider, model: questionModel,
    queryFrame: buildExtractionMessages([{ id: 'probe', role: 'user', text: 'probe question' }]),
    queryFrameSchema: rawQueryExtractionSchema._zod.def,
    reranker: buildRerankPromptMessages('probe question', [{ id: 'probe-unit', text: 'probe statement' }]),
    rerankerSchema: rerankResponseSchema._zod.def,
    relevance: buildBatchDecisionRelevancePromptMessages('probe question', []),
    relevanceSchema: batchDecisionRelevanceResponseSchema._zod.def,
    challengeCompatibility: buildChallengeCompatibilityMessages(
      'probe question',
      { text: 'probe answer', citedUnitIds: ['probe-unit'], answerSource: 'knowledge_base' },
      [{
        unitId: 'probe-challenge',
        mandatoryPrerequisite: false,
        statement: 'probe challenge',
        quote: 'probe challenge',
        evaluated: { unitId: 'probe-challenge' } as never,
      }],
      { items: [{ unitId: 'probe-unit', kind: 'PROCEDURE_STEP', statement: 'selected probe rule', citation: { anchor: 'probe', quote: 'selected probe rule' }, numericConstraint: null }], numericFacts: [] },
      { disposition: 'ANSWER', selected: ['probe-unit'], undetermined: [], excluded: [], overridden: [], numericConflicts: [], requiresHumanReview: false, clarificationNeeds: { facets: [], triggerFacts: [], ambiguities: [] }, reasons: [] },
      { restoredDispositionByUnitId: { 'probe-challenge': 'ANSWER' }, blockingUnitIds: [] }
    ),
    challengeCompatibilitySchema: challengeCompatibilityResponseSchema._zod.def,
    conditionPreservation: buildConditionPreservationMessages(
      'probe question',
      { text: 'probe answer', citedUnitIds: ['probe-unit'], answerSource: 'knowledge_base' },
      [{ unitId: 'probe-unit', statement: 'conditional action', conditions: ['if probe condition'], applicabilityMode: 'CONDITIONAL' }]
    ),
    conditionPreservationSchema: conditionPreservationResponseSchema._zod.def,
    conditionPreservationBehavior: conditionedEvidenceOf.toString(),
    overriddenParentContext: overriddenParentContextBehaviorProbe(),
    synthesis: buildRealAnswerPromptMessages.toString(),
    synthesisSchema: answerSchema._zod.def,
    oracleTaintPolicy: {
      version: ORACLE_TAINT_POLICY_VERSION,
      behavior: oracleTaintPolicyBehaviorProbe(),
    },
    retryPolicies: {
      embedding: { maxRawAttempts: 3, sdkMaxRetriesWhenBudgeted: 0 },
      decisionRelevance: { maxStageAttempts: 3, maxIdenticalSchemaFailures: 2 },
      wholeQuestion: { maxAttempts: MAX_ENGINE_QUESTION_RETRY_ATTEMPTS },
    },
    queryEmbeddingModel: queryEmbeddingProvider.modelInfo(), retrievalContract: retrievalContractProbe(),
    deterministicStages: {
      buildQueryFrame: buildQueryFrame(
        { facetMentions: [], triggerFactMentions: [{ fact: 'consentStatus', rawValue: 'EXPLICIT', messageId: 'probe', quote: 'согласен' }], questionAspects: ['REQUIREMENT'] },
        [{ id: 'probe', role: 'user', text: 'согласен' }]
      ),
      decisionRelevanceGateAndCounterfactuals: [applyDecisionRelevanceGate.toString(), evaluateChallengeCounterfactuals.toString()],
      effectiveTriggerInheritance: effectiveTriggerInheritanceBehaviorProbe(),
      resolution: resolveKnowledgeSet.toString(),
      verification: verifyAnswerClaims.toString(),
      internalReferenceLeakPolicy: internalReferenceLeakPolicyProbe(),
      probabilisticExclusionSafety: resolveProbabilisticExclusionSafety.toString(),
      challengeRecovery: {
        selector: selectChallengeRecoveryCandidates.toString(),
        maxRounds: 1,
        stages: ['resolution', 'synthesis', 'verification', 'condition-preservation', 'challenge-compatibility'],
      },
      answerDisposition: [
        resolveAnswerDisposition({ verified: true }, { answerDependsOnProbabilisticExclusion: false }),
        resolveAnswerDisposition({ verified: true }, { answerDependsOnProbabilisticExclusion: true }),
        resolveAnswerDisposition(null),
      ],
    },
    questionBehavior: computeQuestionBehaviorProbes(),
  });
  const questionJournal = new QuestionResultJournal<EngineQuestionResult>(
    path.join(deps.args.outDir, `question-journal-${artifactContentDigest.slice(0, 16)}-${journalFingerprint.configDigest.slice(0, 16)}.json`), journalFingerprint
  );
  const ctx: EngineContext = {
    runId,
    engineProfile: deps.engineProfile,
    embeddedCandidates,
    unitsById,
    dependencyGraph,
    embeddingProvider: queryEmbeddingProvider,
    rerankerProvider,
    requestContext: { audience: 'internal', now: reviewedAt },
    reviewedAt,
    queryFrameRunConfig: budgetedRunConfig(deps.ledger, 'query-frame', 'aurora-fixture-query-frame-v1', questionProvider, questionModel),
    answerGeneratorForCase: (caseId) => buildRealAnswerGenerator(
      budgetedRunConfig(deps.ledger, 'synthesis', 'aurora-fixture-synthesis-v1', questionProvider, questionModel),
      deps.ledger,
      deps.traceLog,
      runId,
      caseId,
      deps.engineProfile
    ),
    recoveryAnswerGeneratorForCase: (caseId) => buildRealAnswerGenerator(
      budgetedRunConfig(deps.ledger, 'recovery-synthesis', 'aurora-fixture-recovery-synthesis-v1', questionProvider, questionModel),
      deps.ledger, deps.traceLog, runId, caseId, deps.engineProfile, 'recovery-synthesis'
    ),
    decisionRelevanceRunConfig: budgetedRunConfig(
      deps.ledger,
      'decision-relevance',
      'aurora-fixture-decision-relevance-v1',
      questionProvider,
      questionModel
    ),
    challengeCompatibilityRunConfig: budgetedRunConfig(
      deps.ledger,
      'challenge-compatibility',
      'aurora-fixture-challenge-compatibility-v1',
      questionProvider,
      questionModel
    ),
    conditionPreservationRunConfig: budgetedRunConfig(
      deps.ledger,
      'condition-preservation',
      'aurora-fixture-condition-preservation-v1',
      questionProvider,
      questionModel
    ),
    recoveryChallengeCompatibilityRunConfig: budgetedRunConfig(
      deps.ledger, 'recovery-challenge-compatibility', 'aurora-fixture-recovery-challenge-compatibility-v1', questionProvider, questionModel
    ),
    recoveryConditionPreservationRunConfig: budgetedRunConfig(
      deps.ledger, 'recovery-condition-preservation', 'aurora-fixture-recovery-condition-preservation-v1', questionProvider, questionModel
    ),
    taintDetector: deps.taintDetector,
    ledger: deps.ledger,
    traceLog: deps.traceLog,
  };

  const results: EngineQuestionResult[] = [];
  for (const question of deps.questions) {
    activeQuestionCaseId = question.caseId;
    console.log(`  [${runId}] ${question.caseId}: "${question.question.slice(0, 60)}..."`);
    const restored = questionJournal.load(question.caseId, question.question);
    const result = restored ?? await runEngineOnQuestionWithRetry(question, ctx);
    if (restored === undefined) questionJournal.save(question.caseId, question.question, result);
    console.log(`    -> ${result.actualDisposition}${result.errorMessage ? ` (${result.errorMessage})` : ''}`);
    results.push(result);
  }
  return results;
}

/** Контекст, общий для обеих веток извлечения (свежей и переиспользующей). */
interface ExtractionRunDeps {
  readonly args: CliArgs;
  readonly questions: readonly EngineQuestionInput[];
  readonly sourceRules: readonly SourceRule[];
  readonly taintDetector: OracleTaintDetector;
  readonly ledger: CostLedger;
  readonly traceLog: CallTraceLog;
  readonly embeddingProvider: OpenAIEmbeddingProvider;
  readonly embeddingModel: ReturnType<OpenAIEmbeddingProvider['modelInfo']>;
  readonly questionModel: string;
  readonly questionProvider: Provider;
  readonly engineProfile: EngineProfile;
}

/** Previous invocation's write-through trace, retained only as an offline
 * recovery source for exact initial-extraction requests. */
let recoveryTraceEntries: readonly CallTraceEntry[] = [];

async function runOneExtractionRun(
  runIndex: number,
  args: CliArgs,
  questions: readonly EngineQuestionInput[],
  sourceRules: readonly SourceRule[],
  taintDetector: OracleTaintDetector,
  ledger: CostLedger,
  traceLog: CallTraceLog
): Promise<ExtractionRunOutcome> {
  const runId = `run-${runIndex}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  console.log(`\n=== EXTRACTION RUN ${runIndex} (${runId}) ===`);

  const buffer = await import('node:fs').then((fs) => fs.readFileSync(args.docPath));
  const canonical = await extractCanonicalDocument(buffer);
  console.log(`canonical document: ${canonical.blocks.length} blocks`);

  const sourceBlocks = canonical.blocks.map((b) => ({ anchor: b.anchor, text: b.text, kind: b.kind }));
  const blocksByAnchor = new Map<string, SourceBlockLocation>(
    canonical.blocks.map((b) => [b.anchor, toSourceBlockLocation(b)])
  );

  const extractionRunConfig = resolveExtractionRunConfig({
    beforeProviderAttempt: () => ledger.reservePaidCall('extraction'),
  });
  const { provider: questionProvider, model: questionModel } =
    resolveQuestionStageTarget(args, extractionRunConfig);
  const focusedRepairRunConfig = {
    ...extractionRunConfig,
    beforeProviderAttempt: () => ledger.reservePaidCall('focused-repair'),
  };
  const exceptionRepairRunConfig = {
    ...extractionRunConfig,
    beforeProviderAttempt: () => ledger.reservePaidCall('exception-repair'),
  };
  const coverageAuditRunConfig = {
    ...extractionRunConfig,
    beforeProviderAttempt: () => ledger.reservePaidCall('coverage-audit'),
  };
  const allAttemptLogs: ExtractionAttemptLog[] = [];
  // Каждый batch проходит СВОЙ transport/schema retry (extractKnowledgeUnitsWithRetry,
  // до 6 попыток) -- та же дисциплина, что раньше применялась ко всему
  // документу одним вызовом, но теперь per-batch, поверх нового bounded-batch +
  // completeness-audit пути (goal-shift continuation, 2026-08-09): один
  // whole-document вызов молча забыл правила 5-10 на реальном прогоне, хотя
  // JSON был схема-валиден и retry на это не сработал бы никогда.
  let nextExtractionBatchIndex = 0;
  const retryingExtractor = async (options: ExtractKnowledgeUnitsOptions): Promise<ExtractKnowledgeUnitsResult> => {
    const batchIndex = nextExtractionBatchIndex++;
    const { result, attemptLog } = await extractKnowledgeUnitsWithRetry(
      options,
      6,
      ledger,
      traceLog,
      { runId, stage: 'extraction', batchIndex, blockAnchors: options.blocks.map((block) => block.anchor) }
    );
    allAttemptLogs.push(...attemptLog);
    return result;
  };
  const retryingTaintExtractor = async (options: ExtractKnowledgeUnitsOptions): Promise<ExtractKnowledgeUnitsResult> => {
    const { result, attemptLog } = await extractKnowledgeUnitsWithRetry(
      options,
      6,
      ledger,
      traceLog,
      { runId, stage: 'taint-resample', blockAnchors: options.blocks.map((block) => block.anchor) }
    );
    allAttemptLogs.push(...attemptLog);
    return result;
  };
  const retryingExceptionRepairExtractor = async (
    options: ExceptionRepairOptions
  ): Promise<ExtractKnowledgeUnitsResult> => {
    const effective = { ...options, runConfig: exceptionRepairRunConfig };
    const { result, attemptLog } = await withStructuredRetry(
      () => extractExceptionRepairUnits(effective),
      6,
      'malformed exception repair',
      ledger,
      traceLog,
      'exception-repair',
      (value) => value.structuredResult.attempts,
      (value) => ({
        requestMessages: value.structuredResult.requestMessages ?? [],
        responseText: value.structuredResult.rawText ?? null,
      }),
      {
        runId,
        stage: 'exception-repair',
        blockAnchor: options.block.anchor,
      }
    );
    allAttemptLogs.push(...attemptLog);
    return result;
  };
  const retryingFocusedRepairExtractor = async (options: FocusedRepairOptions): Promise<ExtractKnowledgeUnitsResult> => {
    const { result, attemptLog } = await extractFocusedRepairUnitsWithRetry(
      { ...options, runConfig: focusedRepairRunConfig },
      6,
      ledger,
      traceLog,
      { runId, stage: 'focused-repair', blockAnchor: options.block.anchor }
    );
    allAttemptLogs.push(...attemptLog);
    return result;
  };
  // Same bounded transport/schema retry as extraction itself — a real run
  // (full-smoke4) crashed the whole extraction run on a single transient
  // "fetch failed" INSIDE the coverage-audit call, which previously had no
  // retry wrapper at all.
  const retryingAuditor = async (options: AuditBlockCoverageOptions): Promise<BlockCoverageAuditResult> => {
    const { result, attemptLog } = await withStructuredRetry(
      () => auditBlockCoverage({ ...options, runConfig: coverageAuditRunConfig }),
      6,
      'coverage audit',
      ledger,
      traceLog,
      'coverage-audit',
      (r) => r.attempts ?? [],
      (r) => ({ requestMessages: r.requestMessages ?? [], responseText: r.rawResponseText ?? null }),
      { runId, stage: 'coverage-audit', blockAnchor: options.blockAnchor }
    );
    allAttemptLogs.push(...attemptLog);
    return result;
  };

  const embeddingProvider = new OpenAIEmbeddingProvider(
    () => ledger.reservePaidCall('corpus-embedding'),
    (attempt, texts) => recordEmbeddingAttempt(
      'corpus-embedding', ledger, traceLog, attempt, texts,
      { runId, stage: 'corpus-embedding' }
    )
  );
  const embeddingModel = embeddingProvider.modelInfo();
  // Считается ДО любого платного вызова: в режиме переиспользования именно он
  // решает, законен ли артефакт, и если нет — прогон обязан упасть, не потратив
  // ни цента. Пять `computePipelineProbes()` — это не строковые версии, а хеши
  // РЕАЛЬНОГО поведения (промпт аудита, политика ремонта, алгоритм
  // идентичности, состав retrievalText): их нельзя забыть обновить при правке
  // кода, потому что их никто не пишет руками.
  const probes = computePipelineProbes();
  const fingerprint: ExtractionFingerprint = {
    artifactVersion: EXTRACTION_ARTIFACT_VERSION,
    sourceRevisionHash: canonical.sourceRevisionHash,
    canonicalTextHash: canonical.canonicalTextHash,
    parserVersion: canonical.parserVersion,
    blockCount: canonical.blocks.length,
    extractionProvider: extractionRunConfig.provider,
    extractionModel: extractionRunConfig.model,
    extractionPromptVersion: extractionRunConfig.promptVersion,
    extractionPromptFingerprint: probes.extractionPromptFingerprint,
    extractionSchemaVersion: extractionRunConfig.extractionSchemaVersion,
    extractionMaxTokens: EXTRACTION_MAX_TOKENS,
    extractionBatchSize: args.batchSize,
    auditProvider: extractionRunConfig.provider,
    auditModel: extractionRunConfig.model,
    auditPromptVersion: extractionRunConfig.promptVersion,
    auditPromptFingerprint: probes.auditPromptFingerprint,
    auditPolicyFingerprint: probes.auditPolicyFingerprint,
    focusedRepairPolicyFingerprint: probes.focusedRepairPolicyFingerprint,
    evidenceRefinementFingerprint: probes.evidenceRefinementFingerprint,
    graphIntegrityPolicyFingerprint: probes.graphIntegrityPolicyFingerprint,
    identityAlgorithmFingerprint: probes.identityAlgorithmFingerprint,
    retrievalTextFingerprint: probes.retrievalTextFingerprint,
    embeddingProvider: embeddingModel.provider,
    embeddingModel: embeddingModel.model,
    embeddingDimensions: embeddingModel.dimensions ?? 0,
  };

  if (args.reuseExtraction) {
    return reuseExtractionRun(runIndex, runId, args.reuseExtraction, fingerprint, {
      args,
      questions,
      sourceRules,
      taintDetector,
      ledger,
      traceLog,
      embeddingProvider,
      embeddingModel,
      questionProvider,
      questionModel,
      engineProfile: args.engineProfile,
    });
  }

  const rawCheckpointFingerprint = buildRawExtractionFingerprint({
    sourceRevisionHash: canonical.sourceRevisionHash,
    canonicalTextHash: canonical.canonicalTextHash,
    parserVersion: canonical.parserVersion,
    blocks: sourceBlocks,
    batchSize: args.batchSize,
    provider: extractionRunConfig.provider,
    model: extractionRunConfig.model,
    config: {
      promptVersion: extractionRunConfig.promptVersion,
      extractionSchemaVersion: extractionRunConfig.extractionSchemaVersion,
      extractionPromptFingerprint: probes.extractionPromptFingerprint,
      maxTokens: EXTRACTION_MAX_TOKENS,
      temperature: null,
      fallbackPolicy: extractionRunConfig.fallbackPolicy,
      requestTimeoutMs: extractionRunConfig.requestTimeoutMs ?? null,
      totalDeadlineMs: extractionRunConfig.totalDeadlineMs ?? null,
    },
    auditContract: {
      promptFingerprint: probes.auditPromptFingerprint,
      policyFingerprint: probes.auditPolicyFingerprint,
    },
    repairContract: {
      paidStageFingerprint: probes.focusedRepairPaidStageFingerprint,
      malformedExceptionPolicyFingerprint: LEGACY_EXCEPTION_REPAIR_POLICY_FINGERPRINT,
      maxTokens: 4_000,
      malformedExceptionMaxTokens: 8_000,
    },
    exceptionRepairContract: {
      policyFingerprint: exceptionRepairPolicyFingerprint(),
      maxTokens: 8_000,
    },
    legacyCombinedConfig: {
      promptVersion: extractionRunConfig.promptVersion,
      extractionSchemaVersion: extractionRunConfig.extractionSchemaVersion,
      extractionPromptFingerprint: probes.extractionPromptFingerprint,
      auditPromptFingerprint: probes.auditPromptFingerprint,
      auditPolicyFingerprint: probes.auditPolicyFingerprint,
      focusedRepairPolicyFingerprint: probes.focusedRepairPolicyFingerprint,
      malformedExceptionPolicyFingerprint: exceptionRepairPolicyFingerprint(),
      maxTokens: EXTRACTION_MAX_TOKENS,
      focusedRepairMaxTokens: 4_000,
      malformedExceptionMaxTokens: 8_000,
      temperature: null,
      fallbackPolicy: extractionRunConfig.fallbackPolicy,
      requestTimeoutMs: extractionRunConfig.requestTimeoutMs ?? null,
      totalDeadlineMs: extractionRunConfig.totalDeadlineMs ?? null,
    },
  });
  const rawCheckpointPath = path.join(args.outDir, `raw-extraction-run-${runIndex}.checkpoint.json`);
  const rawCheckpoint = new RawExtractionCheckpointStore(rawCheckpointPath, rawCheckpointFingerprint);
  const importedBatchCount = rawCheckpoint.importTraceEntries(recoveryTraceEntries, sourceBlocks);
  if (importedBatchCount > 0) {
    console.log(`recovered ${importedBatchCount} paid extraction batch(es) from prior exact-match call trace`);
  }

  console.log(`вызов LLM (extractKnowledgeUnitsWithCompletenessAudit, batchSize=${args.batchSize})...`);
  const audited = await extractKnowledgeUnitsWithCompletenessAudit(
    sourceBlocks,
    args.batchSize,
    { runConfig: extractionRunConfig, maxTokens: EXTRACTION_MAX_TOKENS },
    extractionRunConfig,
    {
      extractor: retryingExtractor,
      repairExtractor: retryingFocusedRepairExtractor,
      auditor: retryingAuditor,
      initialExtractionCheckpoint: rawCheckpoint,
      paidStageCheckpoint: rawCheckpoint,
    }
  );
  const gapsFound = audited.auditResults.filter((a) => a.hasGap).length;
  console.log(
    `extracted ${audited.units.length} raw unit(s) across ${audited.batchLogs.length} batch(es), ` +
      `${allAttemptLogs.length} extraction attempt(s), coverage audit: ${gapsFound}/${audited.auditResults.length} ` +
      `block(s) flagged a gap, ${audited.focusedRetryLogs.length} focused retr${audited.focusedRetryLogs.length === 1 ? 'y' : 'ies'} run`
  );

  const identity = assignIdentity(audited.units, blocksByAnchor, canonical.sourceRevisionHash);
  console.log(`assignIdentity: ${identity.units.length} persisted, ${identity.ambiguousDuplicates.length} ambiguous`);
  assertTrustedIdentity(identity, `runOneExtractionRun(${runIndex})`);

  if (identity.units.length === 0) {
    throw new Error(`runOneExtractionRun(${runIndex}): экстракция не выдала ни одного unit — прогон недействителен`);
  }

  const resampled = await resolveTaintedCandidates(
    identity.units,
    blocksByAnchor,
    canonical.sourceRevisionHash,
    taintDetector,
    retryingTaintExtractor,
    retryingAuditor,
    { runConfig: extractionRunConfig, maxTokens: EXTRACTION_MAX_TOKENS },
    TAINT_RESAMPLE_MAX_ROUNDS
    , rawCheckpoint
  );
  if (resampled.resampleLogs.length > 0) {
    const affectedBlocks = new Set(resampled.resampleLogs.map((l) => l.blockAnchor)).size;
    console.log(
      `targeted taint resample: ${resampled.resampleLogs.length} re-extraction(s) across ${affectedBlocks} block(s) — cheaper first attempt before falling back to a whole-run retry`
    );
  }

  const exceptionRepaired = await resolveMalformedExceptions(
    resampled.units,
    blocksByAnchor,
    canonical.sourceRevisionHash,
    retryingExceptionRepairExtractor,
    retryingAuditor,
    { runConfig: exceptionRepairRunConfig, maxTokens: 8_000 },
    MALFORMED_EXCEPTION_REPAIR_MAX_ROUNDS,
    rawCheckpoint
  );
  if (exceptionRepaired.repairLogs.length > 0) {
    console.log(
      `malformed exception repair: ${exceptionRepaired.repairLogs.length} block replacement(s) ` +
        `across ${new Set(exceptionRepaired.repairLogs.map((log) => log.blockAnchor)).size} block(s)`
    );
  }

  const snapshot = buildEvaluationSnapshot(
    {
      sourceRevisionHash: canonical.sourceRevisionHash,
      canonicalTextHash: canonical.canonicalTextHash,
      parserVersion: canonical.parserVersion,
      extractionRunId: runId,
      extractionProvider: extractionRunConfig.provider,
      extractionModel: extractionRunConfig.model,
      extractionPromptVersion: extractionRunConfig.promptVersion,
      extractionSchemaVersion: extractionRunConfig.extractionSchemaVersion,
    },
    exceptionRepaired.units
  );

  const unitsById = new Map(snapshot.units.map((u) => [u.unitId, u]));
  const sourceRuleIdByUnitId = new Map(
    snapshot.units.map((u) => [u.unitId, resolveSourceRuleId(u, sourceRules)])
  );

  const candidates = snapshot.units.map((u) => ({
    unitId: u.unitId,
    retrievalText: buildRetrievalText(u, unitsById),
  }));
  assertOracleTaintPolicy(taintDetector, 'ENGINE_INPUT', candidates, `engine input (retrieval candidates, ${runId})`);

  const finalAuditResults = [
    ...audited.auditResults,
    ...resampled.auditResults,
    ...exceptionRepaired.auditResults,
  ];
  const runDir = path.join(args.outDir, runId);
  mkdirSync(runDir, { recursive: true });
  const artifactPath = path.join(runDir, 'extraction-artifact.json');

  // Durable semantic checkpoint BEFORE the separately billed embedding
  // provider. A provider/auth failure here must not discard already-paid,
  // fully audited Anthropic extraction. This phase cannot feed retrieval;
  // reuseExtractionRun completes and atomically upgrades it first.
  const semanticCheckpoint = buildExtractionArtifact({
    phase: 'SEMANTIC_CHECKPOINT',
    fingerprint,
    sourceDocPath: args.docPath,
    snapshot,
    embeddingModel,
    embeddings: [],
    extractionAttemptLog: allAttemptLogs,
    batchLogs: audited.batchLogs,
    auditResults: finalAuditResults,
    focusedRetryLogs: audited.focusedRetryLogs,
  });
  writeExtractionArtifact(artifactPath, semanticCheckpoint);
  console.log(`  trusted semantic checkpoint сохранён ДО embeddings: ${artifactPath}`);

  console.log('вычисление embeddings для candidate pool...');
  const embeddedCandidates = await embedCandidates(candidates, embeddingProvider);

  // Артефакт для `--reuse-extraction`: всё, что фаза извлечения добыла
  // платными вызовами, вместе с отпечатком конфигурации, которая его
  // породила. Пишется ВСЕГДА при свежем извлечении — переиспользовать
  // задним числом нельзя то, что не сохранили.
  const artifact = buildExtractionArtifact({
    phase: 'COMPLETE',
    fingerprint,
    sourceDocPath: args.docPath,
    snapshot,
    embeddingModel,
    embeddings: candidates.map((c, i) => ({
      unitId: c.unitId,
      retrievalText: c.retrievalText,
      embedding: embeddedCandidates[i].embedding,
    })),
    extractionAttemptLog: allAttemptLogs,
    batchLogs: audited.batchLogs,
    auditResults: finalAuditResults,
    focusedRetryLogs: audited.focusedRetryLogs,
  });

  // ЧЕКПОЙНТ: пишем артефакт ДО первого вопроса (кросс-аудит 2026-08-10).
  // Раньше он писался только после возврата из этой функции, то есть падение
  // на фазе вопросов — исчерпанный бюджет, taint, ошибка движка — теряло уже
  // оплаченное извлечение целиком. Именно это и воспроизводило ту трату,
  // ради устранения которой делался --reuse-extraction: последние прогоны
  // падали как раз на вопросах.
  writeExtractionArtifact(artifactPath, artifact);
  console.log(`  артефакт извлечения сохранён ДО вопросов: ${artifactPath} (для --reuse-extraction)`);

  const readyDependencyGraph = await ensureDependencyGraph(
    runId, artifactPath, artifact, ledger, traceLog, args.dependencyGraphStage
  );
  logDependencyGraphReady(readyDependencyGraph);

  const results = await runQuestionsAgainstSnapshot(
    runId,
    snapshot,
    embeddedCandidates,
    unitsById,
    readyDependencyGraph.graph,
    readyDependencyGraph.artifactContentDigest,
    {
    args,
    questions,
    sourceRules,
    taintDetector,
    ledger,
    traceLog,
    embeddingProvider,
    embeddingModel,
    questionProvider,
    questionModel,
    engineProfile: args.engineProfile,
    },
    artifact.contentDigest
  );

  return {
    runId,
    snapshot,
    sourceRuleIdByUnitId,
    results,
    extractionAttemptLog: allAttemptLogs,
    batchLogs: audited.batchLogs,
    auditResults: finalAuditResults,
    focusedRetryLogs: audited.focusedRetryLogs,
    dependencyGraphArtifactPath: readyDependencyGraph.artifactPath,
    dependencyGraphArtifactContentDigest: readyDependencyGraph.artifactContentDigest,
    dependencyGraphFingerprint: readyDependencyGraph.graph.fingerprint,
    dependencyGraphRestored: readyDependencyGraph.restored,
    artifact,
  };
}

/**
 * Ветка `--reuse-extraction`: фаза извлечения не делает ни одного платного
 * вызова. Ради этого и всё остальное — $19.79 за день ушли на 12 прогонов,
 * которые 31 раз переизвлекали ОДИН И ТОТ ЖЕ документ, пока чинилось совсем
 * другое (поиск и ответы).
 *
 * `readExtractionArtifact` сверяет отпечаток и падает при расхождении — молча
 * переиспользованный устаревший артефакт дал бы уверенно неверные выводы о
 * качестве, а это хуже сэкономленных денег.
 *
 * Taint-проверка кандидатов НЕ пропускается: она бесплатна, а гарантия
 * «эталон не подтёк в то, что видит движок» не зависит от того, откуда взялись
 * units.
 */
async function reuseExtractionRun(
  runIndex: number,
  runId: string,
  artifactPath: string,
  fingerprint: ExtractionFingerprint,
  deps: ExtractionRunDeps
): Promise<ExtractionRunOutcome> {
  console.log(`переиспользование извлечения: ${artifactPath} (без повторных Anthropic extraction/audit вызовов)`);
  let artifact = readExtractionArtifact(artifactPath, fingerprint);
  console.log(
    `артефакт принят: ${artifact.snapshot.units.length} unit(s), сохранён ${artifact.savedAt}, отпечаток совпал`
  );

  const { snapshot } = artifact;
  if (snapshot.units.length === 0) {
    throw new Error(`reuseExtractionRun(${runIndex}): артефакт не содержит ни одного unit — прогон недействителен`);
  }

  const unitsById = new Map(snapshot.units.map((u) => [u.unitId, u]));
  const sourceRuleIdByUnitId = new Map(
    snapshot.units.map((u) => [u.unitId, resolveSourceRuleId(u, deps.sourceRules)])
  );
  const candidates = snapshot.units.map((u) => ({
    unitId: u.unitId,
    retrievalText: buildRetrievalText(u, unitsById),
  }));
  assertOracleTaintPolicy(deps.taintDetector, 'ENGINE_INPUT', candidates, `engine input (retrieval candidates, ${runId})`);

  let embeddedCandidates: EmbeddedCandidate[];
  if (artifact.phase === 'SEMANTIC_CHECKPOINT') {
    console.log('semantic checkpoint принят; продолжаю только corpus embeddings...');
    embeddedCandidates = await embedCandidates(candidates, deps.embeddingProvider);
    artifact = buildExtractionArtifact({
      phase: 'COMPLETE',
      fingerprint: artifact.fingerprint,
      sourceDocPath: artifact.sourceDocPath,
      snapshot: artifact.snapshot,
      embeddingModel: deps.embeddingModel,
      embeddings: candidates.map((candidate, index) => ({
        unitId: candidate.unitId,
        retrievalText: candidate.retrievalText,
        embedding: embeddedCandidates[index].embedding,
      })),
      extractionAttemptLog: artifact.extractionAttemptLog,
      batchLogs: artifact.batchLogs,
      auditResults: artifact.auditResults,
      focusedRetryLogs: artifact.focusedRetryLogs,
    });
    writeExtractionArtifact(artifactPath, artifact);
    console.log(`semantic checkpoint атомарно обновлён до COMPLETE: ${artifactPath}`);
  } else {
    embeddedCandidates = restoreEmbeddedCandidates(
      artifact,
      candidates,
      deps.embeddingModel,
      artifactPath
    );
  }

  const readyDependencyGraph = await ensureDependencyGraph(
    runId,
    artifactPath,
    artifact,
    deps.ledger,
    deps.traceLog,
    deps.args.dependencyGraphStage
  );
  logDependencyGraphReady(readyDependencyGraph);

  const results = await runQuestionsAgainstSnapshot(
    runId,
    snapshot,
    embeddedCandidates,
    unitsById,
    readyDependencyGraph.graph,
    readyDependencyGraph.artifactContentDigest,
    deps,
    artifact.contentDigest
  );

  return {
    runId,
    snapshot,
    sourceRuleIdByUnitId,
    results,
    extractionAttemptLog: artifact.extractionAttemptLog,
    batchLogs: artifact.batchLogs,
    auditResults: artifact.auditResults,
    focusedRetryLogs: artifact.focusedRetryLogs,
    dependencyGraphArtifactPath: readyDependencyGraph.artifactPath,
    dependencyGraphArtifactContentDigest: readyDependencyGraph.artifactContentDigest,
    dependencyGraphFingerprint: readyDependencyGraph.graph.fingerprint,
    dependencyGraphRestored: readyDependencyGraph.restored,
    artifact: null,
  };
}

/** Максимум ПОЛНЫХ прогонов извлечения на один runIndex, если очередная
 *  LLM-выборка случайно (не по вине экстракции) задевает защищённую
 *  формулировку oracle. Не «пока не понравится оценка» — тот же класс
 *  решения, что и transport/schema retry на batch-уровне: конкретная выборка
 *  недействительна, нужна свежая независимая выборка (см. OracleTaintError).
 *
 *  Изначально было 3 (goal-shift continuation, 2026-08-09). Реальные прогоны
 *  подтвердили ДВЕ независимые, честно проверенные (не выдуманные) причины
 *  ложных срабатываний в этом фикстур-документе — оба раза источник содержит
 *  малозначимое слово-модификатор («трёх ТАКИХ циклов», «участок АККУРАТНО
 *  промывают»), которое и модель, и независимо написанный oracle-ответ
 *  одинаково опускают при сжатии предложения. Это не устраняется настройкой
 *  словаря секретов (это была бы подгонка под конкретную формулировку oracle
 *  — запрещено), а bounded-ретрай остаётся корректным ответом; 3 попыток
 *  оказалось мало для повторно бьющей фразы правила 6 (видено трижды из
 *  четырёх реальных попыток подряд). Поднято до 6 — тот же bounded принцип,
 *  просто больше независимых выборок, не тюнинг механизма обнаружения. */
const MAX_TAINT_RETRY_ATTEMPTS = 6;

/** `resolveTaintedCandidates`'s `maxRounds` — named so `printPreRunCeiling`
 *  can reference the SAME source of truth instead of a formula that could
 *  silently drift out of sync if this ever changes (Codex review, 2026-08-10,
 *  finding 4: the ceiling omitted this multiplier entirely). */
const TAINT_RESAMPLE_MAX_ROUNDS = 3;
const MALFORMED_EXCEPTION_REPAIR_MAX_ROUNDS = 2;

/** Оборачивает `runOneExtractionRun` bounded-ретраем СПЕЦИФИЧНО на
 *  `OracleTaintError` — короткие формулировки в узком юридическом домене
 *  документа иногда случайно совпадают у независимо сгенерированного
 *  парафраза модели и независимо написанного ответа oracle (подтверждено
 *  вручную: источник — «трёх ТАКИХ циклов», и модель, и oracle одинаково
 *  опускают «таких»). Единственная законная реакция на такое совпадение —
 *  выбросить прогон целиком и получить свежую независимую выборку; словарь
 *  секретов НЕ ослабляется и НЕ подстраивается под конкретную формулировку.
 *  Любая другая ошибка (реальный баг, network/schema после исчерпания
 *  собственного retry и т.п.) пробрасывается немедленно, без ретрая здесь. */
async function runOneExtractionRunWithTaintRetry(
  runIndex: number,
  args: CliArgs,
  questions: readonly EngineQuestionInput[],
  sourceRules: readonly SourceRule[],
  taintDetector: OracleTaintDetector,
  ledger: CostLedger,
  traceLog: CallTraceLog
): Promise<ExtractionRunOutcome> {
  for (let attempt = 1; attempt <= MAX_TAINT_RETRY_ATTEMPTS; attempt++) {
    try {
      return await runOneExtractionRun(runIndex, args, questions, sourceRules, taintDetector, ledger, traceLog);
    } catch (err) {
      if (!(err instanceof OracleTaintError) || attempt === MAX_TAINT_RETRY_ATTEMPTS) throw err;
      console.warn(
        `прогон ${runIndex}, попытка ${attempt}/${MAX_TAINT_RETRY_ATTEMPTS}: случайное совпадение с oracle ` +
          `(не баг — см. OracleTaintError), прогон отброшен, беру свежую независимую выборку: ${err.message}`
      );
    }
  }
  throw new Error('unreachable');
}

/**
 * Prints a deliberately PESSIMISTIC worst-case call ceiling BEFORE any paid
 * call is made (Task 38, 2026-08-10) — the user's explicit hard rule after
 * an unexplained $19.79/day spend: no benchmark run starts without first
 * seeing an estimated max-calls/dollar ceiling. Assumes every bounded retry
 * in the file actually maxes out (extraction/audit: 6 attempts each, taint
 * whole-run retry: `MAX_TAINT_RETRY_ATTEMPTS`, engine-question retry:
 * `MAX_ENGINE_QUESTION_RETRY_ATTEMPTS`) — real runs are almost always far
 * below this. It's a circuit-breaker sanity check to eyeball against
 * `--max-cost-usd`, not a typical-case forecast — printing a tight "average
 * case" number would be worse than useless the one time a run actually hits
 * pathological retries, which is exactly when this estimate matters.
 */
export function focusedRepairStructuredCallCeiling(
  blockCount: number,
  structuredRetryCeiling: number
): number {
  return blockCount * FOCUSED_REPAIR_MAX_ROUNDS * 2 * structuredRetryCeiling;
}

function printPreRunCeiling(blockCount: number, args: CliArgs, questionCount: number): void {
  const STRUCTURED_RETRY_CEILING = 6; // caller-level schema/transport retries
  const RAW_CHAT_ATTEMPTS_PER_STRUCTURED_CALL = 4; // primary + MAX_RETRIES=3; runner configs disable fallback
  const EMBEDDING_RAW_ATTEMPT_CEILING = 3;
  const DECISION_RELEVANCE_STAGE_ATTEMPT_CEILING = 3;
  const batchCount = Math.ceil(blockCount / args.batchSize);
  const structuredCallsPerExtractionAttempt =
    // initial extraction + initial audit
    (batchCount + blockCount) * STRUCTURED_RETRY_CEILING +
    // each focused repair round is one extraction + one mandatory full re-audit
    focusedRepairStructuredCallCeiling(blockCount, STRUCTURED_RETRY_CEILING) +
    // every targeted taint replacement is both re-extracted and re-audited
    blockCount * TAINT_RESAMPLE_MAX_ROUNDS * 2 * STRUCTURED_RETRY_CEILING +
    // malformed EXCEPTION_RULE replacement + coverage audit, bounded by round
    blockCount * MALFORMED_EXCEPTION_REPAIR_MAX_ROUNDS * 2 * STRUCTURED_RETRY_CEILING +
    // global dependency proposal + up to two repair/re-audit rounds
    dependencyGraphStructuredCallCeiling() * DEPENDENCY_GRAPH_STAGE_MAX_ATTEMPTS;
  const extractionRawCalls =
    structuredCallsPerExtractionAttempt *
    RAW_CHAT_ATTEMPTS_PER_STRUCTURED_CALL *
    MAX_TAINT_RETRY_ATTEMPTS;
  const corpusEmbeddingCalls = MAX_TAINT_RETRY_ATTEMPTS * EMBEDDING_RAW_ATTEMPT_CEILING;
  const rawCallsPerQuestionAttempt =
    // query-frame + reranker + synthesis + worst-case
    // challenge compatibility + condition preservation + one bounded recovery
    // synthesis/condition/challenge round
    8 * RAW_CHAT_ATTEMPTS_PER_STRUCTURED_CALL +
    // decision relevance retries locally after retrieval
    DECISION_RELEVANCE_STAGE_ATTEMPT_CEILING * RAW_CHAT_ATTEMPTS_PER_STRUCTURED_CALL +
    // query embedding retries locally without rebuilding the query frame
    EMBEDDING_RAW_ATTEMPT_CEILING;
  const questionCalls =
    rawCallsPerQuestionAttempt * MAX_ENGINE_QUESTION_RETRY_ATTEMPTS * questionCount;
  const paidCallCeiling =
    (extractionRawCalls + corpusEmbeddingCalls + questionCalls) * args.extractionRuns;

  console.log('\n=== PRE-RUN COST CEILING (worst case — see caveats below) ===');
  console.log(`  document: ${blockCount} block(s), batch-size=${args.batchSize} -> ${batchCount} batch(es)`);
  console.log(`  extraction-runs: ${args.extractionRuns}, questions: ${questionCount}`);
  console.log(
    `  worst-case paid provider-request ceiling: ${paidCallCeiling} ` +
      `(includes coverage/focused/taint/exception/dependency-graph calls, decision relevance, challenge compatibility, condition preservation, corpus/query embeddings, reranking, and all chat-provider retries)`
  );
  console.log(
    `  --max-cost-usd=${args.maxCostUsd} — the run aborts the moment cumulative metered spend exceeds this, independent of the ceiling above`
  );
  console.log(
    `  --max-paid-calls=${args.maxPaidCalls} — hard raw-request reservation ceiling; no provider request starts after this many reservations`
  );
}

// ────────────────────────────────── main ─────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('=== AURORA FIXTURE E2E BENCHMARK ===');
  console.log(`doc: ${args.docPath}`);
  console.log(`extraction-runs: ${args.extractionRuns}`);
  console.log(`out: ${args.outDir}`);

  const positiveOracle = loadSemanticRuleOracle();
  const negativeOracle = loadNegativeCaseOracle();
  const sourceRules = await loadSourceRulesFromDocx(args.docPath);

  const negativeQuestionById = new Map<string, string>();
  for (const c of positiveOracle) {
    for (const n of c.negativeCases) negativeQuestionById.set(n.id, n.question);
  }

  const questions: EngineQuestionInput[] = [
    ...positiveOracle.map((c) => ({ caseId: c.id, question: c.question })),
    ...negativeOracle
      .map((n) => {
        const question = negativeQuestionById.get(n.id);
        return question ? { caseId: n.id, question } : null;
      })
      .filter((q): q is EngineQuestionInput => q !== null),
  ];

  const missingNegativeQuestions = negativeOracle.filter((n) => !negativeQuestionById.has(n.id));
  if (missingNegativeQuestions.length > 0) {
    console.warn(
      `ВНИМАНИЕ: ${missingNegativeQuestions.length} negative-кейс(ов) не нашли текст вопроса в positiveOracle.negativeCases: ` +
        missingNegativeQuestions.map((n) => n.id).join(', ')
    );
  }

  console.log(`questions: ${questions.length} (${positiveOracle.length} positive + ${negativeQuestionById.size} negative)`);

  const taintDetector = buildOracleTaintDetector({
    oracle: positiveOracle,
    sourceText: sourceRules.map((r) => r.text).join('\n'),
  });
  console.log(`oracle taint dictionary: ${taintDetector.taintedShingleCount} shingles, ${taintDetector.unguardedSecretCount} unguarded secret(s)`);

  // Free, local, no LLM call — same parse runOneExtractionRun does per run,
  // done once more here purely to size the pre-run ceiling estimate.
  const canonicalForEstimate = await extractCanonicalDocument(readFileSync(args.docPath));
  printPreRunCeiling(canonicalForEstimate.blocks.length, args, questions.length);

  mkdirSync(args.outDir, { recursive: true });

  const ledger = new CostLedger({ maxTotalUsd: args.maxCostUsd, maxPaidCalls: args.maxPaidCalls });
  // Call-trace log (2026-08-10): the exact prompt next to the exact raw
  // response, per call — the debugging visibility CostLedger's aggregate
  // number never gave. JSONL, written incrementally like CostLedger's own
  // artifacts, so a budget/taint abort partway through still leaves every
  // call traced up to that point on disk.
  const callTracePath = path.join(args.outDir, 'call-trace.jsonl');
  // Truncate/create fresh (Codex review, 2026-08-10, finding 7): CallTraceLog
  // appends, it never truncates. Re-running with the same --out (an already-
  // used directory) would otherwise silently concatenate this run's trace
  // behind a PRIOR run's, while run-summary.json's runIds only ever describe
  // the latest one — writeFileSync here matches how run-summary.json already
  // behaves (overwritten fresh each invocation), so this file does too.
  // Before truncation, retain valid lines in memory. The raw checkpoint may
  // import only exact canonical extraction requests from them; all other
  // purposes/responses are ignored. This recovers already-funded batches
  // from runs made before checkpointing existed without trusting the trace as
  // a final extraction artifact.
  recoveryTraceEntries = [];
  if (existsSync(callTracePath)) {
    recoveryTraceEntries = readFileSync(callTracePath, 'utf8')
      .split(/\r?\n/u)
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as CallTraceEntry];
        } catch {
          return [];
        }
      });
  }
  writeFileSync(callTracePath, '', 'utf8');
  const traceLog = new CallTraceLog(callTracePath);
  const runs: ExtractionRunOutcome[] = [];
  let abortedBy: unknown;

  try {
    for (let i = 1; i <= args.extractionRuns; i++) {
      const outcome = await runOneExtractionRunWithTaintRetry(i, args, questions, sourceRules, taintDetector, ledger, traceLog);
      runs.push(outcome);

      const runDir = path.join(args.outDir, outcome.runId);
      mkdirSync(runDir, { recursive: true });
      writeFileSync(path.join(runDir, 'evaluation-snapshot.json'), JSON.stringify(outcome.snapshot, null, 2), 'utf8');
      writeFileSync(
        path.join(runDir, 'persisted-units.json'),
        JSON.stringify(outcome.snapshot.units, null, 2),
        'utf8'
      );
      writeFileSync(
        path.join(runDir, 'source-rule-id-by-unit.json'),
        JSON.stringify(Object.fromEntries(outcome.sourceRuleIdByUnitId), null, 2),
        'utf8'
      );
      writeFileSync(path.join(runDir, 'engine-results.json'), JSON.stringify(outcome.results, null, 2), 'utf8');
      writeFileSync(
        path.join(runDir, 'extraction-attempt-log.json'),
        JSON.stringify(outcome.extractionAttemptLog, null, 2),
        'utf8'
      );
      writeFileSync(path.join(runDir, 'batch-logs.json'), JSON.stringify(outcome.batchLogs, null, 2), 'utf8');
      writeFileSync(
        path.join(runDir, 'coverage-audit-results.json'),
        JSON.stringify(outcome.auditResults, null, 2),
        'utf8'
      );
      writeFileSync(
        path.join(runDir, 'focused-retry-log.json'),
        JSON.stringify(outcome.focusedRetryLogs, null, 2),
        'utf8'
      );
      // Артефакт извлечения здесь НЕ пишется: `runOneExtractionRun` сохраняет
      // его чекпойнтом сразу после извлечения, до вопросов — иначе падение на
      // вопросах теряло бы оплаченное извлечение (кросс-аудит 2026-08-10).
    }
  } catch (err) {
    // Caught here (not left to main().catch()) so run-summary.json and the
    // cost report below ALWAYS get written — a budget-triggered or taint
    // abort is exactly when seeing what was spent and where matters most,
    // not the moment to lose that trail. Re-thrown at the end, unchanged.
    abortedBy = err;
  }

  // Always written, whether the run completed or aborted partway (Task 38):
  // `runs` holds whatever extraction runs finished before an abort.
  writeFileSync(
    path.join(args.outDir, 'run-summary.json'),
    JSON.stringify(
      {
        ranAt: new Date().toISOString(),
        docPath: args.docPath,
        ...resolveDependencyGraphSummaryFields(args.dependencyGraphStage),
        extractionRuns: args.extractionRuns,
        questionCount: questions.length,
        taintedShingleCount: taintDetector.taintedShingleCount,
        unguardedSecretCount: taintDetector.unguardedSecretCount,
        runIds: runs.map((r) => r.runId),
        dependencyGraphsByRun: runs.map((run) => ({
          runId: run.runId,
          artifactPath: run.dependencyGraphArtifactPath,
          artifactContentDigest: run.dependencyGraphArtifactContentDigest,
          graphFingerprint: run.dependencyGraphFingerprint,
          restored: run.dependencyGraphRestored,
        })),
        dispositionCountsByRun: runs.map((r) => ({
          runId: r.runId,
          DIRECT_ANSWER: r.results.filter((x) => x.actualDisposition === 'DIRECT_ANSWER').length,
          // Отдельной строкой, а не внутри DIRECT_ANSWER: сводка прогона —
          // первое, на что смотрят, и «сколько ответов доставлено» обязано
          // отличаться от «сколько ответов не прошли собственную проверку».
          UNVERIFIED_ANSWER: r.results.filter((x) => x.actualDisposition === 'UNVERIFIED_ANSWER').length,
          HOLD: r.results.filter((x) => x.actualDisposition === 'HOLD').length,
          ERROR: r.results.filter((x) => x.actualDisposition === 'ERROR').length,
        })),
        cost: {
          totalUsd: ledger.totalUsd(),
          totalAttemptCount: ledger.totalAttemptCount(),
          reservedPaidCallCount: ledger.totalReservedPaidCalls(),
          maxPaidCalls: args.maxPaidCalls,
          byPurpose: ledger.summaryByPurpose(),
        },
        callTracePath,
        abortedBy: abortedBy instanceof Error ? abortedBy.message : abortedBy ? String(abortedBy) : null,
      },
      null,
      2
    ),
    'utf8'
  );

  console.log('\n=== COST (Task 37 — exact metered external usage) ===');
  for (const s of ledger.summaryByPurpose()) {
    console.log(
      `  ${s.purpose}: ${s.callCount} call(s), ${s.attemptCount} attempt(s), $${s.totalUsd.toFixed(4)}` +
        (s.unpricedAttemptCount > 0 ? ` (${s.unpricedAttemptCount} attempt(s) unpriced — model has no entry in MODEL_PRICING)` : '')
    );
  }
  console.log(`  TOTAL (metered): $${ledger.totalUsd().toFixed(4)} across ${ledger.totalAttemptCount()} attempt(s)`);
  console.log(`  PAID-CALL RESERVATIONS: ${ledger.totalReservedPaidCalls()}/${args.maxPaidCalls}`);
  console.log(`  full request/response trace (every call, incl. failed retries): ${callTracePath}`);

  if (abortedBy) {
    console.log(
      `\nПрогон ОСТАНОВЛЕН (${runs.length}/${args.extractionRuns} прогон(ов) завершено): ${abortedBy instanceof Error ? abortedBy.message : String(abortedBy)}`
    );
    console.log(`Частичные артефакты записаны в: ${args.outDir}`);
    throw abortedBy;
  }

  console.log(`\nАртефакты записаны в: ${args.outDir}`);
  console.log('Grading — отдельным проходом (не в этом скрипте), см. scripts/grade-aurora-fixture.ts.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('FATAL ERROR:', err);
    process.exit(1);
  });
}
