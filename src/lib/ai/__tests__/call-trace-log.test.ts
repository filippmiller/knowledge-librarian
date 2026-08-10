import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attributeAttemptCosts,
  CallTraceLog,
  pricedTraceTotalUsd,
  type CallTraceEntry,
} from '../call-trace-log';
import { CostLedger } from '../cost-ledger';

/**
 * Call-trace log (2026-08-10) — the debugging gap the user named directly:
 * "if we ask the neural network something, we need to log the question —
 * only then can we match the answer to the question and find where
 * something went wrong." CostLedger (Task 37) gives aggregate spend;
 * this gives the exact prompt next to the exact raw response, per call.
 */

function entry(overrides: Partial<CallTraceEntry> = {}): CallTraceEntry {
  return {
    callId: 'call-1',
    correlation: { runId: 'run-1', stage: 'extraction', blockAnchors: ['a'] },
    timestamp: '2026-08-10T00:00:00.000Z',
    purpose: 'extraction',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    outcome: 'SUCCESS',
    attempts: [],
    requestMessages: [{ role: 'user', content: 'вопрос про апостиль' }],
    responseText: '{"units":[]}',
    errorMessage: null,
    ...overrides,
  };
}

describe('attributeAttemptCosts — exact per-provider-attempt attribution', () => {
  it('preserves cache counters and prices every retry independently', () => {
    const attributed = attributeAttemptCosts([
      {
        provider: 'anthropic', model: 'claude-sonnet-5', startedAt: '2026-08-10T00:00:00.000Z',
        latencyMs: 100, outcome: 'SUCCESS', statusCode: 200,
        usage: { inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 20, cacheReadInputTokens: 30 },
      },
      {
        provider: 'anthropic', model: 'unknown-model', startedAt: '2026-08-10T00:00:01.000Z',
        latencyMs: 25, outcome: 'ERROR', errorCode: 'fetch_failed',
      },
    ]);

    expect(attributed[0]).toMatchObject({
      attemptIndex: 1,
      usage: { inputTokens: 100, outputTokens: 10, cacheCreationInputTokens: 20, cacheReadInputTokens: 30 },
    });
    expect(attributed[0].estimatedUsd).toBeGreaterThan(0);
    expect(attributed[1]).toMatchObject({ attemptIndex: 2, usage: null, estimatedUsd: null });
  });

  it('uses null, not zero, when usage exists but the model has no price', () => {
    const [attempt] = attributeAttemptCosts([{
      provider: 'openai', model: 'future-model', startedAt: '2026-08-10T00:00:00.000Z',
      latencyMs: 5, outcome: 'SUCCESS', usage: { inputTokens: 1, outputTokens: 1 },
    }]);
    expect(attempt.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
    expect(attempt.estimatedUsd).toBeNull();
  });

  it('reconciles exactly with CostLedger for the same priced attempts', () => {
    const attempts = [{
      provider: 'anthropic' as const,
      model: 'claude-sonnet-5',
      startedAt: '2026-08-10T00:00:00.000Z',
      latencyMs: 8,
      outcome: 'SUCCESS' as const,
      usage: { inputTokens: 123, outputTokens: 17, cacheCreationInputTokens: 40, cacheReadInputTokens: 80 },
    }];
    const ledger = new CostLedger();
    ledger.record('extraction', attempts);
    const trace = entry({ attempts: attributeAttemptCosts(attempts) });

    expect(pricedTraceTotalUsd([trace])).toBe(ledger.totalUsd());
  });
});

describe('CallTraceLog — накопление в памяти (без filePath)', () => {
  it('пустой log -> all() пуст', () => {
    const log = new CallTraceLog();
    expect(log.all()).toEqual([]);
  });

  it('record() добавляет запись, all() отдаёт её как есть', () => {
    const log = new CallTraceLog();
    const e = entry();
    log.record(e);
    expect(log.all()).toEqual([e]);
  });

  it('несколько record() -> all() отдаёт их по порядку', () => {
    const log = new CallTraceLog();
    log.record(entry({ purpose: 'extraction' }));
    log.record(entry({ purpose: 'query-frame' }));
    log.record(entry({ purpose: 'synthesis' }));

    expect(log.all().map((e) => e.purpose)).toEqual(['extraction', 'query-frame', 'synthesis']);
  });

  it('ERROR-запись с requestMessages и responseText:null — неудачный вызов без ответа тоже трассируется', () => {
    const log = new CallTraceLog();
    const e = entry({ outcome: 'ERROR', responseText: null, errorMessage: 'Anthropic API error (500): down' });
    log.record(e);
    expect(log.all()[0]).toEqual(e);
  });

  it('без filePath не трогает файловую систему — конструктор не бросает без пути', () => {
    expect(() => new CallTraceLog()).not.toThrow();
  });
});

describe('CallTraceLog — запись в файл (filePath задан)', () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it('record() дописывает запись как ОДНУ строку JSON в файл (JSONL)', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'call-trace-log-test-'));
    const filePath = path.join(dir, 'call-trace.jsonl');
    const log = new CallTraceLog(filePath);

    log.record(entry({ purpose: 'extraction' }));
    log.record(entry({ purpose: 'reranker' }));

    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).purpose).toBe('extraction');
    expect(JSON.parse(lines[1]).purpose).toBe('reranker');
  });

  it('запись переживает "аварийный" сценарий: файл читаем после каждого record(), не только в конце', () => {
    // Тот же принцип, что и у CostLedger: appendFileSync, не буферизация в
    // памяти до конца прогона — иначе прерванный на середине прогон терял бы
    // весь трейс, а не только хвост.
    dir = mkdtempSync(path.join(tmpdir(), 'call-trace-log-test-'));
    const filePath = path.join(dir, 'call-trace.jsonl');
    const log = new CallTraceLog(filePath);

    log.record(entry());
    const afterFirst = readFileSync(filePath, 'utf8').trim().split('\n');
    expect(afterFirst).toHaveLength(1);

    log.record(entry());
    const afterSecond = readFileSync(filePath, 'utf8').trim().split('\n');
    expect(afterSecond).toHaveLength(2);
  });

  it('with filePath — all() ВСЁ РАВНО накапливает в памяти, не только на диске', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'call-trace-log-test-'));
    const filePath = path.join(dir, 'call-trace.jsonl');
    const log = new CallTraceLog(filePath);

    log.record(entry({ purpose: 'extraction' }));
    log.record(entry({ purpose: 'synthesis' }));

    expect(log.all().map((e) => e.purpose)).toEqual(['extraction', 'synthesis']);
  });
});
