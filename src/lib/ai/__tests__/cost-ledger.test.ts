import { describe, expect, it } from 'vitest';
import { CostLedger } from '../cost-ledger';
import type { CompletionAttempt } from '../chat-provider';

/**
 * Session-level cost ledger (Task 37, 2026-08-09) — groups CompletionAttempt[]
 * by "purpose" (extraction/coverage-audit/query-frame/synthesis/reranker/...)
 * so a benchmark run can print real per-stage cost, not just a single opaque
 * total. Built directly in response to the user's demand for per-stage
 * accounting after an unexplained $19.79/day Sonnet 5 spend.
 */

function success(model: string, inputTokens: number, outputTokens: number): CompletionAttempt {
  return {
    provider: 'anthropic',
    model,
    startedAt: '2026-08-09T00:00:00Z',
    latencyMs: 100,
    outcome: 'SUCCESS',
    usage: { inputTokens, outputTokens },
  };
}

function errorAttempt(model: string): CompletionAttempt {
  return {
    provider: 'anthropic',
    model,
    startedAt: '2026-08-09T00:00:00Z',
    latencyMs: 50,
    outcome: 'ERROR',
  };
}

describe('CostLedger', () => {
  it('пустой ledger -> нулевая сводка, не ошибка', () => {
    const ledger = new CostLedger();
    expect(ledger.totalUsd()).toBe(0);
    expect(ledger.totalAttemptCount()).toBe(0);
    expect(ledger.summaryByPurpose()).toEqual([]);
  });

  it('одна запись -> summary по этой purpose с правильными totals', () => {
    const ledger = new CostLedger();
    ledger.record('extraction', [success('claude-sonnet-5', 1_000_000, 1_000_000)]);

    const summary = ledger.summaryByPurpose();
    expect(summary).toHaveLength(1);
    expect(summary[0].purpose).toBe('extraction');
    expect(summary[0].callCount).toBe(1);
    expect(summary[0].attemptCount).toBe(1);
    expect(summary[0].totalUsd).toBeCloseTo(12.0, 5); // $2 + $10 за Sonnet 5 intro pricing
  });

  it('несколько record() на одну purpose -> накапливается, callCount растёт на каждый record()', () => {
    const ledger = new CostLedger();
    ledger.record('coverage-audit', [success('claude-sonnet-5', 500, 200)]);
    ledger.record('coverage-audit', [success('claude-sonnet-5', 300, 100)]);

    const summary = ledger.summaryByPurpose();
    expect(summary).toHaveLength(1);
    expect(summary[0].callCount).toBe(2);
    expect(summary[0].attemptCount).toBe(2);
  });

  it('несколько попыток в ОДНОМ record() (retry) -> все считаются, но это ОДИН callCount', () => {
    const ledger = new CostLedger();
    // Реальный случай: 2 неудачные попытки + 1 успешная в одном withStructuredRetry.
    ledger.record('extraction', [errorAttempt('claude-sonnet-5'), errorAttempt('claude-sonnet-5'), success('claude-sonnet-5', 100, 50)]);

    const summary = ledger.summaryByPurpose();
    expect(summary[0].callCount).toBe(1);
    expect(summary[0].attemptCount).toBe(3);
  });

  it('разные purposes остаются раздельными строками в summary', () => {
    const ledger = new CostLedger();
    ledger.record('extraction', [success('claude-sonnet-5', 1000, 500)]);
    ledger.record('query-frame', [success('claude-sonnet-5', 200, 100)]);

    const purposes = ledger.summaryByPurpose().map((s) => s.purpose);
    expect(purposes).toEqual(['extraction', 'query-frame']);
  });

  it('totalUsd() суммирует по ВСЕМ purposes вместе', () => {
    const ledger = new CostLedger();
    ledger.record('extraction', [success('claude-sonnet-5', 1_000_000, 0)]); // $2
    ledger.record('query-frame', [success('claude-sonnet-5', 0, 1_000_000)]); // $10
    expect(ledger.totalUsd()).toBeCloseTo(12.0, 5);
  });

  it('непрайсованная модель -> не молча теряется, попадает в unpricedAttemptCount той purpose', () => {
    const ledger = new CostLedger();
    ledger.record('extraction', [success('mystery-model', 100, 50)]);
    const summary = ledger.summaryByPurpose();
    expect(summary[0].totalUsd).toBe(0);
    expect(summary[0].unpricedAttemptCount).toBe(1);
  });

  it('попытка без usage (ERROR) не участвует ни в total, ни в priced/unpriced счётчиках', () => {
    const ledger = new CostLedger();
    ledger.record('extraction', [errorAttempt('claude-sonnet-5')]);
    const summary = ledger.summaryByPurpose();
    expect(summary[0].totalUsd).toBe(0);
    expect(summary[0].pricedAttemptCount).toBe(0);
    expect(summary[0].unpricedAttemptCount).toBe(0);
    expect(summary[0].attemptCount).toBe(1); // но попытка сама всё равно посчитана
  });

  it('totalAttemptCount() суммирует attemptCount по всем purposes', () => {
    const ledger = new CostLedger();
    ledger.record('extraction', [success('claude-sonnet-5', 100, 50), errorAttempt('claude-sonnet-5')]);
    ledger.record('reranker', [success('claude-sonnet-5', 10, 5)]);
    expect(ledger.totalAttemptCount()).toBe(3);
  });
});
