import { describe, expect, it } from 'vitest';

import { extractFocusedRepairUnitsWithRetry } from '../run-aurora-fixture';
import { CostLedger, PaidCallBudgetExceededError } from '../../src/lib/ai/cost-ledger';
import { CallTraceLog } from '../../src/lib/ai/call-trace-log';
import type { FocusedRepairOptions } from '../../src/lib/knowledge/audited-extraction';
import type { CompletionAttempt } from '../../src/lib/ai/chat-provider';

const successAttempt: CompletionAttempt = {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  startedAt: '2026-08-10T00:00:00.000Z',
  latencyMs: 5,
  outcome: 'SUCCESS',
  statusCode: 200,
  usage: { inputTokens: 100, outputTokens: 20 },
};

function options(ledger: CostLedger): FocusedRepairOptions {
  return {
    block: { anchor: 'b0', text: 'Пропущенное правило.' },
    findings: [{
      verdict: 'UNREPRESENTED_CLAUSE',
      quote: 'Пропущенное правило',
      explanation: 'gap',
      quoteVerified: true,
    }],
    existingUnits: [],
    runConfig: {
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      promptVersion: 'test',
      extractionSchemaVersion: 'test',
      fallbackPolicy: 'NONE',
      beforeProviderAttempt: () => ledger.reservePaidCall('focused-repair'),
    },
  };
}

describe('observed focused repair', () => {
  it('reserves paid-call budget and records provider attempts in CostLedger and CallTrace', async () => {
    const ledger = new CostLedger({ maxPaidCalls: 1 });
    const trace = new CallTraceLog();
    const call = async (input: FocusedRepairOptions) => {
      input.runConfig.beforeProviderAttempt?.({ provider: 'anthropic', model: 'claude-sonnet-5' });
      return {
        units: [],
        structuredResult: {
          attempts: [successAttempt],
          requestMessages: [{ role: 'user' as const, content: 'compact repair prompt' }],
          rawText: '{"units":[]}',
        } as never,
      };
    };

    await extractFocusedRepairUnitsWithRetry(
      options(ledger), 1, ledger, trace, { runId: 'run-test', stage: 'focused-repair', blockAnchor: 'b0' }, call
    );

    expect(ledger.totalReservedPaidCalls()).toBe(1);
    expect(ledger.summaryByPurpose()).toEqual([
      expect.objectContaining({ purpose: 'focused-repair', callCount: 1, attemptCount: 1 }),
    ]);
    expect(trace.all()).toEqual([
      expect.objectContaining({
        purpose: 'focused-repair',
        correlation: { runId: 'run-test', stage: 'focused-repair', blockAnchor: 'b0' },
        outcome: 'SUCCESS',
        requestMessages: [{ role: 'user', content: 'compact repair prompt' }],
        responseText: '{"units":[]}',
      }),
    ]);
  });

  it('fails before provider work when the paid-call budget is exhausted', async () => {
    const ledger = new CostLedger({ maxPaidCalls: 0 });
    const trace = new CallTraceLog();
    let providerStarted = false;
    const call = async (input: FocusedRepairOptions) => {
      input.runConfig.beforeProviderAttempt?.({ provider: 'anthropic', model: 'claude-sonnet-5' });
      providerStarted = true;
      return { units: [], structuredResult: {} as never };
    };

    await expect(extractFocusedRepairUnitsWithRetry(
      options(ledger), 1, ledger, trace, { runId: 'run-test', stage: 'focused-repair', blockAnchor: 'b0' }, call
    ))
      .rejects.toBeInstanceOf(PaidCallBudgetExceededError);
    expect(providerStarted).toBe(false);
    expect(trace.all()).toEqual([]);
    expect(ledger.summaryByPurpose()).toEqual([]);
  });
});
