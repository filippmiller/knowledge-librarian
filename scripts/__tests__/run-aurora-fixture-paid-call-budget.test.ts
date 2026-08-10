import { describe, expect, it } from 'vitest';
import { ChatCompletionError } from '../../src/lib/ai/chat-provider';
import { CallTraceLog } from '../../src/lib/ai/call-trace-log';
import { CostLedger } from '../../src/lib/ai/cost-ledger';
import { StructuredOutputError } from '../../src/lib/ai/structured-output';
import { classifyStructuredError, parseArgs, withStructuredRetry } from '../run-aurora-fixture';

const REQUIRED = [
  '--mode=e2e',
  '--out=C:/tmp/aurora-test',
  '--max-cost-usd=0.50',
];

describe('run-aurora-fixture paid-call CLI ceiling', () => {
  it('refuses to start without an explicit --max-paid-calls ceiling', () => {
    expect(() => parseArgs(REQUIRED)).toThrow('--max-paid-calls обязателен');
  });

  it.each(['0', '-1', '1.5', 'not-a-number'])('rejects invalid ceiling %s', (value) => {
    expect(() => parseArgs([...REQUIRED, `--max-paid-calls=${value}`])).toThrow(
      '--max-paid-calls обязан быть положительным целым'
    );
  });

  it('accepts and preserves a positive integer ceiling', () => {
    expect(parseArgs([...REQUIRED, '--max-paid-calls=7']).maxPaidCalls).toBe(7);
  });
});

describe('run-aurora-fixture outer retry classification', () => {
  it('stops after two identical schema mismatch signatures', async () => {
    let calls = 0;
    const error = new StructuredOutputError(
      'SCHEMA_MISMATCH',
      [{ path: 'units[0].kind', code: 'invalid_value', message: 'invalid kind' }],
      {
        text: '{}', rawText: '{}', servedByProvider: 'anthropic',
        servedByModel: 'claude-sonnet-5', fallbackUsed: false, attempts: [], requestMessages: [],
      }
    );

    await expect(
      withStructuredRetry(
        async () => { calls += 1; throw error; },
        6,
        'compact repair',
        new CostLedger(),
        new CallTraceLog(),
        'extraction',
        () => [],
        () => ({ requestMessages: [], responseText: null }),
        { runId: 'run-test', stage: 'focused-repair' }
      )
    ).rejects.toBe(error);

    expect(calls).toBe(2);
  });

  it('does not suppress a transient retry', async () => {
    let calls = 0;
    const transient = new ChatCompletionError('rate limited', [], { statusCode: 429 });
    const result = await withStructuredRetry(
      async () => {
        calls += 1;
        if (calls === 1) throw transient;
        return { attempts: [] };
      },
      6,
      'transient',
      new CostLedger(),
      new CallTraceLog(),
      'extraction',
      (value) => value.attempts,
      () => ({ requestMessages: [], responseText: null }),
      { runId: 'run-test', stage: 'extraction' }
    );

    expect(calls).toBe(2);
    expect(result.attemptLog.map((entry) => entry.outcome)).toEqual(['NETWORK_ERROR', 'SUCCESS']);
  });

  it('writes per-attempt usage and cost attribution into the call trace', async () => {
    const traceLog = new CallTraceLog();
    const attempts = [{
      provider: 'anthropic' as const,
      model: 'claude-sonnet-5',
      startedAt: '2026-08-10T00:00:00.000Z',
      latencyMs: 12,
      outcome: 'SUCCESS' as const,
      statusCode: 200,
      usage: { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 20 },
    }];

    await withStructuredRetry(
      async () => ({ attempts }),
      1,
      'trace-cost-test',
      new CostLedger(),
      traceLog,
      'extraction',
      (result) => result.attempts,
      () => ({ requestMessages: [{ role: 'user', content: 'test' }], responseText: '{}' }),
      { runId: 'run-test', stage: 'extraction', blockAnchors: ['a'] }
    );

    expect(traceLog.all()).toHaveLength(1);
    expect(traceLog.all()[0].callId).toEqual(expect.any(String));
    expect(traceLog.all()[0].correlation).toEqual({
      runId: 'run-test', stage: 'extraction', blockAnchors: ['a'],
    });
    expect(traceLog.all()[0].attempts[0]).toMatchObject({
      attemptIndex: 1,
      usage: { inputTokens: 100, outputTokens: 5, cacheReadInputTokens: 20 },
    });
    expect(traceLog.all()[0].attempts[0].estimatedUsd).toBeGreaterThan(0);
  });

  it('HTTP 400 makes exactly one outer attempt', async () => {
    let calls = 0;
    const error = new ChatCompletionError('insufficient credit', [], { statusCode: 400 });

    await expect(
      withStructuredRetry(
        async () => {
          calls += 1;
          throw error;
        },
        6,
        'test',
        new CostLedger({ maxPaidCalls: 1 }),
        new CallTraceLog('unused-permanent-4xx-test.jsonl'),
        'extraction',
        () => [],
        () => ({ requestMessages: [], responseText: null }),
        { runId: 'run-test', stage: 'extraction' }
      )
    ).rejects.toBe(error);

    expect(calls).toBe(1);
  });

  it.each([400, 401, 403, 404, 422])('does not retry permanent HTTP %s', (statusCode) => {
    const error = new ChatCompletionError('permanent client failure', [], { statusCode });
    expect(classifyStructuredError(error)).toBe('OTHER_ERROR');
  });

  it.each([408, 409, 429])('keeps transient HTTP %s retryable', (statusCode) => {
    const error = new ChatCompletionError('transient client failure', [], { statusCode });
    expect(classifyStructuredError(error)).toBe('NETWORK_ERROR');
  });
});
