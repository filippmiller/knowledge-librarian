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
import { mkdirSync, writeFileSync } from 'node:fs';
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
import type { BatchExtractionLog } from '../src/lib/knowledge/batch-extraction';
import {
  auditBlockCoverage,
  type AuditBlockCoverageOptions,
  type BlockCoverageAuditResult,
} from '../src/lib/knowledge/extraction-coverage-auditor';
import { ChatCompletionError } from '../src/lib/ai/chat-provider';
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
import { loadSemanticRuleOracle, ORACLE_PACK_DIR, SOURCE_DOCX_FILENAME } from '../src/lib/eval/semantic-rule-oracle';
import { loadNegativeCaseOracle } from '../src/lib/eval/negative-case-oracle';
import { loadSourceRulesFromDocx, type SourceRule } from '../src/lib/eval/source-rule-segmentation';
import { resolveSourceRuleId } from '../src/lib/eval/source-rule-mapping';
import { buildOracleTaintDetector, OracleTaintError, type OracleTaintDetector } from '../src/lib/eval/oracle-taint';

// ─────────────────────────────────── CLI ────────────────────────────────────

const SUPPORTED_MODES = ['e2e'] as const;
type Mode = (typeof SUPPORTED_MODES)[number];

interface CliArgs {
  readonly mode: Mode;
  readonly extractionRuns: number;
  readonly outDir: string;
  readonly docPath: string;
  readonly batchSize: number;
}

const USAGE =
  'Usage: npx tsx scripts/run-aurora-fixture.ts --mode=e2e --extraction-runs=N --out=path/to/dir [--doc=path/to/source.docx] [--batch-size=N]';

