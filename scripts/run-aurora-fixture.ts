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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
} from '../src/lib/knowledge/knowledge-unit-extractor';
import {
  extractKnowledgeUnitsWithCompletenessAudit,
  type FocusedRetryLog,
} from '../src/lib/knowledge/audited-extraction';
import type { BatchExtractionLog, BatchExtractor } from '../src/lib/knowledge/batch-extraction';
import {
  auditBlockCoverage,
  type AuditBlockCoverageOptions,
  type BlockCoverageAuditResult,
} from '../src/lib/knowledge/extraction-coverage-auditor';
import { ChatCompletionError, type CompletionAttempt } from '../src/lib/ai/chat-provider';
import { CostBudgetExceededError, CostLedger, UnverifiableCostError } from '../src/lib/ai/cost-ledger';
import { CallTraceLog, type CallTraceEntry } from '../src/lib/ai/call-trace-log';
import {
  assignIdentity,
  type PersistedKnowledgeUnit,
  type SourceBlockLocation,
} from '../src/lib/knowledge/applicability/identity-assignment';
import { buildRetrievalText } from '../src/lib/knowledge/applicability/retrieval-text';
import {
  embedCandidates,
  retrieveUnits,
  type EmbeddedCandidate,
  type RetrievalResult,
} from '../src/lib/knowledge/semantic-retrieval';
import { OpenAIEmbeddingProvider } from '../src/lib/ai/embedding-provider';
import { LlmRerankerProvider } from '../src/lib/ai/reranker-provider';
import { extractQueryFrame } from '../src/lib/knowledge/query-frame-extractor';
import type { ConversationMessage } from '../src/lib/knowledge/applicability/query-frame-builder';
import type { QueryFrame } from '../src/lib/knowledge/applicability/query-frame';
import { buildEvaluatedCandidate } from '../src/lib/eval/knowledge-unit-adapter';
import { resolveKnowledgeSet, type ResolutionDecision } from '../src/lib/knowledge/applicability/resolution';
import { applyDecisionRelevanceGate, type GateCandidateInput, type GatedCandidate } from '../src/lib/knowledge/applicability/decision-relevance';
import { buildEvidencePack, type EvidencePack } from '../src/lib/knowledge/synthesis/evidence-pack';
import {
  synthesizeFromSelectedUnits,
  type AnswerGenerator,
} from '../src/lib/knowledge/synthesis/synthesize';
import type { DraftAnswer } from '../src/lib/knowledge/synthesis/draft-answer';
import { verifyAnswerClaims, type VerificationResult } from '../src/lib/knowledge/synthesis/verify-answer-claims';
import { resolveExtractionRunConfig } from '../src/lib/ai/extraction-run';
import { structured, StructuredOutputError } from '../src/lib/ai/structured-output';
import type { RequestContext } from '../src/lib/knowledge/applicability/eligibility';

import { buildEvaluationSnapshot, type EvaluationKnowledgeSnapshot } from '../src/lib/eval/evaluation-snapshot';
import { resolveAnswerDisposition, type EngineAnswerDisposition } from '../src/lib/eval/answer-disposition';
import { loadSemanticRuleOracle, ORACLE_PACK_DIR, SOURCE_DOCX_FILENAME } from '../src/lib/eval/semantic-rule-oracle';
import { loadNegativeCaseOracle } from '../src/lib/eval/negative-case-oracle';
import { loadSourceRulesFromDocx, type SourceRule } from '../src/lib/eval/source-rule-segmentation';
import { resolveSourceRuleId } from '../src/lib/eval/source-rule-mapping';
import { buildOracleTaintDetector, OracleTaintError, type OracleTaintDetector } from '../src/lib/eval/oracle-taint';

/**
 * Purposes this ledger deliberately does NOT cover yet (Task 37, 2026-08-09).
 * Both are real spend, excluded here for a concrete reason, not an oversight
 * — listed explicitly so `ledger.totalUsd()` is never mistaken for the whole
 * run's cost. Single source of truth for the disclaimer printed to console
 * AND written into run-summary.json.
 */
