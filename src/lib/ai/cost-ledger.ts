import type { CompletionAttempt } from './chat-provider';
import { estimateCostFromAttempts } from './cost';

/**
 * Session-level cost ledger (Task 37, 2026-08-09). `cost.ts` prices a single
 * attempt array; this groups attempts by "purpose" (extraction/coverage-audit/
 * query-frame/synthesis/reranker/...) across a whole benchmark run, so the
 * runner can print real per-stage cost instead of one opaque total — the
 * concrete gap that let a $19.79/day Sonnet 5 spend go unexplained.
 */

export interface CostLedgerPurposeSummary {
  readonly purpose: string;
  /** Number of `record()` calls for this purpose — one per logical operation
   *  (e.g. one extraction batch), NOT one per retry attempt inside it. */
  readonly callCount: number;
  /** Number of individual attempts, including retries within a call. */
  readonly attemptCount: number;
  readonly totalUsd: number;
  readonly pricedAttemptCount: number;
  readonly unpricedAttemptCount: number;
}

export class CostLedger {
  private readonly attemptsByPurpose = new Map<string, CompletionAttempt[]>();
  private readonly callCountByPurpose = new Map<string, number>();

  /** One call = one logical operation, e.g. one extraction batch or one
   *  coverage-audit call — `attempts` may hold more than one entry if that
   *  operation retried internally; all of them count toward attemptCount. */
  record(purpose: string, attempts: readonly CompletionAttempt[]): void {
    const existing = this.attemptsByPurpose.get(purpose) ?? [];
    this.attemptsByPurpose.set(purpose, [...existing, ...attempts]);
    this.callCountByPurpose.set(purpose, (this.callCountByPurpose.get(purpose) ?? 0) + 1);
  }

  summaryByPurpose(): readonly CostLedgerPurposeSummary[] {
    return [...this.attemptsByPurpose.entries()].map(([purpose, attempts]) => {
      const cost = estimateCostFromAttempts(attempts);
      return {
        purpose,
        callCount: this.callCountByPurpose.get(purpose) ?? 0,
        attemptCount: attempts.length,
        totalUsd: cost.totalUsd,
        pricedAttemptCount: cost.pricedAttemptCount,
        unpricedAttemptCount: cost.unpricedAttemptCount,
      };
    });
  }

  totalUsd(): number {
    return this.summaryByPurpose().reduce((sum, s) => sum + s.totalUsd, 0);
  }

  totalAttemptCount(): number {
    return this.summaryByPurpose().reduce((sum, s) => sum + s.attemptCount, 0);
  }
}
