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

function anthropicOk(text: string, stopReason?: string): Response {
  return new Response(
    JSON.stringify({
      content: [{ type: 'text', text }],
      ...(stopReason !== undefined && { stop_reason: stopReason }),
    }),
    { status: 200 }
  );
}

/** 500 не входит в RETRYABLE_STATUS_CODES — резерв начинается сразу, без sleep. */
function anthropicFailure(status = 500, body = 'anthropic is down'): Response {
  return new Response(body, { status });
}

function openaiOk(text: string, finishReason?: string) {
  return {
    choices: [
      {
        message: { content: text },
        ...(finishReason !== undefined && { finish_reason: finishReason }),
      },
    ],
  };
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

  // Обрыв — самый опасный случай: нормализация достраивает скобки, схема
  // проходит, и вызывающий получает «успех» с молчаливо потерянными данными
  // вместо повтора запроса.
  it('оборванный ответ отвергается, а не «чинится» с потерей данных', async () => {
    fetchMock.mockResolvedValue(anthropicOk('{"service":"apostille","pricePerPage":100,'));

    await expect(
      structured({ schema: priceSchema, messages: MESSAGES, runConfig: runConfig() })
    ).rejects.toMatchObject({ reason: 'TRUNCATED_JSON' });
  });

  it('у отказа по обрыву сохраняются attempts[] и фактический исполнитель', async () => {
    fetchMock.mockResolvedValue(anthropicOk('{"service":"apostille",'));

    const error = (await structured({
      schema: priceSchema,
      messages: MESSAGES,
      runConfig: runConfig(),
    }).catch((e: unknown) => e)) as StructuredOutputError;

    expect(error).toBeInstanceOf(StructuredOutputError);
    // Причину проверяем явно: без неё тест проходит и с выключенной защитой —
    // «починенный» огрызок всё равно валит схему, и наружу летит
    // StructuredOutputError, просто с другой причиной. Тест, который не
    // отличает эти два случая, ничего и не проверяет.
    expect(error.reason).toBe('TRUNCATED_JSON');
    expect(error.result.attempts.length).toBeGreaterThan(0);
    expect(error.result.servedByProvider).toBe('anthropic');
  });

  it('нормальное завершение (stop_reason=end_turn) ничему не мешает', async () => {
    fetchMock.mockResolvedValue(
      anthropicOk(JSON.stringify(VALID_PAYLOAD), 'end_turn')
    );

    const result = await structured({
      schema: priceSchema,
      messages: MESSAGES,
      runConfig: runConfig(),
    });

    expect(result.data).toEqual(VALID_PAYLOAD);
    expect(result.terminationReason).toBe('COMPLETE');
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

  it('упавшая схема на живом вызове тоже сохраняет attempts[]', async () => {
    // Форма ответа схеме соответствует — иначе вердикт вынесется раньше, чем
    // дело дойдёт до падающей проверки, и тест проверял бы не ту ветку.
    fetchMock.mockResolvedValue(anthropicOk(JSON.stringify({ kind: 'PRICE' })));
    const throwingSchema = z.strictObject({ kind: z.string() }).superRefine(() => {
      throw new Error('схема сама сломалась');
    });

    const error = await expectStructuredError(
      structured({ schema: throwingSchema, messages: MESSAGES, runConfig: runConfig() })
    );

    expect(error.reason).toBe('SCHEMA_THREW');
    expect(error.attempts).toHaveLength(1);
    expect(error.attempts[0]).toMatchObject({ provider: 'anthropic', outcome: 'SUCCESS' });
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

  it('упавшая схема не уносит attempts[] наружу голым Error', () => {
    // safeParse() в Zod 4 НЕ ловит исключения из собственной логики схемы —
    // проверено на 4.3.5: superRefine/transform/check/custom пробрасываются.
    const throwingSchema = z.strictObject({ kind: z.string() }).superRefine(() => {
      throw new Error('схема сама сломалась');
    });

    let caught: unknown;
    try {
      validateStructuredPayload(throwingSchema, completionResult('{"kind":"PRICE"}'));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(StructuredOutputError);
    const error = caught as StructuredOutputError;
    expect(error.reason).toBe('SCHEMA_THREW');
    expect(error.attempts).toHaveLength(1);
    expect(error.servedByModel).toBe('claude-test-primary');
    expect(error.message).toContain('схема сама сломалась');
    expect((error as { cause?: unknown }).cause).toBeInstanceOf(Error);
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

/**
 * Обрыв выдачи. Провайдер сообщает его САМ (`finish_reason: 'length'` у OpenAI,
 * `stop_reason: 'max_tokens'` у Anthropic) — это факт, а не догадка; эвристика по
 * скобкам остаётся страховкой для тех, кто промолчал.
 */
describe('structured() — детект обрыва', () => {
  // ГЛАВНЫЙ случай. Оборвать выдачу можно ровно на границе элемента, и тогда
  // текст остаётся синтаксически валидным JSON: сырой ответ парсится, скобки
  // сбалансированы, схема проходит. Никакая эвристика по тексту такой обрыв не
  // отличит от целого ответа — ловит его только слово провайдера.
  it('stop_reason=max_tokens отвергает ответ, даже если текст сам по себе валидный JSON', async () => {
    fetchMock.mockResolvedValue(
      anthropicOk(JSON.stringify(VALID_PAYLOAD), 'max_tokens')
    );

    const error = await expectStructuredError(
      structured({ schema: priceSchema, messages: MESSAGES, runConfig: runConfig() })
    );

    expect(error.reason).toBe('TRUNCATED_JSON');
    expect(error.issues[0].code).toBe('truncated_by_provider');
    // Ответ был бы принят: он валиден и схему проходит. Отвергнут именно по
    // слову провайдера — иначе тест ничего не отличал бы.
    expect(() => priceSchema.parse(JSON.parse(error.result.text))).not.toThrow();
    expect(error.result.terminationReason).toBe('MAX_TOKENS');
    expect(error.attempts.length).toBeGreaterThan(0);
  });

  it('finish_reason=length у OpenAI отвергает такой же валидный по виду ответ', async () => {
    openaiCreate.mockResolvedValue(
      openaiOk(JSON.stringify(VALID_PAYLOAD), 'length')
    );

    const error = await expectStructuredError(
      structured({
        schema: priceSchema,
        messages: MESSAGES,
        runConfig: runConfig({ provider: 'openai', model: 'gpt-test-primary' }),
      })
    );

    expect(error.reason).toBe('TRUNCATED_JSON');
    expect(error.issues[0].code).toBe('truncated_by_provider');
    expect(error.result.terminationReason).toBe('MAX_TOKENS');
    expect(error.result.servedByProvider).toBe('openai');
  });

  // Счётчик глубины считал закрывателем что угодно: '{' +1, ']' -1 — ноль,
  // «сбалансировано». Нормализация превращает такой огрызок в '{}', схема на нём
  // падает, и наружу летел SCHEMA_MISMATCH вместо обрыва.
  it('«{ ]» не считается сбалансированным: закрыватель обязан совпасть по типу', async () => {
    fetchMock.mockResolvedValue(anthropicOk('{ ]'));

    const error = await expectStructuredError(
      structured({ schema: priceSchema, messages: MESSAGES, runConfig: runConfig() })
    );

    expect(error.reason).toBe('TRUNCATED_JSON');
    expect(error.issues[0].code).toBe('truncated_response');
  });

  // Зеркальный случай к «{ ]»: открывателей и закрывателей поровну, поэтому
  // счётчик глубины снова показал бы ноль, а типы не совпадают.
  it('«[ }» тоже не считается сбалансированным', async () => {
    fetchMock.mockResolvedValue(anthropicOk('[ }'));

    const error = await expectStructuredError(
      structured({ schema: priceSchema, messages: MESSAGES, runConfig: runConfig() })
    );

    expect(error.reason).toBe('TRUNCATED_JSON');
    expect(error.issues[0].code).toBe('truncated_response');
  });

  // Незакрытая структура — случай, который ловил и счётчик глубины: он здесь не
  // сходится в ноль. Тест сторожит от регресса самой проверки, а не типов скобок.
  it('незакрытая структура по-прежнему ловится', async () => {
    fetchMock.mockResolvedValue(
      anthropicOk('{"kind":"PRICE","notes":["срочно"}')
    );

    const error = await expectStructuredError(
      structured({ schema: priceSchema, messages: MESSAGES, runConfig: runConfig() })
    );

    expect(error.reason).toBe('TRUNCATED_JSON');
  });

  // Баланс считается по срезу, который увидит нормализация (всё от первой
  // '{'/'['), а не по всему сырому тексту: непарная ']' во вступлении
  // нормализацию не портит и обрывом не является.
  it('проза с непарной «]» перед JSON разбирается, а не помечается обрывом', async () => {
    const raw = 'Готово] Вот ответ: ' + JSON.stringify(VALID_PAYLOAD);
    fetchMock.mockResolvedValue(anthropicOk(raw));

    const result = await structured({
      schema: priceSchema,
      messages: MESSAGES,
      runConfig: runConfig(),
    });

    expect(result.data).toEqual(VALID_PAYLOAD);
  });

  it('markdown-забор вокруг целого JSON по-прежнему не считается обрывом', async () => {
    fetchMock.mockResolvedValue(
      anthropicOk('```json\n' + JSON.stringify(VALID_PAYLOAD) + '\n```', 'end_turn')
    );

    const result = await structured({
      schema: priceSchema,
      messages: MESSAGES,
      runConfig: runConfig(),
    });

    expect(result.data).toEqual(VALID_PAYLOAD);
  });

  // Провайдер сказал «закончил сам», но текст оборван — доверять слову провайдера
  // как ОТРИЦАНИЮ обрыва нельзя, поэтому эвристика остаётся включённой.
  it('эвристика продолжает работать при stop_reason=end_turn', async () => {
    fetchMock.mockResolvedValue(
      anthropicOk('{"kind":"PRICE","notes":["срочный тариф', 'end_turn')
    );

    const error = await expectStructuredError(
      structured({ schema: priceSchema, messages: MESSAGES, runConfig: runConfig() })
    );

    expect(error.reason).toBe('TRUNCATED_JSON');
    expect(error.issues[0].code).toBe('truncated_response');
  });
});
