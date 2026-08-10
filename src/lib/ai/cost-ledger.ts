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

export interface CostLedgerOptions {
  /** Hard ceiling on cumulative spend across ALL purposes (Task 38). When
   *  set, `record()` throws `CostBudgetExceededError` the moment recording
   *  pushes the running total past this ceiling. `undefined` (default) —
   *  no budget, matches pre-Task-38 behavior; a ledger with no ceiling
   *  never throws. */
  readonly maxTotalUsd?: number;
}

/**
 * Thrown by `CostLedger.record()` when a record pushes cumulative spend
 * past `maxTotalUsd`. The attempt that tripped it is STILL recorded before
 * throwing — the money was already spent by the time usage is known (you
 * can't un-spend a completed API call), so the ledger's job is to stop
 * further calls, not to pretend the tripping one didn't happen.
 */
export class CostBudgetExceededError extends Error {
  constructor(
    readonly purpose: string,
    readonly totalUsd: number,
    readonly maxTotalUsd: number
  ) {
    super(
      `Cost budget exceeded: $${totalUsd.toFixed(4)} > $${maxTotalUsd.toFixed(4)} ceiling ` +
        `(tripped by a "${purpose}" call). No further paid calls should be made — see --max-cost-usd.`
    );
    this.name = 'CostBudgetExceededError';
  }
}

export class CostLedger {
  private readonly attemptsByPurpose = new Map<string, CompletionAttempt[]>();
  private readonly callCountByPurpose = new Map<string, number>();
  private readonly maxTotalUsd?: number;

  constructor(options: CostLedgerOptions = {}) {
    this.maxTotalUsd = options.maxTotalUsd;
  }

  /** One call = one logical operation, e.g. one extraction batch or one
   *  coverage-audit call — `attempts` may hold more than one entry if that
   *  operation retried internally; all of them count toward attemptCount.
   *
   *  Throws `CostBudgetExceededError` if this record pushes the ledger's
   *  cumulative total past `maxTotalUsd` (when a budget is set). The record
   *  itself always completes first — see `CostBudgetExceededError`'s
   *  docstring for why. */
  record(purpose: string, attempts: readonly CompletionAttempt[]): void {
    const existing = this.attemptsByPurpose.get(purpose) ?? [];
    this.attemptsByPurpose.set(purpose, [...existing, ...attempts]);
    this.callCountByPurpose.set(purpose, (this.callCountByPurpose.get(purpose) ?? 0) + 1);

    if (this.maxTotalUsd !== undefined && this.totalUsd() > this.maxTotalUsd) {
      throw new CostBudgetExceededError(purpose, this.totalUsd(), this.maxTotalUsd);
    }
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
