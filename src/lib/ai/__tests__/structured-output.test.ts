import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openaiCreate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/openai', () => ({
  openai: { chat: { completions: { create: openaiCreate } } },
  CHAT_MODEL: 'gpt-4o',
}));

import { z } from 'zod';
import { ChatCompletionError, type ChatCompletionResult } from '../chat-provider';
import type { ExtractionRunConfig } from '../extraction-run';
import {
  DEFAULT_STRUCTURED_FALLBACK_POLICY,
  structured,
  StructuredOutputError,
  validateStructuredPayload,
  type StructuredRunConfig,
} from '../structured-output';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MESSAGES = [{ role: 'user' as const, content: 'сколько стоит апостиль?' }];

/**
 * Схема намеренно похожа на контракт B1 по характеру: strict-объект, enum,
 * вложенный объект и массив — чтобы путь до поля в диагностике проверялся не
 * только на плоском случае.
 */
const priceSchema = z.strictObject({
  kind: z.enum(['PRICE', 'PROCEDURE']),
  price: z.number(),
  notes: z.array(z.string()),
  source: z.strictObject({ docId: z.string() }),
});

type Price = z.infer<typeof priceSchema>;

const VALID_PAYLOAD: Price = {
  kind: 'PRICE',
  price: 3500,
  notes: ['срочный тариф выше'],
  source: { docId: 'doc-1' },
};

let fetchMock: ReturnType<typeof vi.fn>;

function anthropicOk(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
    status: 200,
  });
}

/** 500 не входит в RETRYABLE_STATUS_CODES — резерв начинается сразу, без sleep. */
function anthropicFailure(status = 500, body = 'anthropic is down'): Response {
  return new Response(body, { status });
}

function openaiOk(text: string) {
  return { choices: [{ message: { content: text } }] };
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** Запрос, который не завершается сам — только по signal. */
function hangUntilAbort(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

function anthropicRequestBodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter((call) => call[0] === ANTHROPIC_URL)
    .map((call) => JSON.parse((call[1] as RequestInit).body as string));
}

function runConfig(
  overrides: Partial<StructuredRunConfig> = {}
): StructuredRunConfig {
  return {
    provider: 'anthropic',
    model: 'claude-test-primary',
    promptVersion: 'test-prompt-v1',
    fallbackPolicy: 'NONE',
    ...overrides,
  };
}

/** Синтетический результат вызова — для чистой половины адаптера. */
function completionResult(text: string): ChatCompletionResult {
  return {
    text,
    servedByProvider: 'anthropic',
    servedByModel: 'claude-test-primary',
    fallbackUsed: false,
    attempts: [
      {
        provider: 'anthropic',
        model: 'claude-test-primary',
        startedAt: '2026-08-06T00:00:00.000Z',
        latencyMs: 12,
        outcome: 'SUCCESS',
      },
    ],
  };
}

async function expectStructuredError(
  promise: Promise<unknown>
): Promise<StructuredOutputError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(StructuredOutputError);
  return error as StructuredOutputError;
}

