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
  readonly unverifiableSuccessCount: number;
}

export interface CostLedgerOptions {
  /** Hard ceiling on cumulative spend across ALL purposes (Task 38). When
   *  set, `record()` throws `CostBudgetExceededError` the moment recording
   *  pushes the running total past this ceiling. `undefined` (default) —
   *  no budget, matches pre-Task-38 behavior; a ledger with no ceiling
   *  never throws. */
  readonly maxTotalUsd?: number;
  /** Hard ceiling on paid provider calls. Unlike the dollar ceiling, this
   *  can be enforced before a request starts: callers must reserve exactly
   *  once immediately before each metered external call. */
  readonly maxPaidCalls?: number;
}

/** Thrown before the provider is called when no paid-call slot remains. */
export class PaidCallBudgetExceededError extends Error {
  constructor(
    readonly purpose: string,
    readonly reservedPaidCalls: number,
    readonly maxPaidCalls: number
  ) {
    super(
      `Paid-call budget exhausted before "${purpose}": ${reservedPaidCalls}/${maxPaidCalls} ` +
        `call slots are already reserved. Provider was not called — see --max-paid-calls.`
    );
    this.name = 'PaidCallBudgetExceededError';
  }
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

/**
 * Thrown by `CostLedger.record()`, ONLY when a budget (`maxTotalUsd`) is
 * set, the moment a record contains a SUCCESS attempt whose real dollar
 * cost cannot be computed — an unpriced model, or a malformed response with
 * no usage at all. Found by Codex review (2026-08-10, finding 3): without
 * this, a "hard" budget failed OPEN for exactly the spend it can't see —
 * `totalUsd()` silently excludes unpriced/unverifiable attempts, so it
 * would never cross `maxTotalUsd` no matter how much such calls actually
 * cost. A budget that can't prove it's under the ceiling has to refuse to
 * continue, not assume the best.
 */
export class UnverifiableCostError extends Error {
  constructor(readonly purpose: string) {
    super(
      `Cost budget active but a "${purpose}" call's real cost cannot be verified ` +
        `(unpriced model, or a response with no usage at all) — failing closed rather ` +
        `than risk unbounded spend a --max-cost-usd ceiling could never see.`
    );
    this.name = 'UnverifiableCostError';
  }
}

export class CostLedger {
  private readonly attemptsByPurpose = new Map<string, CompletionAttempt[]>();
  private readonly callCountByPurpose = new Map<string, number>();
  private readonly maxTotalUsd?: number;
  private readonly maxPaidCalls?: number;
  private reservedPaidCalls = 0;

  constructor(options: CostLedgerOptions = {}) {
    this.maxTotalUsd = options.maxTotalUsd;
    this.maxPaidCalls = options.maxPaidCalls;
  }

  /** Atomically claims one paid-call slot before an external request starts.
   *  A reservation is intentionally never refunded: a request that fails or
   *  has unverifiable usage may still have reached and billed the provider. */
  reservePaidCall(purpose: string): void {
    if (this.maxPaidCalls !== undefined && this.reservedPaidCalls >= this.maxPaidCalls) {
      throw new PaidCallBudgetExceededError(purpose, this.reservedPaidCalls, this.maxPaidCalls);
    }
    this.reservedPaidCalls += 1;
  }

  totalReservedPaidCalls(): number {
    return this.reservedPaidCalls;
  }

  /** One call = one logical operation, e.g. one extraction batch or one
   *  coverage-audit call — `attempts` may hold more than one entry if that
   *  operation retried internally; all of them count toward attemptCount.
   *
   *  When a budget is set: throws `UnverifiableCostError` first if THIS
   *  record contains a SUCCESS attempt whose cost can't be priced at all
   *  (checked before the ceiling comparison — an unverifiable attempt could
   *  itself be the one that would have tripped the ceiling, silently).
   *  Otherwise throws `CostBudgetExceededError` if this record pushes the
   *  ledger's cumulative total past `maxTotalUsd`. Either way the record
   *  itself always completes first — see each error's docstring for why. */
  record(purpose: string, attempts: readonly CompletionAttempt[]): void {
    const existing = this.attemptsByPurpose.get(purpose) ?? [];
    this.attemptsByPurpose.set(purpose, [...existing, ...attempts]);
    this.callCountByPurpose.set(purpose, (this.callCountByPurpose.get(purpose) ?? 0) + 1);

    if (this.maxTotalUsd === undefined) return;

    const thisRecordCost = estimateCostFromAttempts(attempts);
    if (thisRecordCost.unpricedAttemptCount > 0 || thisRecordCost.unverifiableSuccessCount > 0) {
      throw new UnverifiableCostError(purpose);
    }
    if (this.totalUsd() > this.maxTotalUsd) {
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
        unverifiableSuccessCount: cost.unverifiableSuccessCount,
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