const UNMETERED_PURPOSES: readonly { purpose: string; reason: string }[] = [
  {
    purpose: 'decision-relevance',
    reason:
      'LLM classifier fires only per uncertain EXCEPTION_RULE candidate (applyDecisionRelevanceGate); wiring it needs changing DecisionRelevanceClassifier\'s return shape, which ~10 test doubles construct directly — deferred pending real evidence this purpose is cost-significant',
  },
  {
    purpose: 'embeddings',
    reason:
      'OpenAIEmbeddingProvider calls generateEmbeddings() (@/lib/openai) directly, not through chat-provider.ts — different token-accounting shape, and at $0.02/1M tokens the smallest cost driver by far',
  },
];

// ─────────────────────────────────── CLI ────────────────────────────────────

const SUPPORTED_MODES = ['e2e'] as const;
type Mode = (typeof SUPPORTED_MODES)[number];

interface CliArgs {
  readonly mode: Mode;
  readonly extractionRuns: number;
  readonly outDir: string;
  readonly docPath: string;
  readonly batchSize: number;
  readonly maxCostUsd: number;
}

const USAGE =
  'Usage: npx tsx scripts/run-aurora-fixture.ts --mode=e2e --extraction-runs=N --out=path/to/dir --max-cost-usd=N [--doc=path/to/source.docx] [--batch-size=N]';

function parseArgs(argv: readonly string[]): CliArgs {
  const known = ['--mode=', '--extraction-runs=', '--out=', '--doc=', '--batch-size=', '--max-cost-usd='];
  const unknown = argv.filter((a) => !known.some((k) => a.startsWith(k)));
  if (unknown.length > 0) {
    throw new Error(`Неизвестные аргументы: ${unknown.join(', ')}\n${USAGE}`);
  }

  const modeArg = argv.find((a) => a.startsWith('--mode='))?.slice('--mode='.length);
  const runsArg = argv.find((a) => a.startsWith('--extraction-runs='))?.slice('--extraction-runs='.length);
  const outArg = argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
  const docArg = argv.find((a) => a.startsWith('--doc='))?.slice('--doc='.length);
  const batchSizeArg = argv.find((a) => a.startsWith('--batch-size='))?.slice('--batch-size='.length);
  const maxCostUsdArg = argv.find((a) => a.startsWith('--max-cost-usd='))?.slice('--max-cost-usd='.length);

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
}

interface EngineContext {
  readonly embeddedCandidates: readonly EmbeddedCandidate[];
  readonly unitsById: ReadonlyMap<string, PersistedKnowledgeUnit>;
  readonly embeddingProvider: OpenAIEmbeddingProvider;
  readonly rerankerProvider: LlmRerankerProvider;
  readonly requestContext: RequestContext;
  readonly reviewedAt: string;
  readonly queryFrameRunConfig: ReturnType<typeof resolveExtractionRunConfig>;
  readonly answerGenerator: AnswerGenerator;
  readonly decisionRelevanceRunConfig: ReturnType<typeof resolveExtractionRunConfig>;
  readonly taintDetector: OracleTaintDetector;
  readonly ledger: CostLedger;
  readonly traceLog: CallTraceLog;
}

interface ExtractionAttemptLog {
  readonly attempt: number;
  readonly outcome: 'SUCCESS' | 'SCHEMA_MISMATCH' | 'TRUNCATED_JSON' | 'NETWORK_ERROR' | 'OTHER_ERROR';
  readonly message: string | null;
}

/**
 * Same classification everywhere a bounded retry decision is made in this
 * file: transport/schema failure classes are retryable, anything else is a
 * real bug and must surface immediately, never silently retried away.
 */