async function expectChatCompletionError(
  promise: Promise<unknown>
): Promise<ChatCompletionError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(ChatCompletionError);
  return error as ChatCompletionError;
}

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
  vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
  vi.stubEnv('AI_PROVIDER', 'anthropic');
  vi.stubEnv('ANTHROPIC_MODEL', 'claude-env-default');
  vi.stubEnv('OPENAI_CHAT_MODEL', 'gpt-env-default');

  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  openaiCreate.mockReset();

  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('structured() — успешный разбор', () => {
  it('валидный ответ разбирается в типизированные данные', async () => {
    fetchMock.mockResolvedValue(anthropicOk(JSON.stringify(VALID_PAYLOAD)));

    const result = await structured({
      schema: priceSchema,
      messages: MESSAGES,
      runConfig: runConfig(),
    });

    expect(result.data).toEqual(VALID_PAYLOAD);
  });

  it('ответ в markdown-заборе всё равно разбирается: JSON-режим provider-слоя задействован', async () => {
    fetchMock.mockResolvedValue(
      anthropicOk('```json\n' + JSON.stringify(VALID_PAYLOAD) + '\n```')
    );

    const result = await structured({
      schema: priceSchema,
      messages: MESSAGES,
      runConfig: runConfig(),
    });

    expect(result.data).toEqual(VALID_PAYLOAD);
  });

  it('attempts[] доходит до вызывающего вместе с фактическим исполнителем', async () => {
    fetchMock.mockResolvedValue(anthropicOk(JSON.stringify(VALID_PAYLOAD)));

    const result = await structured({
      schema: priceSchema,
      messages: MESSAGES,
      runConfig: runConfig(),
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-test-primary',
      outcome: 'SUCCESS',
    });
    expect(result.servedByProvider).toBe('anthropic');
    expect(result.servedByModel).toBe('claude-test-primary');
    expect(result.fallbackUsed).toBe(false);
    expect(result.text).toContain('3500');
  });

  it('в API уезжает модель из runConfig, а не env-дефолт', async () => {
    fetchMock.mockResolvedValue(anthropicOk(JSON.stringify(VALID_PAYLOAD)));

    await structured({
      schema: priceSchema,
      messages: MESSAGES,
      runConfig: runConfig({ model: 'claude-pinned-4' }),
    });

    expect(anthropicRequestBodies()[0]).toMatchObject({ model: 'claude-pinned-4' });
  });

  it('maxTokens и temperature доезжают до провайдера', async () => {
    fetchMock.mockResolvedValue(anthropicOk(JSON.stringify(VALID_PAYLOAD)));

    await structured({
      schema: priceSchema,
      messages: MESSAGES,
      runConfig: runConfig(),
      maxTokens: 9001,
      temperature: 0,
    });

    expect(anthropicRequestBodies()[0]).toMatchObject({
      max_tokens: 9001,
      temperature: 0,
    });
  });

  it('ExtractionRunConfig из A2 принимается как есть, без выдумывания полей', async () => {
    fetchMock.mockResolvedValue(anthropicOk(JSON.stringify(VALID_PAYLOAD)));

    const extractionConfig: ExtractionRunConfig = {
      provider: 'anthropic',
      model: 'claude-extraction',
      promptVersion: 'extraction-v1',
      fallbackPolicy: 'NONE',
      extractionSchemaVersion: 'schema-v1',
    };

    const result = await structured({
      schema: priceSchema,
      messages: MESSAGES,
      runConfig: extractionConfig,
    });

    expect(result.servedByModel).toBe('claude-extraction');
  });
});

describe('structured() — ответ, не соответствующий схеме', () => {
  it('не проходит молча: ошибка называет поле с неверным типом', async () => {
    fetchMock.mockResolvedValue(
      anthropicOk(JSON.stringify({ ...VALID_PAYLOAD, price: 'дорого' }))
    );

    const error = await expectStructuredError(
      structured({ schema: priceSchema, messages: MESSAGES, runConfig: runConfig() })
    );

    expect(error.reason).toBe('SCHEMA_MISMATCH');
    expect(error.issues.map((issue) => issue.path)).toContain('price');
    expect(error.message).toContain('price');
  });

  it('путь до элемента массива указывается с индексом', async () => {
    fetchMock.mockResolvedValue(
      anthropicOk(JSON.stringify({ ...VALID_PAYLOAD, notes: ['ok', 42] }))
    );

    const error = await expectStructuredError(
      structured({ schema: priceSchema, messages: MESSAGES, runConfig: runConfig() })
    );

    expect(error.issues.map((issue) => issue.path)).toContain('notes[1]');
    expect(error.message).toContain('notes[1]');
  });

  it('путь до вложенного поля указывается через точку', async () => {
    fetchMock.mockResolvedValue(
      anthropicOk(JSON.stringify({ ...VALID_PAYLOAD, source: { docId: 7 } }))
    );

    const error = await expectStructuredError(
      structured({ schema: priceSchema, messages: MESSAGES, runConfig: runConfig() })
    );

    expect(error.issues.map((issue) => issue.path)).toContain('source.docId');
    expect(error.message).toContain('source.docId');
  });

  it('отсутствующее поле называется по имени, а не «объект невалиден»', async () => {
    const { price: _price, ...withoutPrice } = VALID_PAYLOAD;
    fetchMock.mockResolvedValue(anthropicOk(JSON.stringify(withoutPrice)));

    const error = await expectStructuredError(
      structured({ schema: priceSchema, messages: MESSAGES, runConfig: runConfig() })
    );

    expect(error.issues.map((issue) => issue.path)).toContain('price');
  });

  it('ответ прозой доезжает как пустой объект и всё равно отвергается', async () => {
    fetchMock.mockResolvedValue(anthropicOk('Извините, не могу ответить.'));

    const error = await expectStructuredError(
      structured({ schema: priceSchema, messages: MESSAGES, runConfig: runConfig() })
    );

    expect(error.reason).toBe('SCHEMA_MISMATCH');
    expect(error.issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['kind', 'price', 'notes', 'source'])
    );
  });

  it('на невалидном ответе attempts[] и фактический исполнитель сохраняются', async () => {
    fetchMock.mockResolvedValue(
      anthropicOk(JSON.stringify({ ...VALID_PAYLOAD, price: 'дорого' }))
    );

    const error = await expectStructuredError(
      structured({ schema: priceSchema, messages: MESSAGES, runConfig: runConfig() })
    );

    expect(error.attempts).toHaveLength(1);
    expect(error.attempts[0]).toMatchObject({ provider: 'anthropic', outcome: 'SUCCESS' });
    expect(error.attempts).toBe(error.result.attempts);
    expect(error.servedByProvider).toBe('anthropic');
    expect(error.servedByModel).toBe('claude-test-primary');
  });

  it('первопричина не проглатывается: результат вызова остаётся в ошибке целиком', async () => {
    fetchMock.mockResolvedValue(
      anthropicOk(JSON.stringify({ ...VALID_PAYLOAD, price: 'дорого' }))
    );

    const error = await expectStructuredError(
      structured({ schema: priceSchema, messages: MESSAGES, runConfig: runConfig() })
    );

    expect(error.result.text).toContain('дорого');
  });
});

