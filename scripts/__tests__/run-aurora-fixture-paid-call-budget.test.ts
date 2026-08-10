import { describe, expect, it } from 'vitest';
import { ChatCompletionError } from '../../src/lib/ai/chat-provider';
import { CallTraceLog } from '../../src/lib/ai/call-trace-log';
import { CostLedger } from '../../src/lib/ai/cost-ledger';
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
        () => ({ requestMessages: [], responseText: null })
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
