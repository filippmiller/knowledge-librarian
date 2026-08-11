import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChatCompletionError } from '../../src/lib/ai/chat-provider';
import { CallTraceLog } from '../../src/lib/ai/call-trace-log';
import { CostLedger } from '../../src/lib/ai/cost-ledger';
import { PaidStructuredSemanticError, StructuredOutputError } from '../../src/lib/ai/structured-output';
import {
  classifyStructuredError,
  focusedRepairStructuredCallCeiling,
  parseArgs,
  recordOnFailure,
  recordDecisionRelevanceTelemetry,
  recordEmbeddingAttempt,
  resolveQuestionStageTarget,
  withStructuredRetry,
} from '../run-aurora-fixture';

const REQUIRED = [
  '--mode=e2e',
  '--out=C:/tmp/aurora-test',
  '--max-cost-usd=0.50',
];

let tempDir = '';

afterEach(() => {
  delete process.env.AURORA_QUESTION_PROVIDER;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
  delete process.env.AURORA_QUESTION_MODEL;
  delete process.env.AURORA_ENGINE_PROFILE;
});

describe('run-aurora-fixture paid-call CLI ceiling', () => {
  it('budgets three repair plus re-audit rounds per block at the retry ceiling', () => {
    expect(focusedRepairStructuredCallCeiling(1, 6)).toBe(36);
    expect(focusedRepairStructuredCallCeiling(2, 6)).toBe(72);
  });

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

  it('keeps question-stage provider/model separate from extraction', () => {
    const args = parseArgs([
      ...REQUIRED,
      '--max-paid-calls=7',
      '--question-provider=openai',
      '--question-model=gpt-4o-mini',
    ]);
    expect(resolveQuestionStageTarget(args, {
      provider: 'anthropic', model: 'claude-sonnet-5',
    })).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
  });

  it('defaults question-stage target to the current extraction target', () => {
    const args = parseArgs([...REQUIRED, '--max-paid-calls=7']);
    expect(resolveQuestionStageTarget(args, {
      provider: 'anthropic', model: 'claude-sonnet-5',
    })).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
  });

  it.each([
    ['balanced', 'anthropic', 'claude-haiku-4-5'],
    ['economy', 'openai', 'gpt-4o-mini'],
  ] as const)('maps %s engine profile predictably', (profile, provider, model) => {
    const args = parseArgs([...REQUIRED, '--max-paid-calls=7', `--engine-profile=${profile}`]);
    expect(resolveQuestionStageTarget(args, {
      provider: 'anthropic', model: 'claude-sonnet-5',
    })).toEqual({ provider, model });
  });

  it('keeps quality as the default profile', () => {
    expect(parseArgs([...REQUIRED, '--max-paid-calls=7']).engineProfile).toBe('quality');
  });

  it('supports the separate target through env', () => {
    process.env.AURORA_QUESTION_PROVIDER = 'openai';
    process.env.AURORA_QUESTION_MODEL = 'gpt-4o-mini';
    const args = parseArgs([...REQUIRED, '--max-paid-calls=7']);
    expect(resolveQuestionStageTarget(args, {
      provider: 'anthropic', model: 'claude-sonnet-5',
    })).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
  });

  it('rejects a provider/model half-override before any paid work', () => {
    expect(() => parseArgs([
      ...REQUIRED, '--max-paid-calls=7', '--question-provider=openai',
    ])).toThrow('одновременно provider и model');
  });
});

