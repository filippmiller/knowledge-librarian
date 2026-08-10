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
  /** True iff any finding is POSSIBLE_OMISSION or UNREPRESENTED_CLAUSE.
   *  AMBIGUOUS alone does not set this — an unresolved ambiguity is not the
   *  same claim as a confirmed gap. */
  readonly hasGap: boolean;
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

/** Pure — no network. Verifies each finding's quote against the real block
 *  text and aggregates `hasGap`. */
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
  return { blockAnchor, findings, hasGap };
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