function classifyStructuredError(error: unknown): ExtractionAttemptLog['outcome'] {
  if (error instanceof StructuredOutputError) {
    return error.reason === 'SCHEMA_MISMATCH'
      ? 'SCHEMA_MISMATCH'
      : error.reason === 'TRUNCATED_JSON'
        ? 'TRUNCATED_JSON'
        : 'OTHER_ERROR';
  }
  return error instanceof ChatCompletionError ? 'NETWORK_ERROR' : 'OTHER_ERROR';
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
  errorMessage: string | null
): void {
  const last = attempts[attempts.length - 1];
  traceLog.record({
    timestamp: new Date().toISOString(),
    purpose,
    provider: last?.provider ?? 'unknown',
    model: last?.model ?? 'unknown',
    outcome,
    requestMessages: trace.requestMessages,
    responseText: trace.responseText,
    errorMessage,
  });
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
async function recordOnFailure<T>(
  purpose: string,
  ledger: CostLedger,
  traceLog: CallTraceLog,
  fn: () => Promise<T>
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const failedAttempts = attemptsFromError(error);
    const failedTrace = traceFromError(error);
    if (failedAttempts && failedTrace) {
      const message = error instanceof Error ? error.message : String(error);
      recordTrace(traceLog, purpose, failedAttempts, failedTrace, 'ERROR', message);
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
async function withStructuredRetry<T>(
  call: () => Promise<T>,
  maxAttempts: number,
  label: string,
  ledger: CostLedger,
  traceLog: CallTraceLog,
  purpose: string,
  getAttempts: (result: T) => readonly CompletionAttempt[],
  getTrace: (result: T) => TraceInfo
): Promise<{ result: T; attemptLog: ExtractionAttemptLog[] }> {
  const attemptLog: ExtractionAttemptLog[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await call();
      attemptLog.push({ attempt, outcome: 'SUCCESS', message: null });
      const attempts = getAttempts(result);
      // Trace BEFORE ledger (Codex review, 2026-08-10, finding 5): ledger.record()
      // can throw (budget ceiling / unverifiable cost) — the call that trips it
      // must still land in call-trace.jsonl, not vanish because the throw cut
      // the function off before the trace line ran.
      recordTrace(traceLog, purpose, attempts, getTrace(result), 'SUCCESS', null);
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
        recordTrace(traceLog, purpose, failedAttempts, failedTrace, 'ERROR', message);
      }
      if (failedAttempts) ledger.record(purpose, failedAttempts);
      console.warn(`[${label} attempt ${attempt}/${maxAttempts}] failed (${outcome}): ${message}`);
      if (!retryable || attempt === maxAttempts) throw error;
    }
  }
  throw new Error(`withStructuredRetry(${label}): unreachable`);
}

async function extractKnowledgeUnitsWithRetry(
  options: ExtractKnowledgeUnitsOptions,
  maxAttempts: number,
  ledger: CostLedger,
  traceLog: CallTraceLog
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
    })
  );
}

interface TaintResampleLog {
  readonly blockAnchor: string;
  readonly round: number;
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
async function resolveTaintedCandidates(
  initialUnits: readonly PersistedKnowledgeUnit[],
  blocksByAnchor: ReadonlyMap<string, SourceBlockLocation>,
  sourceRevisionHash: string,
  taintDetector: OracleTaintDetector,
  extractor: BatchExtractor,
  optionsPerBatch: Omit<ExtractKnowledgeUnitsOptions, 'blocks'>,
  maxRounds: number
): Promise<{ units: PersistedKnowledgeUnit[]; resampleLogs: TaintResampleLog[] }> {
  let units = [...initialUnits];
  const resampleLogs: TaintResampleLog[] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const unitsById = new Map(units.map((u) => [u.unitId, u]));
    const candidates = units.map((u) => ({ unitId: u.unitId, retrievalText: buildRetrievalText(u, unitsById) }));

    const taintedUnitIds = new Set<string>();
    for (const candidate of candidates) {
      try {
        taintDetector.assertClean([candidate], 'targeted taint probe');
      } catch (err) {
        if (!(err instanceof OracleTaintError)) throw err;
        taintedUnitIds.add(candidate.unitId);
      }
    }
    if (taintedUnitIds.size === 0) return { units, resampleLogs };

    const affectedAnchors = new Set(
      units.filter((u) => taintedUnitIds.has(u.unitId)).map((u) => u.sourceSpan.anchor)
    );

    for (const anchor of affectedAnchors) {
      const block = blocksByAnchor.get(anchor);
      if (block === undefined) continue;

      const retryResult = await extractor({
        ...optionsPerBatch,
        blocks: [{ anchor: block.anchor, text: block.text }],
      });
      const namespaced = retryResult.units.map((u) => ({
        ...u,
        extractionRef: `taint-retry-${anchor}-${u.extractionRef}`,
        parentExtractionRef: null,
      }));
      const identity = assignIdentity(namespaced, blocksByAnchor, sourceRevisionHash);
      units = [...units.filter((u) => u.sourceSpan.anchor !== anchor), ...identity.units];
      resampleLogs.push({ blockAnchor: anchor, round });
    }
  }

