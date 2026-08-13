import { appendFileSync } from 'node:fs';
import type { ChatMessage, CompletionAttempt, CompletionUsage } from './chat-provider';
import { estimateCostUsd } from './cost';

/**
 * Call-trace log (2026-08-10). Built directly off the user's explicit
 * debugging need after another day of repeated benchmark runs: "if we ask
 * the neural network something, we need to log the question — only then
 * can we match the answer to the question and find where something went
 * wrong." `CostLedger` (Task 37) already answers "how much did this cost";
 * this answers "what did we actually send, and what did we actually get
 * back" — per call, correlatable with the purpose tags `CostLedger` already
 * uses (extraction/coverage-audit/query-frame/synthesis/reranker).
 *
 * A FAILED attempt is traced too, not just the final successful call — the
 * same discipline `CostLedger` learned the hard way (095feb0): a
 * SCHEMA_MISMATCH means the HTTP call succeeded and produced a real, if
 * invalid, response. Seeing that raw response next to the exact prompt that
 * produced it is the whole point — it is what would have made the Task 36
 * SCHEMA_MISMATCH root cause (43/43 identical failures) obvious immediately
 * instead of taking most of a session to find.
 */

export interface CallTraceAttempt {
  /** 1-based position within this logical call. */
  readonly attemptIndex: number;
  readonly provider: string;
  readonly model: string;
  readonly startedAt: string;
  readonly latencyMs: number;
  readonly outcome: CompletionAttempt['outcome'];
  readonly statusCode?: number;
  readonly errorCode?: string;
  /** Provider counters verbatim, including cache creation/read when present. */
  readonly usage: CompletionUsage | null;
  /** `null` means missing usage or an unpriced model, never a free call. */
  readonly estimatedUsd: number | null;
}

export interface CallTraceCorrelation {
  readonly runId: string;
  readonly stage: string;
  readonly batchIndex?: number;
  readonly blockAnchor?: string;
  readonly blockAnchors?: readonly string[];
  readonly caseId?: string;
  readonly engineProvider?: string;
  readonly engineModel?: string;
  readonly engineProfile?: string;
}

export function attributeAttemptCosts(attempts: readonly CompletionAttempt[]): CallTraceAttempt[] {
  return attempts.map((attempt, index) => ({
    attemptIndex: index + 1,
    provider: attempt.provider,
    model: attempt.model,
    startedAt: attempt.startedAt,
    latencyMs: attempt.latencyMs,
    outcome: attempt.outcome,
    ...(attempt.statusCode !== undefined && { statusCode: attempt.statusCode }),
    ...(attempt.errorCode !== undefined && { errorCode: attempt.errorCode }),
    usage: attempt.usage ?? null,
    estimatedUsd: attempt.usage === undefined ? null : estimateCostUsd(attempt.model, attempt.usage),
  }));
}

export interface CallTraceEntry {
  /** Correlates prompt, response, and every raw provider attempt. */
  readonly callId: string;
  readonly correlation: CallTraceCorrelation;
  readonly timestamp: string; // ISO-8601
  /** Same purpose tags as `CostLedger`: 'extraction' | 'coverage-audit' |
   *  'query-frame' | 'synthesis' | 'reranker' | ... — not a closed union
   *  here so a new purpose never needs a matching type change in this file. */
  readonly purpose: string;
  readonly provider: string;
  readonly model: string;
  readonly outcome: 'SUCCESS' | 'ERROR';
  readonly attempts: readonly CallTraceAttempt[];
  readonly requestMessages: readonly ChatMessage[];
  /** Raw response text. `null` ONLY when the call failed before any
   *  response existed at all (pure transport failure — `ChatCompletionError`
   *  with no successful attempt behind it); a SCHEMA_MISMATCH or
   *  TRUNCATED_JSON still has a real (if invalid) response and must carry
   *  it here, not `null`. */
  readonly responseText: string | null;
  readonly errorMessage: string | null;
}

/** Sum of exactly the priced provider attempts represented by the trace. */
export function pricedTraceTotalUsd(entries: readonly CallTraceEntry[]): number {
  return entries.reduce(
    (total, entry) => total + entry.attempts.reduce(
      (callTotal, attempt) => callTotal + (attempt.estimatedUsd ?? 0),
      0
    ),
    0
  );
}

export class CallTraceLog {
  private readonly entries: CallTraceEntry[] = [];

  /** `filePath` is optional — unit tests and any other in-process consumer
   *  that only needs `all()` don't pay a filesystem dependency for it. When
   *  given, every `record()` immediately appends one JSON line (JSONL) to
   *  it, the same discipline as `CostLedger`'s write-through artifacts: a
   *  run aborted mid-way (budget ceiling, taint retry exhaustion, a crash)
   *  still leaves every call traced up to that point on disk, not just
   *  whatever made it into a final summary. */
  constructor(private readonly filePath?: string) {}

  record(entry: CallTraceEntry): void {
    this.entries.push(entry);
    if (this.filePath) {
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8');
    }
  }

  all(): readonly CallTraceEntry[] {
    return this.entries;
  }
}
