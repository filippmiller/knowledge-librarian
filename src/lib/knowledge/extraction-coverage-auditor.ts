/**
 * Oracle-blind extraction completeness auditor (goal-shift continuation,
 * 2026-08-09). Sees ONLY one source block's text + the units extracted
 * from it — never questions, never expected answers, never rule ids. This
 * is a general, production-useful mechanism (extraction can silently omit
 * content — see batch-extraction.ts's header), not a test-only check: it
 * lives in `src/lib/knowledge/` specifically so `scripts/run-extraction.ts`
 * (oracle-blind, machine-gated) can import it.
 *
 * It NEVER repairs units itself — only reports findings. A caller decides
 * whether/how to act on POSSIBLE_OMISSION/UNREPRESENTED_CLAUSE (e.g. a
 * bounded, focused re-extraction of just that block).
 */

import type { ChatMessage, CompletionAttempt } from '@/lib/ai/chat-provider';
import type { ExtractionRunConfig } from '@/lib/ai/extraction-run';
import { structured } from '@/lib/ai/structured-output';
import { z } from 'zod';

export const COVERAGE_VERDICTS = ['COVERED', 'POSSIBLE_OMISSION', 'UNREPRESENTED_CLAUSE', 'AMBIGUOUS'] as const;
export type CoverageVerdict = (typeof COVERAGE_VERDICTS)[number];

export interface ExtractedStatement {
  readonly statement: string;
  readonly quote: string;
}

export interface RawCoverageFinding {
  readonly verdict: CoverageVerdict;
  /** Empty string legal only for COVERED (nothing to quote). */
  readonly quote: string;
  readonly explanation: string;
}

export interface CoverageFinding extends RawCoverageFinding {
  /** True iff `quote` is a literal substring of the block's text — a
   *  finding whose quote the model invented/paraphrased is NOT dropped
   *  silently (it may still be a real gap the model described accurately
   *  in `explanation` without copying verbatim), but it is not trusted the
   *  same way a grounded quote is. Same discipline as `resolveEvidenceOffsets`
   *  elsewhere in this codebase: never trust a quote without checking it. */
  readonly quoteVerified: boolean;
}

export interface BlockCoverageAuditResult {
  readonly blockAnchor: string;
  readonly findings: readonly CoverageFinding[];
  /** True iff any finding is POSSIBLE_OMISSION or UNREPRESENTED_CLAUSE —
   *  a CONFIRMED gap, i.e. the one condition a focused re-extraction can
   *  actually act on (audited-extraction.ts triggers exactly one on it).
   *  AMBIGUOUS alone does not set this — an unresolved ambiguity is not the
   *  same claim as a confirmed gap — but it is no longer silent either: see
   *  `unresolved` and `coverageAuditNeedsReview` below. */
  readonly hasGap: boolean;
  /** True iff the auditor did NOT deliver a conclusive verdict for this
   *  block: at least one AMBIGUOUS finding, or no findings at all. Separate
   *  from `hasGap` on purpose — "I am not sure whether something is missing"
   *  and "something IS missing" are different claims and a reader of the
   *  audit artifact must be able to tell them apart. Neither may be treated
   *  as "covered": the single guarantee this auditor exists to provide is
   *  that no rule is silently lost, and unresolved uncertainty is not
   *  evidence of coverage.
   *
   *  Optional for the same reason as `attempts`/`requestMessages` below —
   *  hand-built fixtures for the `auditor` dependency (audited-extraction.ts)
   *  predate this field. Precisely because it can be absent, a caller gating
   *  publication must ask `coverageAuditNeedsReview()`, which derives the
   *  policy from `findings` and therefore cannot read `undefined` as clean. */
  readonly unresolved?: boolean;
  /** Attempts made by the underlying `structured()` call — source for the
   *  cost ledger (Task 37). Optional: hand-built test fixtures for the
   *  `auditor` dependency (audited-extraction.ts) never made a real call. */
  readonly attempts?: readonly CompletionAttempt[];
  /** Exact messages sent for the underlying `structured()` call — source
   *  for the call-trace log (2026-08-10), same optionality reason as
   *  `attempts` above. */
  readonly requestMessages?: readonly ChatMessage[];
  /** Raw (pre-normalization) response text of the underlying call — paired
   *  with `requestMessages` this is the whole debugging signal a call-trace
   *  entry needs: exact prompt next to exact raw response. Same optionality
   *  reason as `attempts` above. */
  readonly rawResponseText?: string;
}

const SYSTEM_PROMPT = `Ты проверяешь ПОЛНОТУ извлечения структурированных единиц знания из ОДНОГО блока исходного текста.

Тебе дан исходный текст блока и список утверждений (statement + дословная цитата), уже извлечённых из этого блока. Твоя ЕДИНСТВЕННАЯ задача — найти содержательные инструкции, запреты, условия, исключения, определения, числовые ограничения или процедурные факты В ИСХОДНОМ ТЕКСТЕ, которые НЕ представлены НИ ОДНИМ из извлечённых утверждений.

Для каждой находки укажи:
- verdict: "COVERED" (для случая "ничего не пропущено" — одна находка на весь блок), "POSSIBLE_OMISSION" (вероятно пропущено), "UNREPRESENTED_CLAUSE" (точно пропущено, содержательное утверждение отсутствует), "AMBIGUOUS" (не уверен, пропущено ли).
- quote: ДОСЛОВНАЯ цитата из исходного текста блока (для COVERED можно оставить пустой строкой).
- explanation: что именно пропущено и почему это содержательно.

Не оценивай качество формулировок extracted statements — только полноту покрытия содержания. Не изобретай пропуски, которых нет в тексте.

Пустой список findings — НЕ валидный ответ. Если ничего не пропущено, верни РОВНО ОДНУ находку с verdict "COVERED": «проверил и не нашёл пропусков» и «не проверил» не должны выглядеть одинаково.

Ответ СТРОГО JSON: {"findings": [...]}`;