  return { units, resampleLogs };
}

const answerSchema = z.strictObject({
  text: z.string(),
  citedUnitIds: z.array(z.string()).readonly(),
});

function buildRealAnswerGenerator(
  runConfig: ReturnType<typeof resolveExtractionRunConfig>,
  ledger: CostLedger,
  traceLog: CallTraceLog
): AnswerGenerator {
  return async (prompt) => {
    const evidenceText = prompt.evidence
      .map((e) => `[${e.unitId}] ${e.statement}${e.numericConstraint ? ` (${e.numericConstraint.factKey}: ${e.numericConstraint.value} ${e.numericConstraint.unit})` : ''}`)
      .join('\n');
    const result = await recordOnFailure('synthesis', ledger, traceLog, () =>
      structured({
        schema: answerSchema,
        messages: [
          {
            role: 'system',
            content:
              'Ты отвечаешь на вопрос СТРОГО на основе перечисленных unit\'ов знания — не добавляй ничего от себя. ' +
              'citedUnitIds обязан перечислять id ровно тех unit\'ов, на утверждениях которых построен ответ. ' +
              'Ответ СТРОГО JSON: {"text": "...", "citedUnitIds": ["..."]}',
          },
          { role: 'user', content: `Вопрос: "${prompt.question}"\n\nДоступное знание:\n${evidenceText}` },
        ],
        runConfig,
      })
    );
    recordTrace(
      traceLog,
      'synthesis',
      result.attempts,
      { requestMessages: result.requestMessages ?? [], responseText: result.rawText ?? null },
      'SUCCESS',
      null
    );
    ledger.record('synthesis', result.attempts);
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
  const base = { caseId: input.caseId, question: input.question };
  try {
    const message: ConversationMessage = { id: `${input.caseId}-q`, role: 'user', text: input.question };
    ctx.taintDetector.assertClean([message], `engine input (QueryFrame messages, ${input.caseId})`);

    const { queryFrame, structuredResult: queryFrameResult } = await recordOnFailure(
      'query-frame',
      ctx.ledger,
      ctx.traceLog,
      () => extractQueryFrame({ messages: [message], runConfig: ctx.queryFrameRunConfig })
    );
    recordTrace(
      ctx.traceLog,
      'query-frame',
      queryFrameResult.attempts,
      { requestMessages: queryFrameResult.requestMessages ?? [], responseText: queryFrameResult.rawText ?? null },
      'SUCCESS',
      null
    );
    ctx.ledger.record('query-frame', queryFrameResult.attempts);

    const retrieval = await recordOnFailure('reranker', ctx.ledger, ctx.traceLog, () =>
      retrieveUnits(input.question, ctx.embeddedCandidates, {
        embeddingProvider: ctx.embeddingProvider,
        rerankerProvider: ctx.rerankerProvider,
      })
    );
    const rerankerAttempts = ctx.rerankerProvider.drainAttempts();
    recordTrace(ctx.traceLog, 'reranker', rerankerAttempts, ctx.rerankerProvider.drainTrace(), 'SUCCESS', null);
    ctx.ledger.record('reranker', rerankerAttempts);

    const candidateUnits = retrieval.topK
      .map((id) => ctx.unitsById.get(id))
      .filter((u): u is PersistedKnowledgeUnit => u !== undefined);
    const evaluatedCandidates = candidateUnits.map((u) =>
      buildEvaluatedCandidate(u, queryFrame, ctx.requestContext, ctx.reviewedAt)
    );

    // Decision Relevance Gate (architectural correction, 2026-08-09): a
    // retrieval top-K candidate no longer automatically gains the right to
    // influence resolveKnowledgeSet purely by topical adjacency. See
    // decision-relevance.ts's module docstring for the full rationale.
    const gateInputs: GateCandidateInput[] = candidateUnits.map((u, i) => ({
      evaluated: evaluatedCandidates[i],
      statement: u.statement,
      quote: u.sourceSpan.quote,
    }));
    const decisionRelevance = await applyDecisionRelevanceGate(
      gateInputs,
      input.question,
      ctx.decisionRelevanceRunConfig
    );

    const resolution = resolveKnowledgeSet(decisionRelevance.relevant, queryFrame);

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
      };
    }

    const selectedUnits = resolution.selected
      .map((id) => ctx.unitsById.get(id))
      .filter((u): u is PersistedKnowledgeUnit => u !== undefined);
    const evidencePack = buildEvidencePack(selectedUnits, resolution);
    ctx.taintDetector.assertClean(evidencePack, `engine input (EvidencePack, ${input.caseId})`);

    const draft = await synthesizeFromSelectedUnits(evidencePack, input.question, ctx.answerGenerator);
    ctx.taintDetector.assertClean(draft, `engine output (DraftAnswer, ${input.caseId})`);

    const verification = verifyAnswerClaims(draft, evidencePack);

    return {
      ...base,
      queryFrame,
      retrieval,
      resolution,
      evidencePack,
      draft,
      verification,
      // НЕ безусловный 'DIRECT_ANSWER' (дыра в гарантии, закрытая W1-A):
      // ответ, провалившийся собственную проверку заземления, больше не
      // предъявляется как прямой ответ. Черновик и нарушения остаются в
      // артефакте целиком — провал должен быть ВИДЕН, а не спрятан.
      actualDisposition: resolveAnswerDisposition(verification),
      errorMessage: null,
      errorRetryable: false,
      decisionRelevanceTrace: decisionRelevance.trace,
    };
  } catch (err) {
    // A cost-budget trip must never be absorbed into a per-question ERROR
    // result (Codex review, 2026-08-10, finding 1): swallowing it here meant
    // the run just moved on to the NEXT question — which could make MORE
    // paid calls — instead of aborting like every other budget trip does.
    // Re-throw immediately; main()'s try/catch is the one place that's
    // allowed to turn this into "run stopped."
    if (err instanceof CostBudgetExceededError || err instanceof UnverifiableCostError) throw err;

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
}

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

  const sourceBlocks = canonical.blocks.map((b) => ({ anchor: b.anchor, text: b.text }));
  const blocksByAnchor = new Map<string, SourceBlockLocation>(
    canonical.blocks.map((b) => [b.anchor, toSourceBlockLocation(b)])
  );

  const extractionRunConfig = resolveExtractionRunConfig();
  const allAttemptLogs: ExtractionAttemptLog[] = [];
  // Каждый batch проходит СВОЙ transport/schema retry (extractKnowledgeUnitsWithRetry,
  // до 6 попыток) -- та же дисциплина, что раньше применялась ко всему
  // документу одним вызовом, но теперь per-batch, поверх нового bounded-batch +
  // completeness-audit пути (goal-shift continuation, 2026-08-09): один
  // whole-document вызов молча забыл правила 5-10 на реальном прогоне, хотя
  // JSON был схема-валиден и retry на это не сработал бы никогда.
  const retryingExtractor = async (options: ExtractKnowledgeUnitsOptions): Promise<ExtractKnowledgeUnitsResult> => {
    const { result, attemptLog } = await extractKnowledgeUnitsWithRetry(options, 6, ledger, traceLog);
    allAttemptLogs.push(...attemptLog);
    return result;
  };
  // Same bounded transport/schema retry as extraction itself — a real run
  // (full-smoke4) crashed the whole extraction run on a single transient
  // "fetch failed" INSIDE the coverage-audit call, which previously had no
  // retry wrapper at all.
  const retryingAuditor = async (options: AuditBlockCoverageOptions): Promise<BlockCoverageAuditResult> => {
    const { result, attemptLog } = await withStructuredRetry(
      () => auditBlockCoverage(options),
      6,
      'coverage audit',
      ledger,
      traceLog,
      'coverage-audit',
      (r) => r.attempts ?? [],
      (r) => ({ requestMessages: r.requestMessages ?? [], responseText: r.rawResponseText ?? null })
    );
    allAttemptLogs.push(...attemptLog);
    return result;
  };

  console.log(`вызов LLM (extractKnowledgeUnitsWithCompletenessAudit, batchSize=${args.batchSize})...`);
  const audited = await extractKnowledgeUnitsWithCompletenessAudit(
    sourceBlocks,
    args.batchSize,
    { runConfig: extractionRunConfig, maxTokens: 16000 },
    extractionRunConfig,
    { extractor: retryingExtractor, auditor: retryingAuditor }
  );
  const gapsFound = audited.auditResults.filter((a) => a.hasGap).length;
  console.log(
    `extracted ${audited.units.length} raw unit(s) across ${audited.batchLogs.length} batch(es), ` +
      `${allAttemptLogs.length} extraction attempt(s), coverage audit: ${gapsFound}/${audited.auditResults.length} ` +
      `block(s) flagged a gap, ${audited.focusedRetryLogs.length} focused retr${audited.focusedRetryLogs.length === 1 ? 'y' : 'ies'} run`
  );

  const identity = assignIdentity(audited.units, blocksByAnchor, canonical.sourceRevisionHash);
  console.log(`assignIdentity: ${identity.units.length} persisted, ${identity.ambiguousDuplicates.length} ambiguous`);

  if (identity.units.length === 0) {
    throw new Error(`runOneExtractionRun(${runIndex}): экстракция не выдала ни одного unit — прогон недействителен`);
  }

  const resampled = await resolveTaintedCandidates(
    identity.units,
    blocksByAnchor,
    canonical.sourceRevisionHash,
    taintDetector,
    retryingExtractor,
    { runConfig: extractionRunConfig, maxTokens: 16000 },
    TAINT_RESAMPLE_MAX_ROUNDS
  );
  if (resampled.resampleLogs.length > 0) {
    const affectedBlocks = new Set(resampled.resampleLogs.map((l) => l.blockAnchor)).size;
    console.log(
      `targeted taint resample: ${resampled.resampleLogs.length} re-extraction(s) across ${affectedBlocks} block(s) — cheaper first attempt before falling back to a whole-run retry`
    );
  }

  const reviewedAt = new Date().toISOString();
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
    resampled.units
  );

  const unitsById = new Map(snapshot.units.map((u) => [u.unitId, u]));
  const sourceRuleIdByUnitId = new Map(
    snapshot.units.map((u) => [u.unitId, resolveSourceRuleId(u, sourceRules)])
  );

  const candidates = snapshot.units.map((u) => ({
    unitId: u.unitId,
    retrievalText: buildRetrievalText(u, unitsById),
  }));
  taintDetector.assertClean(candidates, `engine input (retrieval candidates, ${runId})`);

  const embeddingProvider = new OpenAIEmbeddingProvider();
  console.log('вычисление embeddings для candidate pool...');
  const embeddedCandidates = await embedCandidates(candidates, embeddingProvider);

  const rerankerProvider = new LlmRerankerProvider(
    resolveExtractionRunConfig({ promptVersion: 'aurora-fixture-reranker-v1' })
  );
  const queryFrameRunConfig = resolveExtractionRunConfig({ promptVersion: 'aurora-fixture-query-frame-v1' });
  const answerGenerator = buildRealAnswerGenerator(
    resolveExtractionRunConfig({ promptVersion: 'aurora-fixture-synthesis-v1' }),
    ledger,
    traceLog
  );
  const decisionRelevanceRunConfig = resolveExtractionRunConfig({
    promptVersion: 'aurora-fixture-decision-relevance-v1',
  });

  const ctx: EngineContext = {
    embeddedCandidates,
    unitsById,
    embeddingProvider,
    rerankerProvider,
    requestContext: { audience: 'internal', now: reviewedAt },
    reviewedAt,
    queryFrameRunConfig,
    answerGenerator,
    decisionRelevanceRunConfig,
    taintDetector,
    ledger,
    traceLog,
  };

  const results: EngineQuestionResult[] = [];
  for (const question of questions) {
    console.log(`  [${runId}] ${question.caseId}: "${question.question.slice(0, 60)}..."`);
    const result = await runEngineOnQuestionWithRetry(question, ctx);
    console.log(`    -> ${result.actualDisposition}${result.errorMessage ? ` (${result.errorMessage})` : ''}`);
    results.push(result);
  }

  return {
    runId,
    snapshot,
    sourceRuleIdByUnitId,
    results,
    extractionAttemptLog: allAttemptLogs,
    batchLogs: audited.batchLogs,
    auditResults: audited.auditResults,
    focusedRetryLogs: audited.focusedRetryLogs,
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
function printPreRunCeiling(blockCount: number, args: CliArgs, questionCount: number): void {
  const RETRY_CEILING = 6; // matches extractKnowledgeUnitsWithRetry / withStructuredRetry maxAttempts
  const batchCount = Math.ceil(blockCount / args.batchSize);
  // + blockCount: audited-extraction.ts allows at most ONE focused retry per
  // block on a confirmed gap — worst case, every block triggers one.
  const extractionCeilingPerRun = (batchCount + blockCount) * RETRY_CEILING;
  // Targeted taint resample (Codex review, 2026-08-10, finding 4): a SEPARATE
  // re-extraction path from the focused-retry above, triggered by a taint
  // collision instead of a coverage gap — worst case every block resamples
  // on every round. Omitting this previously undercounted a real, already-
  // shipped call path (Task 31) — for a 15-block doc alone that's
  // 15 × 3 × 6 = 270 extra extraction calls before the whole-run multiplier.
  const taintResampleCeilingPerRun = blockCount * TAINT_RESAMPLE_MAX_ROUNDS * RETRY_CEILING;
  const auditCeilingPerRun = blockCount * RETRY_CEILING;
  const perRunCeiling =
    (extractionCeilingPerRun + taintResampleCeilingPerRun + auditCeilingPerRun) * MAX_TAINT_RETRY_ATTEMPTS;
  // query-frame + reranker + synthesis: the three metered per-question purposes.
  const perQuestionCeiling = 3 * MAX_ENGINE_QUESTION_RETRY_ATTEMPTS;
  const totalCeiling = perRunCeiling * args.extractionRuns + perQuestionCeiling * questionCount * args.extractionRuns;

  console.log('\n=== PRE-RUN COST CEILING (worst case — see caveats below) ===');
  console.log(`  document: ${blockCount} block(s), batch-size=${args.batchSize} -> ${batchCount} batch(es)`);
  console.log(`  extraction-runs: ${args.extractionRuns}, questions: ${questionCount}`);
  console.log(
    `  worst-case METERED structured() call ceiling: ${totalCeiling} (assumes every bounded retry maxes out — ` +
      `not a forecast; each of these can itself be up to 4 raw HTTP attempts via chat-provider.ts's own transient-error retry)`
  );
  console.log(
    `  --max-cost-usd=${args.maxCostUsd} — the run aborts the moment cumulative metered spend exceeds this, independent of the ceiling above`
  );
  console.log(
    `  NOT included in this ceiling: ${UNMETERED_PURPOSES.map((p) => p.purpose).join(', ')} (see UNMETERED_PURPOSES) — real worst case is higher.`
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

  const ledger = new CostLedger({ maxTotalUsd: args.maxCostUsd });
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
        extractionRuns: args.extractionRuns,
        questionCount: questions.length,
        taintedShingleCount: taintDetector.taintedShingleCount,
        unguardedSecretCount: taintDetector.unguardedSecretCount,
        runIds: runs.map((r) => r.runId),
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
          byPurpose: ledger.summaryByPurpose(),
          // Честно, а не молчаливым занижением: reranker и extraction/audit/
          // query-frame/synthesis метрятся, но decision-relevance (LLM-путь
          // для неопределённых EXCEPTION_RULE-кандидатов) и embeddings — ЕЩЁ
          // нет (см. UNMETERED_PURPOSES). totalUsd — нижняя граница, не полная
          // стоимость прогона, пока эти два пути не подключены.
          unmeteredPurposes: UNMETERED_PURPOSES,
        },
        callTracePath,
        abortedBy: abortedBy instanceof Error ? abortedBy.message : abortedBy ? String(abortedBy) : null,
      },
      null,
      2
    ),
    'utf8'
  );

  console.log('\n=== COST (Task 37 — нижняя граница, см. unmeteredPurposes ниже) ===');
  for (const s of ledger.summaryByPurpose()) {
    console.log(
      `  ${s.purpose}: ${s.callCount} call(s), ${s.attemptCount} attempt(s), $${s.totalUsd.toFixed(4)}` +
        (s.unpricedAttemptCount > 0 ? ` (${s.unpricedAttemptCount} attempt(s) unpriced — model has no entry in MODEL_PRICING)` : '')
    );
  }
  console.log(`  TOTAL (metered): $${ledger.totalUsd().toFixed(4)} across ${ledger.totalAttemptCount()} attempt(s)`);
  console.log(
    `  NOT YET METERED: ${UNMETERED_PURPOSES.map((p) => `${p.purpose} (${p.reason})`).join('; ')} — real spend is higher than the total above.`
  );
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
