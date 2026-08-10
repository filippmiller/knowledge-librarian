import { describe, expect, it } from 'vitest';
import { estimateCostUsd, estimateCostFromAttempts, MODEL_PRICING } from '../cost';
import type { CompletionAttempt } from '../chat-provider';

/**
 * Cost meter (Task 37, 2026-08-09) — user audit of a day burning $19.79 on
 * Sonnet 5 alone surfaced that nothing in the codebase computed cost from
 * real token usage. Pricing here is sourced from the authoritative
 * `claude-api` skill (Anthropic's own current pricing reference, checked
 * 2026-08-09) for Anthropic models — NOT from memory. OpenAI pricing is
 * best-effort public knowledge, explicitly flagged as unverified in this
 * session (see MODEL_PRICING's own comments) since no equivalent
 * authoritative live source was available.
 */

describe('estimateCostUsd', () => {
  it('считает стоимость по известной модели (Sonnet 5, intro pricing $2/$10 за 1M)', () => {
    const cost = estimateCostUsd('claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(cost).toBeCloseTo(2.0 + 10.0, 5);
  });

  it('пропорционально масштабирует для реальных (некруглых) значений токенов', () => {
    const cost = estimateCostUsd('claude-sonnet-5', { inputTokens: 500, outputTokens: 200 });
    // 500/1e6 * $2 + 200/1e6 * $10
    expect(cost).toBeCloseTo(500 / 1_000_000 * 2.0 + 200 / 1_000_000 * 10.0, 10);
  });

  // Кросс-аудит 2026-08-10: у Anthropic `input_tokens` — только НЕкэшированный
  // остаток промпта. Считая один его, ledger занижал расход ровно тогда, когда
  // кэш заработал, и жёсткий потолок снова отказывал бы открыто.
  it('кэш-запись тарифицируется дороже обычного входа (1.25x), кэш-чтение дешевле (0.1x)', () => {
    const cost = estimateCostUsd('claude-sonnet-5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
    });
    // $2/1M за вход => запись 2*1.25 = 2.5, чтение 2*0.1 = 0.2
    expect(cost).toBeCloseTo(2.5 + 0.2, 5);
  });

  it('без кэш-полей считает как раньше — обратная совместимость', () => {
    expect(estimateCostUsd('claude-sonnet-5', { inputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(2.0, 5);
  });

  it('неизвестная модель -> null, а не 0 или исключение (0 выглядел бы как бесплатный вызов)', () => {
    expect(estimateCostUsd('some-model-nobody-priced-yet', { inputTokens: 100, outputTokens: 50 })).toBeNull();
  });

  it('MODEL_PRICING содержит реально используемые в этом кодбейзе модели', () => {
    expect(MODEL_PRICING['claude-sonnet-5']).toBeDefined();
    expect(MODEL_PRICING['claude-haiku-4-5-20251001']).toBeDefined();
    expect(MODEL_PRICING['gpt-4o']).toBeDefined();
    expect(MODEL_PRICING['text-embedding-3-small']).toBeDefined();
  });
});

describe('estimateCostFromAttempts', () => {
  function attempt(overrides: Partial<CompletionAttempt> & { model: string }): CompletionAttempt {
    return {
      provider: 'anthropic',
      startedAt: '2026-08-09T00:00:00Z',
      latencyMs: 100,
      outcome: 'SUCCESS',
      ...overrides,
    };
  }

  it('суммирует стоимость только SUCCESS-попыток с usage; попытка вовсе БЕЗ usage (ERROR) просто пропускается — это не то же самое, что "unpriced" (usage есть, но модель без цены)', () => {
    const attempts: CompletionAttempt[] = [
      attempt({ model: 'claude-sonnet-5', outcome: 'SUCCESS', usage: { inputTokens: 1000, outputTokens: 500 } }),
      attempt({ model: 'claude-sonnet-5', outcome: 'ERROR' }), // без usage — не priced и не unpriced, просто нечего считать
      attempt({ model: 'claude-sonnet-5', outcome: 'SUCCESS', usage: { inputTokens: 2000, outputTokens: 1000 } }),
    ];
    const result = estimateCostFromAttempts(attempts);
    const expected =
      (1000 / 1_000_000) * 2.0 + (500 / 1_000_000) * 10.0 + (2000 / 1_000_000) * 2.0 + (1000 / 1_000_000) * 10.0;
    expect(result.totalUsd).toBeCloseTo(expected, 10);
    expect(result.pricedAttemptCount).toBe(2);
    expect(result.unpricedAttemptCount).toBe(0);
  });

  it('попытка с usage, но по непрайсованной модели -> считается unpriced, не молча пропускается', () => {
    const attempts: CompletionAttempt[] = [
      attempt({ model: 'mystery-model-2099', outcome: 'SUCCESS', usage: { inputTokens: 100, outputTokens: 50 } }),
    ];
    const result = estimateCostFromAttempts(attempts);
    expect(result.totalUsd).toBe(0);
    expect(result.pricedAttemptCount).toBe(0);
    expect(result.unpricedAttemptCount).toBe(1);
  });

  it('пустой список попыток -> нулевая, не ошибочная, стоимость', () => {
    const result = estimateCostFromAttempts([]);
    expect(result.totalUsd).toBe(0);
    expect(result.pricedAttemptCount).toBe(0);
    expect(result.unpricedAttemptCount).toBe(0);
  });

  // Codex review (2026-08-10) finding 3: a SUCCESS attempt with NO usage at
  // all (malformed/incomplete provider response) was silently skipped the
  // same way as an ERROR attempt — real, billed spend with an unknowable
  // dollar amount, invisible even to unpricedAttemptCount. Distinct from
  // ERROR/ABORTED (which correctly never carry usage — nothing to count).
  it('SUCCESS-попытка БЕЗ usage вообще -> unverifiableSuccessCount, не тихо пропущена как ERROR', () => {
    const attempts: CompletionAttempt[] = [
      attempt({ model: 'claude-sonnet-5', outcome: 'SUCCESS' }), // usage отсутствует
    ];
    const result = estimateCostFromAttempts(attempts);
    expect(result.totalUsd).toBe(0);
    expect(result.pricedAttemptCount).toBe(0);
    expect(result.unpricedAttemptCount).toBe(0);
    expect(result.unverifiableSuccessCount).toBe(1);
  });

  it('ERROR/ABORTED без usage -> unverifiableSuccessCount=0 (легитимно нечего считать, не "нельзя проверить")', () => {
    const attempts: CompletionAttempt[] = [
      attempt({ model: 'claude-sonnet-5', outcome: 'ERROR' }),
      attempt({ model: 'claude-sonnet-5', outcome: 'ABORTED' }),
    ];
    const result = estimateCostFromAttempts(attempts);
    expect(result.unverifiableSuccessCount).toBe(0);
  });
});
