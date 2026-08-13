import { describe, expect, it } from 'vitest';
import {
  CostBudgetExceededError,
  CostLedger,
  PaidCallBudgetExceededError,
  UnverifiableCostError,
} from '../cost-ledger';
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

/** SUCCESS but no usage at all — a malformed/incomplete real response, not
 *  the same as an ERROR (see cost.ts's `unverifiableSuccessCount`). */
function unverifiableSuccess(model: string): CompletionAttempt {
  return {
    provider: 'anthropic',
    model,
    startedAt: '2026-08-09T00:00:00Z',
    latencyMs: 100,
    outcome: 'SUCCESS',
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

describe('CostLedger — hard paid-call ceiling', () => {
  it('reserves up to the ceiling and fails before consuming another slot', () => {
    const ledger = new CostLedger({ maxPaidCalls: 2 });
    ledger.reservePaidCall('extraction');
    ledger.reservePaidCall('coverage-audit');

    expect(() => ledger.reservePaidCall('synthesis')).toThrow(PaidCallBudgetExceededError);
    expect(ledger.totalReservedPaidCalls()).toBe(2);
  });

  it('error identifies the blocked purpose and proves the provider call was not reserved', () => {
    const ledger = new CostLedger({ maxPaidCalls: 1 });
    ledger.reservePaidCall('query-frame');

    try {
      ledger.reservePaidCall('reranker');
      expect.fail('expected paid-call ceiling');
    } catch (error) {
      expect(error).toBeInstanceOf(PaidCallBudgetExceededError);
      expect(error).toMatchObject({ purpose: 'reranker', reservedPaidCalls: 1, maxPaidCalls: 1 });
    }
    expect(ledger.totalReservedPaidCalls()).toBe(1);
  });

  it('does not refund a reservation when the eventual provider attempt fails', () => {
    const ledger = new CostLedger({ maxPaidCalls: 1 });
    ledger.reservePaidCall('extraction');
    ledger.record('extraction', [errorAttempt('claude-sonnet-5')]);
    expect(() => ledger.reservePaidCall('extraction-retry')).toThrow(PaidCallBudgetExceededError);
  });

  it('without a ceiling remains backwards-compatible', () => {
    const ledger = new CostLedger();
    for (let i = 0; i < 100; i++) ledger.reservePaidCall('test');
    expect(ledger.totalReservedPaidCalls()).toBe(100);
  });
});

describe('CostLedger — hard budget (Task 38)', () => {
  it('без maxTotalUsd (по умолчанию) — record() никогда не бросает, сколько бы ни потратили', () => {
    const ledger = new CostLedger();
    expect(() =>
      ledger.record('extraction', [success('claude-sonnet-5', 10_000_000, 10_000_000)])
    ).not.toThrow();
  });

  it('record(), который остаётся В ПРЕДЕЛАХ бюджета, не бросает', () => {
    const ledger = new CostLedger({ maxTotalUsd: 1.0 });
    expect(() => ledger.record('extraction', [success('claude-sonnet-5', 100_000, 0)])).not.toThrow(); // $0.20
  });

  it('record(), который ПРЕВЫШАЕТ бюджет — бросает CostBudgetExceededError, но попытка уже посчитана (деньги реально потрачены)', () => {
    const ledger = new CostLedger({ maxTotalUsd: 1.0 });
    let caught: unknown;
    try {
      ledger.record('extraction', [success('claude-sonnet-5', 1_000_000, 0)]); // $2, > $1 бюджета
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CostBudgetExceededError);
    // Попытка, которая пробила бюджет, ВСЁ РАВНО учтена — деньги уже потрачены,
    // выбрасывание останавливает ДАЛЬНЕЙШИЕ вызовы, не стирает прошлое.
    expect(ledger.totalUsd()).toBeCloseTo(2.0, 5);
  });

  it('CostBudgetExceededError несёт purpose/totalUsd/maxTotalUsd для читаемого сообщения', () => {
    const ledger = new CostLedger({ maxTotalUsd: 0.5 });
    try {
      ledger.record('coverage-audit', [success('claude-sonnet-5', 1_000_000, 0)]);
      expect.fail('ожидалось исключение');
    } catch (err) {
      expect(err).toBeInstanceOf(CostBudgetExceededError);
      const budgetErr = err as CostBudgetExceededError;
      expect(budgetErr.purpose).toBe('coverage-audit');
      expect(budgetErr.totalUsd).toBeCloseTo(2.0, 5);
      expect(budgetErr.maxTotalUsd).toBe(0.5);
    }
  });

  it('после превышения бюджета дальнейшие record() тоже бросают — бюджет не сбрасывается сам', () => {
    const ledger = new CostLedger({ maxTotalUsd: 0.1 });
    expect(() => ledger.record('extraction', [success('claude-sonnet-5', 1_000_000, 0)])).toThrow(
      CostBudgetExceededError
    );
    expect(() => ledger.record('extraction', [success('claude-sonnet-5', 1, 1)])).toThrow(
      CostBudgetExceededError
    );
  });
});

describe('CostLedger — fail-closed на непроверяемой стоимости (Codex review, 2026-08-10, finding 3)', () => {
  // Найдено ревью: бюджет считался по totalUsd(), а unpriced/no-usage
  // попытки в нём не участвуют вообще — бюджетированный прогон на
  // непрайсованной модели (например дефолтной claude-3-opus-20240229, у
  // которой нет записи в MODEL_PRICING) никогда бы не сработал, сколько бы
  // реально ни потратили. "Жёсткий" бюджет обязан отказывать закрыто
  // (fail closed), а не молча пропускать то, что не может проверить.

  it('unpriced-модель под бюджетом -> бросает UnverifiableCostError, не тихо проходит', () => {
    const ledger = new CostLedger({ maxTotalUsd: 100 }); // бюджет заведомо не исчерпан
    let caught: unknown;
    try {
      ledger.record('extraction', [success('mystery-model-2099', 100, 50)]);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnverifiableCostError);
  });

  it('SUCCESS без usage вообще под бюджетом -> тоже бросает UnverifiableCostError', () => {
    const ledger = new CostLedger({ maxTotalUsd: 100 });
    expect(() => ledger.record('extraction', [unverifiableSuccess('claude-sonnet-5')])).toThrow(
      UnverifiableCostError
    );
  });

  it('без maxTotalUsd — unpriced/unverifiable попытки НЕ бросают (нечего защищать без бюджета)', () => {
    const ledger = new CostLedger();
    expect(() => ledger.record('extraction', [success('mystery-model-2099', 100, 50)])).not.toThrow();
    expect(() => ledger.record('extraction', [unverifiableSuccess('claude-sonnet-5')])).not.toThrow();
  });

  it('попытка ВСЁ РАВНО учтена перед выбрасыванием — не стирается из summary', () => {
    const ledger = new CostLedger({ maxTotalUsd: 100 });
    try {
      ledger.record('extraction', [success('mystery-model-2099', 100, 50)]);
    } catch {
      // ожидаемо
    }
    expect(ledger.summaryByPurpose()[0].unpricedAttemptCount).toBe(1);
  });

  it('UnverifiableCostError несёт purpose для читаемого сообщения', () => {
    const ledger = new CostLedger({ maxTotalUsd: 100 });
    try {
      ledger.record('coverage-audit', [success('mystery-model-2099', 100, 50)]);
      expect.fail('ожидалось исключение');
    } catch (err) {
      expect(err).toBeInstanceOf(UnverifiableCostError);
      expect((err as UnverifiableCostError).purpose).toBe('coverage-audit');
    }
  });

  it('прайсованный SUCCESS в том же record() рядом с unpriced — бюджет всё равно бросает fail-closed', () => {
    const ledger = new CostLedger({ maxTotalUsd: 100 });
    expect(() =>
      ledger.record('extraction', [success('claude-sonnet-5', 100, 50), success('mystery-model-2099', 100, 50)])
    ).toThrow(UnverifiableCostError);
  });
});
