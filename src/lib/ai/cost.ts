import type { CompletionAttempt } from './chat-provider';

/**
 * Cost meter (Task 37, 2026-08-09). Built after a real-world audit found
 * $19.79 spent on Sonnet 5 in one day with zero cost visibility anywhere in
 * the codebase — this module is the source of truth for turning real token
 * usage (chat-provider.ts's `CompletionAttempt.usage`) into a dollar figure.
 *
 * Pricing provenance matters here — a wrong number defeats the entire point
 * of a cost meter. Anthropic prices below are sourced from the authoritative
 * `claude-api` skill (Anthropic's own current pricing reference), checked
 * 2026-08-09 — not from training-data memory, which can be stale (see that
 * skill's own "API Drift" warning). OpenAI prices are best-effort public
 * knowledge; this session had no equivalent authoritative live source for
 * them, so they're explicitly flagged below — verify against
 * platform.openai.com/pricing before trusting an exact total that includes
 * OpenAI calls.
 */

export interface ModelPricing {
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
}

export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  // Anthropic — verified against the claude-api skill, 2026-08-09.
  // Sonnet 5's $2/$10 is INTRO pricing, valid through 2026-08-31; standard
  // pricing after that is $3/$15 — this table will need updating then.
  'claude-sonnet-5': { inputPerMillion: 2.0, outputPerMillion: 10.0 },
  'claude-haiku-4-5': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 1.0, outputPerMillion: 5.0 },
  'claude-opus-5': { inputPerMillion: 5.0, outputPerMillion: 25.0 },

  // OpenAI — NOT verified via an authoritative live source this session.
  // Best-effort public pricing as of this codebase's last known rates;
  // confirm against platform.openai.com/pricing before trusting exact
  // totals for runs that include OpenAI calls.
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  // Embeddings are input-only — outputPerMillion is structurally 0, not a
  // placeholder for "unknown."
  'text-embedding-3-small': { inputPerMillion: 0.02, outputPerMillion: 0 },
};

/** `null` for an unpriced model — never fabricate a 0, which would read as
 *  "this call was free" rather than "we don't have a price for this yet." */
export function estimateCostUsd(
  model: string,
  usage: { readonly inputTokens: number; readonly outputTokens: number }
): number | null {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return null;
  return (usage.inputTokens / 1_000_000) * pricing.inputPerMillion + (usage.outputTokens / 1_000_000) * pricing.outputPerMillion;
}

export interface AttemptCostSummary {
  readonly totalUsd: number;
  /** SUCCESS attempts with usage AND a known model price. */
  readonly pricedAttemptCount: number;
  /** SUCCESS attempts with usage but an unpriced model — real spend not
   *  reflected in totalUsd. Surface this count, don't silently under-report. */
  readonly unpricedAttemptCount: number;
}

/** Only SUCCESS attempts carry `usage` at all (chat-provider.ts never
 *  fabricates usage for a failed/aborted attempt with no response), so
 *  filtering on `usage` presence is equivalent to filtering on outcome. */
export function estimateCostFromAttempts(attempts: readonly CompletionAttempt[]): AttemptCostSummary {
  let totalUsd = 0;
  let pricedAttemptCount = 0;
  let unpricedAttemptCount = 0;

  for (const attempt of attempts) {
    if (!attempt.usage) continue;
    const cost = estimateCostUsd(attempt.model, attempt.usage);
    if (cost === null) {
      unpricedAttemptCount++;
      continue;
    }
    totalUsd += cost;
    pricedAttemptCount++;
  }

  return { totalUsd, pricedAttemptCount, unpricedAttemptCount };
}