export function buildCoverageAuditPromptMessages(
  blockText: string,
  extractedStatements: readonly ExtractedStatement[]
): ChatMessage[] {
  const extractedList =
    extractedStatements.length > 0
      ? extractedStatements.map((s, i) => `${i + 1}. ${s.statement} (цитата: "${s.quote}")`).join('\n')
      : '(из этого блока не извлечено ни одного unit\'а)';

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Исходный текст блока:\n${blockText}\n\nУже извлечённые утверждения:\n${extractedList}\n\nПроверь полноту покрытия.`,
    },
  ];
}

/**
 * The ONE definition of "this block came back clean" — a block is clean iff
 * the auditor produced at least one finding and EVERY finding is COVERED.
 * Anything else (a confirmed gap, an unresolved AMBIGUOUS, or no findings at
 * all) means the audit did not clear the block and a caller may not publish
 * it as covered without acting.
 *
 * Derived from `findings` rather than read from a flag on purpose: it is
 * therefore correct for any result object, including the hand-built auditor
 * fixtures in audited-extraction.test.ts and results replayed from a stored
 * `coverage-audit.json` artifact — neither of which carries `unresolved`.
 * By construction `coverageAuditNeedsReview === hasGap || unresolved`.
 */
export function coverageAuditNeedsReview(result: Pick<BlockCoverageAuditResult, 'findings'>): boolean {
  return !(result.findings.length > 0 && result.findings.every((f) => f.verdict === 'COVERED'));
}

/** Pure — no network. Verifies each finding's quote against the real block
 *  text and aggregates `hasGap`/`unresolved`. */
export function interpretCoverageAuditResponse(
  blockAnchor: string,
  blockText: string,
  rawFindings: readonly RawCoverageFinding[]
): BlockCoverageAuditResult {
  const findings: CoverageFinding[] = rawFindings.map((f) => ({
    ...f,
    quoteVerified: f.quote.length > 0 && blockText.includes(f.quote),
  }));
  const hasGap = findings.some((f) => f.verdict === 'POSSIBLE_OMISSION' || f.verdict === 'UNREPRESENTED_CLAUSE');
  // An empty findings list counts as unresolved, not as covered: the prompt
  // requires an explicit COVERED finding for a fully-covered block, so
  // silence is an anomaly (a model that gave up looks identical to a model
  // that checked and found nothing). The schema below rejects it before it
  // can ever reach here from the network path; this branch covers the paths
  // that bypass the schema — replayed artifacts and hand-built findings.
  const unresolved = findings.length === 0 || findings.some((f) => f.verdict === 'AMBIGUOUS');
  return { blockAnchor, findings, hasGap, unresolved };
}

export const coverageAuditResponseSchema = z.strictObject({
  findings: z
    .array(
      z.strictObject({
        verdict: z.enum(COVERAGE_VERDICTS),
        quote: z.string(),
        explanation: z
          .string()
          .nullish()
          .transform((v) => v ?? ''),
      })
    )
    // `{"findings": []}` is a protocol violation, not a verdict — the prompt
    // documents COVERED as the way to say "nothing is missing". Rejected at
    // the SCHEMA level rather than accepted-and-flagged so that the caller's
    // existing bounded retry (`withStructuredRetry`, 6 attempts, retries
    // SCHEMA_MISMATCH) re-asks the auditor and gets a real answer. That is
    // both the cheaper and the more useful repair: an empty response carries
    // no finding saying WHAT to look for, so the alternative — treating it as
    // a gap — would pay for a full 16k-maxTokens re-extraction of the block
    // whose new units then mostly get dropped as overlapping duplicates
    // (audited-extraction.ts), buying almost no information. If the retry
    // budget is exhausted the run fails loudly, which is the point: a block
    // is never recorded as covered on the strength of silence.
    .min(1, 'coverage audit: findings пуст — ожидается хотя бы одна находка (для полного покрытия — явный вердикт COVERED)')
    .readonly(),
});

export interface AuditBlockCoverageOptions {
  readonly blockAnchor: string;
  readonly blockText: string;
  readonly extractedStatements: readonly ExtractedStatement[];
  readonly runConfig: ExtractionRunConfig;
}

export async function auditBlockCoverage(
  options: AuditBlockCoverageOptions
): Promise<BlockCoverageAuditResult> {
  const result = await structured({
    schema: coverageAuditResponseSchema,
    messages: buildCoverageAuditPromptMessages(options.blockText, options.extractedStatements),
    runConfig: options.runConfig,
  });
  return {
    ...interpretCoverageAuditResponse(options.blockAnchor, options.blockText, result.data.findings),
    attempts: result.attempts,
    requestMessages: result.requestMessages,
    rawResponseText: result.rawText,
  };
}