describe('validateStructuredPayload() — чистая половина адаптера', () => {
  it('неразбираемый JSON даёт INVALID_JSON, а не «схема не сошлась»', () => {
    const result = completionResult('это вообще не json');

    let caught: unknown;
    try {
      validateStructuredPayload(priceSchema, result);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StructuredOutputError);
    const error = caught as StructuredOutputError;
    expect(error.reason).toBe('INVALID_JSON');
    expect(error.attempts).toBe(result.attempts);
    expect(error.message).toContain('anthropic/claude-test-primary');
  });

  it('валидный payload возвращается как есть', () => {
    const data = validateStructuredPayload(
      priceSchema,
      completionResult(JSON.stringify(VALID_PAYLOAD))
    );
    expect(data).toEqual(VALID_PAYLOAD);
  });

  it('длинный список претензий обрезается, но их количество названо честно', () => {
    const wideSchema = z.strictObject({
      a: z.string(),
      b: z.string(),
      c: z.string(),
      d: z.string(),
      e: z.string(),
      f: z.string(),
      g: z.string(),
    });

    let caught: unknown;
    try {
      validateStructuredPayload(wideSchema, completionResult('{}'));
    } catch (error) {
      caught = error;
    }

    const error = caught as StructuredOutputError;
    expect(error.issues).toHaveLength(7);
    expect(error.message).toContain('(7 шт.)');
    expect(error.message).toContain('и ещё 2');
  });
});

