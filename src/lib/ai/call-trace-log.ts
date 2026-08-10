import { appendFileSync } from 'node:fs';
import type { ChatMessage } from './chat-provider';

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

export interface CallTraceEntry {
  readonly timestamp: string; // ISO-8601
  /** Same purpose tags as `CostLedger`: 'extraction' | 'coverage-audit' |
   *  'query-frame' | 'synthesis' | 'reranker' | ... — not a closed union
   *  here so a new purpose never needs a matching type change in this file. */
  readonly purpose: string;
  readonly provider: string;
  readonly model: string;
  readonly outcome: 'SUCCESS' | 'ERROR';
  readonly requestMessages: readonly ChatMessage[];
  /** Raw response text. `null` ONLY when the call failed before any
   *  response existed at all (pure transport failure — `ChatCompletionError`
   *  with no successful attempt behind it); a SCHEMA_MISMATCH or
   *  TRUNCATED_JSON still has a real (if invalid) response and must carry
   *  it here, not `null`. */
  readonly responseText: string | null;
  readonly errorMessage: string | null;
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