describe('run-aurora-fixture outer retry classification', () => {
  it.each(['decision-relevance', 'challenge-compatibility'])(
    'provider-success semantic ID failure records %s exactly once',
    async (purpose) => {
      const ledger = new CostLedger({ maxPaidCalls: 1 });
      const traceLog = new CallTraceLog();
      const attempt = {
        provider: 'openai' as const, model: 'gpt-4o-mini', startedAt: '2026-08-10T00:00:00.000Z',
        latencyMs: 10, outcome: 'SUCCESS' as const,
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
      };
      const error = new PaidStructuredSemanticError('omitted unitId', {
        attempts: [attempt],
        requestMessages: [{ role: 'user', content: 'semantic batch' }],
        responseText: '{"results":[]}',
      });

      ledger.reservePaidCall(purpose);
      await expect(recordOnFailure(
        purpose,
        ledger,
        traceLog,
        { runId: 'run-test', stage: purpose },
        async () => { throw error; }
      )).rejects.toBe(error);

      expect(ledger.totalReservedPaidCalls()).toBe(1);
      expect(ledger.totalAttemptCount()).toBe(1);
      expect(ledger.totalUsd()).toBeCloseTo(0.15, 8);
      expect(ledger.summaryByPurpose()).toEqual([
        expect.objectContaining({ purpose, callCount: 1, attemptCount: 1 }),
      ]);
      expect(traceLog.all()).toHaveLength(1);
      expect(traceLog.all()[0]).toMatchObject({ purpose, outcome: 'ERROR' });
    }
  );

  it('reconciles one Decision Relevance provider attempt to one ledger attempt and cost', () => {
    const ledger = new CostLedger();
    const traceLog = new CallTraceLog();
    recordDecisionRelevanceTelemetry(
      ledger,
      traceLog,
      {
        attempts: [{
          provider: 'openai', model: 'gpt-4o-mini', startedAt: '2026-08-10T00:00:00.000Z',
          latencyMs: 10, outcome: 'SUCCESS', usage: { inputTokens: 1_000_000, outputTokens: 0 },
        }],
        requestMessages: [{ role: 'user', content: 'test batch' }],
        responseText: '{"results":[]}',
      },
      { runId: 'run-test', stage: 'decision-relevance', caseId: 'case-1' }
    );

    expect(ledger.totalAttemptCount()).toBe(1);
    expect(ledger.totalUsd()).toBeCloseTo(0.15, 8);
    expect(ledger.summaryByPurpose()).toEqual([
      expect.objectContaining({ purpose: 'decision-relevance', callCount: 1, attemptCount: 1 }),
    ]);
    expect(traceLog.all()).toHaveLength(1);
  });

  it('reconciles failed and successful embedding attempts with reservations, trace, and exact cost', () => {
    const ledger = new CostLedger({ maxPaidCalls: 3 });
    const traceLog = new CallTraceLog();
    const attempts = [
      { outcome: 'ERROR' as const, errorCode: 'ECONNRESET' },
      { outcome: 'ERROR' as const, statusCode: 503 },
      { outcome: 'SUCCESS' as const, usage: { inputTokens: 1_000_000, outputTokens: 0 } },
    ];
    for (const details of attempts) {
      ledger.reservePaidCall('query-embedding');
      recordEmbeddingAttempt(
        'query-embedding', ledger, traceLog,
        { provider: 'openai', model: 'text-embedding-3-small', startedAt: '2026-08-10T00:00:00.000Z', latencyMs: 1, ...details },
        ['query'], { runId: 'run-test', stage: 'query-embedding', caseId: 'Q07' }
      );
    }
    expect(ledger.totalReservedPaidCalls()).toBe(3);
    expect(ledger.totalAttemptCount()).toBe(3);
    expect(ledger.totalUsd()).toBeCloseTo(0.02, 8);
    expect(traceLog.all()).toHaveLength(3);
    expect(traceLog.all().map((entry) => entry.outcome)).toEqual(['ERROR', 'ERROR', 'SUCCESS']);
  });

  it('retries varied Decision Relevance schema failures locally without repeating query or rerank', async () => {
    let queryCalls = 0;
    let rerankCalls = 0;
    let decisionCalls = 0;
    queryCalls += 1;
    rerankCalls += 1;
    const ledger = new CostLedger({ maxPaidCalls: 3 });
    const traceLog = new CallTraceLog();
    const paidAttempt = () => ({
      provider: 'openai' as const, model: 'gpt-4o-mini', startedAt: '2026-08-10T00:00:00.000Z',
      latencyMs: 1, outcome: 'SUCCESS' as const, usage: { inputTokens: 1_000_000, outputTokens: 0 },
    });
    const result = await withStructuredRetry(
      async () => {
        decisionCalls += 1;
        ledger.reservePaidCall('decision-relevance');
        const telemetry = { attempts: [paidAttempt()], requestMessages: [{ role: 'user' as const, content: 'batch' }], responseText: '{}' };
        if (decisionCalls < 3) {
          throw new StructuredOutputError(
            'SCHEMA_MISMATCH',
            [{ path: decisionCalls === 1 ? 'results' : 'results[0]', code: 'invalid_type', message: 'singular result shape' }],
            { text: '{}', rawText: '{}', servedByProvider: 'openai', servedByModel: 'gpt-4o-mini', fallbackUsed: false, ...telemetry }
          );
        }
        return telemetry;
      },
      3, 'decision relevance', ledger, traceLog, 'decision-relevance',
      (value) => value.attempts,
      (value) => ({ requestMessages: value.requestMessages, responseText: value.responseText }),
      { runId: 'run-test', stage: 'decision-relevance', caseId: 'Q09-N1' }
    );
    expect(result.attemptLog).toHaveLength(3);
    expect({ queryCalls, rerankCalls, decisionCalls }).toEqual({ queryCalls: 1, rerankCalls: 1, decisionCalls: 3 });
    expect(ledger.totalReservedPaidCalls()).toBe(3);
    expect(ledger.totalAttemptCount()).toBe(3);
    expect(ledger.totalUsd()).toBeCloseTo(0.45, 8);
    expect(traceLog.all()).toHaveLength(3);
  });

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
    tempDir = mkdtempSync(path.join(tmpdir(), 'aurora-paid-call-budget-'));
    const tracePath = path.join(tempDir, 'permanent-4xx.jsonl');

    await expect(
      withStructuredRetry(
        async () => {
          calls += 1;
          throw error;
        },
        6,
        'test',
        new CostLedger({ maxPaidCalls: 1 }),
        new CallTraceLog(tracePath),
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