describe('structured() — политика фоллбэка', () => {
  it('дефолт для structured-вызовов — NONE', () => {
    expect(DEFAULT_STRUCTURED_FALLBACK_POLICY).toBe('NONE');
  });

  it('конфигурация без политики не наследует CROSS_PROVIDER из provider-слоя', async () => {
    // Без дефолта NONE здесь сработал бы вывод A1: модель закреплена,
    // providerModels.openai задан → CROSS_PROVIDER, и резерв ушёл бы в OpenAI.
    const { fallbackPolicy: _omitted, ...withoutPolicy } = runConfig({
      providerModels: { openai: 'gpt-test-fallback' },
    });
    fetchMock.mockResolvedValue(anthropicFailure());
    openaiCreate.mockResolvedValue(openaiOk(JSON.stringify(VALID_PAYLOAD)));

    const error = await expectChatCompletionError(
      structured({ schema: priceSchema, messages: MESSAGES, runConfig: withoutPolicy })
    );

    expect(openaiCreate).not.toHaveBeenCalled();
    expect(error.attempts).toHaveLength(1);
    expect(error.attempts[0]).toMatchObject({ provider: 'anthropic', outcome: 'ERROR' });
  });

  it('явная политика вызова важнее политики из runConfig', async () => {
    fetchMock.mockResolvedValue(anthropicFailure());
    openaiCreate.mockResolvedValue(openaiOk(JSON.stringify(VALID_PAYLOAD)));

    await expectChatCompletionError(
      structured({
        schema: priceSchema,
        messages: MESSAGES,
        runConfig: runConfig({
          fallbackPolicy: 'CROSS_PROVIDER',
          providerModels: { openai: 'gpt-test-fallback' },
        }),
        fallbackPolicy: 'NONE',
      })
    );

    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it('явно заданный резерв срабатывает и записывается как фактический исполнитель', async () => {
    fetchMock.mockResolvedValue(anthropicFailure());
    openaiCreate.mockResolvedValue(openaiOk(JSON.stringify(VALID_PAYLOAD)));

    const result = await structured({
      schema: priceSchema,
      messages: MESSAGES,
      runConfig: runConfig({ providerModels: { openai: 'gpt-test-fallback' } }),
      fallbackPolicy: 'CROSS_PROVIDER',
    });

    expect(result.data).toEqual(VALID_PAYLOAD);
    expect(result.servedByProvider).toBe('openai');
    expect(result.servedByModel).toBe('gpt-test-fallback');
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ provider: 'anthropic', outcome: 'ERROR' });
    expect(result.attempts[1]).toMatchObject({
      provider: 'openai',
      model: 'gpt-test-fallback',
      outcome: 'SUCCESS',
    });
  });

  it('резервному провайдеру уезжает JSON-режим, а не свободный текст', async () => {
    fetchMock.mockResolvedValue(anthropicFailure());
    openaiCreate.mockResolvedValue(openaiOk(JSON.stringify(VALID_PAYLOAD)));

    await structured({
      schema: priceSchema,
      messages: MESSAGES,
      runConfig: runConfig({ providerModels: { openai: 'gpt-test-fallback' } }),
      fallbackPolicy: 'CROSS_PROVIDER',
    });

    expect(openaiCreate.mock.calls[0][0]).toMatchObject({
      model: 'gpt-test-fallback',
      response_format: { type: 'json_object' },
    });
  });
});

describe('structured() — отказ провайдера', () => {
  it('пробрасывает ChatCompletionError с сохранённым attempts[]', async () => {
    fetchMock.mockResolvedValue(anthropicFailure(500, 'anthropic is down'));

    const error = await expectChatCompletionError(
      structured({ schema: priceSchema, messages: MESSAGES, runConfig: runConfig() })
    );

    expect(error.attempts).toHaveLength(1);
    expect(error.attempts[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-test-primary',
      outcome: 'ERROR',
      statusCode: 500,
    });
    expect(error.message).toContain('anthropic is down');
    expect(error).not.toBeInstanceOf(StructuredOutputError);
  });

  it('totalDeadlineMs из runConfig доезжает до provider-слоя', async () => {
    fetchMock.mockImplementation(hangUntilAbort);

    const error = await expectChatCompletionError(
      structured({
        schema: priceSchema,
        messages: MESSAGES,
        runConfig: runConfig({ totalDeadlineMs: 0 }),
      })
    );

    expect(error.attempts).toHaveLength(1);
    expect(error.attempts[0]).toMatchObject({
      outcome: 'ABORTED',
      errorCode: 'TOTAL_DEADLINE_EXCEEDED',
    });
  });

  it('внешняя отмена помечает попытку ABORTED_BY_CALLER', async () => {
    fetchMock.mockImplementation(hangUntilAbort);
    const controller = new AbortController();
    const promise = structured({
      schema: priceSchema,
      messages: MESSAGES,
      runConfig: runConfig(),
      signal: controller.signal,
    });
    controller.abort();

    const error = await expectChatCompletionError(promise);

    expect(error.attempts[0]).toMatchObject({
      outcome: 'ABORTED',
      errorCode: 'ABORTED_BY_CALLER',
    });
  });
});