function parseArgs(argv: readonly string[]): CliArgs {
  const known = ['--mode=', '--extraction-runs=', '--out=', '--doc=', '--batch-size='];
  const unknown = argv.filter((a) => !known.some((k) => a.startsWith(k)));
  if (unknown.length > 0) {
    throw new Error(`Неизвестные аргументы: ${unknown.join(', ')}\n${USAGE}`);
  }

  const modeArg = argv.find((a) => a.startsWith('--mode='))?.slice('--mode='.length);
  const runsArg = argv.find((a) => a.startsWith('--extraction-runs='))?.slice('--extraction-runs='.length);
  const outArg = argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
  const docArg = argv.find((a) => a.startsWith('--doc='))?.slice('--doc='.length);
  const batchSizeArg = argv.find((a) => a.startsWith('--batch-size='))?.slice('--batch-size='.length);

  if (!modeArg || !outArg) {
    throw new Error(`--mode и --out обязательны.\n${USAGE}`);
  }
  if (!(SUPPORTED_MODES as readonly string[]).includes(modeArg)) {
    throw new Error(`Неподдержанный режим "${modeArg}". Поддержан только: ${SUPPORTED_MODES.join(', ')}.`);
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
  readonly actualDisposition: 'DIRECT_ANSWER' | 'HOLD' | 'ERROR';
  readonly errorMessage: string | null;
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
  readonly taintDetector: OracleTaintDetector;
}

interface ExtractionAttemptLog {
  readonly attempt: number;
  readonly outcome: 'SUCCESS' | 'SCHEMA_MISMATCH' | 'TRUNCATED_JSON' | 'NETWORK_ERROR' | 'OTHER_ERROR';
  readonly message: string | null;
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
 */
async function withStructuredRetry<T>(
  call: () => Promise<T>,
  maxAttempts: number,
  label: string
): Promise<{ result: T; attemptLog: ExtractionAttemptLog[] }> {
  const attemptLog: ExtractionAttemptLog[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await call();
      attemptLog.push({ attempt, outcome: 'SUCCESS', message: null });
      return { result, attemptLog };
    } catch (error) {
      const outcome: ExtractionAttemptLog['outcome'] =
        error instanceof StructuredOutputError
          ? error.reason === 'SCHEMA_MISMATCH'
            ? 'SCHEMA_MISMATCH'
            : error.reason === 'TRUNCATED_JSON'
              ? 'TRUNCATED_JSON'
              : 'OTHER_ERROR'
          : error instanceof ChatCompletionError
            ? 'NETWORK_ERROR'
            : 'OTHER_ERROR';
      const retryable = outcome !== 'OTHER_ERROR';
      attemptLog.push({
        attempt,
        outcome,
        message: error instanceof Error ? error.message : String(error),
      });
      console.warn(`[${label} attempt ${attempt}/${maxAttempts}] failed (${outcome}): ${attemptLog[attemptLog.length - 1].message}`);
      if (!retryable || attempt === maxAttempts) throw error;
    }
  }
  throw new Error(`withStructuredRetry(${label}): unreachable`);
}

async function extractKnowledgeUnitsWithRetry(
  options: ExtractKnowledgeUnitsOptions,
  maxAttempts: number
): Promise<{ result: ExtractKnowledgeUnitsResult; attemptLog: ExtractionAttemptLog[] }> {
  return withStructuredRetry(() => extractKnowledgeUnits(options), maxAttempts, 'extraction');
}

const answerSchema = z.strictObject({
  text: z.string(),
  citedUnitIds: z.array(z.string()).readonly(),
});

function buildRealAnswerGenerator(
  runConfig: ReturnType<typeof resolveExtractionRunConfig>
): AnswerGenerator {
  return async (prompt) => {
    const evidenceText = prompt.evidence
      .map((e) => `[${e.unitId}] ${e.statement}${e.numericConstraint ? ` (${e.numericConstraint.factKey}: ${e.numericConstraint.value} ${e.numericConstraint.unit})` : ''}`)
      .join('\n');
    const result = await structured({
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
    });
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

    const { queryFrame } = await extractQueryFrame({
      messages: [message],
      runConfig: ctx.queryFrameRunConfig,
    });

    const retrieval = await retrieveUnits(input.question, ctx.embeddedCandidates, {
      embeddingProvider: ctx.embeddingProvider,
      rerankerProvider: ctx.rerankerProvider,
    });

    const candidateUnits = retrieval.topK
      .map((id) => ctx.unitsById.get(id))
      .filter((u): u is PersistedKnowledgeUnit => u !== undefined);
    const evaluatedCandidates = candidateUnits.map((u) =>
      buildEvaluatedCandidate(u, queryFrame, ctx.requestContext, ctx.reviewedAt)
    );

    const resolution = resolveKnowledgeSet(evaluatedCandidates, queryFrame);

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
      actualDisposition: 'DIRECT_ANSWER',
      errorMessage: null,
    };
  } catch (err) {
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
    };
  }
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
  taintDetector: OracleTaintDetector
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
    const { result, attemptLog } = await extractKnowledgeUnitsWithRetry(options, 6);
    allAttemptLogs.push(...attemptLog);
    return result;
  };
  // Same bounded transport/schema retry as extraction itself — a real run
  // (full-smoke4) crashed the whole extraction run on a single transient
  // "fetch failed" INSIDE the coverage-audit call, which previously had no
  // retry wrapper at all.
  const retryingAuditor = async (options: AuditBlockCoverageOptions): Promise<BlockCoverageAuditResult> => {
    const { result, attemptLog } = await withStructuredRetry(() => auditBlockCoverage(options), 6, 'coverage audit');
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
    identity.units
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
    resolveExtractionRunConfig({ promptVersion: 'aurora-fixture-synthesis-v1' })
  );

  const ctx: EngineContext = {
    embeddedCandidates,
    unitsById,
    embeddingProvider,
    rerankerProvider,
    requestContext: { audience: 'internal', now: reviewedAt },
    reviewedAt,
    queryFrameRunConfig,
    answerGenerator,
    taintDetector,
  };

  const results: EngineQuestionResult[] = [];
  for (const question of questions) {
    console.log(`  [${runId}] ${question.caseId}: "${question.question.slice(0, 60)}..."`);
    const result = await runEngineOnQuestion(question, ctx);
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
 *  недействительна, нужна свежая независимая выборка (см. OracleTaintError). */
const MAX_TAINT_RETRY_ATTEMPTS = 3;

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
  taintDetector: OracleTaintDetector
): Promise<ExtractionRunOutcome> {
  for (let attempt = 1; attempt <= MAX_TAINT_RETRY_ATTEMPTS; attempt++) {
    try {
      return await runOneExtractionRun(runIndex, args, questions, sourceRules, taintDetector);
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

  mkdirSync(args.outDir, { recursive: true });

  const runs: ExtractionRunOutcome[] = [];
  for (let i = 1; i <= args.extractionRuns; i++) {
    const outcome = await runOneExtractionRunWithTaintRetry(i, args, questions, sourceRules, taintDetector);
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
          HOLD: r.results.filter((x) => x.actualDisposition === 'HOLD').length,
          ERROR: r.results.filter((x) => x.actualDisposition === 'ERROR').length,
        })),
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(`\nАртефакты записаны в: ${args.outDir}`);
  console.log('Grading — отдельным проходом (не в этом скрипте), см. scripts/grade-aurora-fixture.ts.');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('FATAL ERROR:', err);
    process.exit(1);
  });
}
