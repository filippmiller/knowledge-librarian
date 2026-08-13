import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openaiCreate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/openai', () => ({
  openai: { chat: { completions: { create: openaiCreate } } },
  CHAT_MODEL: 'gpt-4o',
}));

import {
  ChatCompletionError,
  createChatCompletion,
  createChatCompletionDetailed,
  createChatCompletionStreamDetailed,
  isRetryableChatCompletionError,
  normalizeJsonResponse,
  resolveFallbackPolicy,
  resolveRunConfig,
  streamChatCompletionTokens,
  type ChatCompletionOptions,
} from '../chat-provider';
import { CostLedger } from '../cost-ledger';

describe('outer ChatCompletionError retry policy', () => {
  it.each([400, 401, 403, 404, 422])('classifies permanent %s as non-retryable', (statusCode) => {
    expect(isRetryableChatCompletionError(new ChatCompletionError('permanent', [], { statusCode }))).toBe(false);
  });

  it.each([408, 409, 429, 500, 502, 503])('classifies transient %s as retryable', (statusCode) => {
    expect(isRetryableChatCompletionError(new ChatCompletionError('transient', [], { statusCode }))).toBe(true);
  });
});

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MESSAGES: ChatCompletionOptions['messages'] = [
  { role: 'user', content: 'hi' },
];

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * `callAnthropic` теперь читает SSE (translation-gy3), а не плоский JSON —
 * этот хелпер эмитит настоящую последовательность фреймов
 * (message_start → content_block_delta → message_delta → message_stop),
 * ОДНИМ content_block_delta на весь текст, чтобы rawText реконструировался
 * байт-в-байт. Сигнатура не изменилась — ~45 существующих вызовов этого
 * файла правок не требуют.
 */
function anthropicOk(
  text: string,
  usage: { input_tokens: number; output_tokens: number } = { input_tokens: 10, output_tokens: 5 }
): Response {
  return anthropicSseFramesResponse([
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input_tokens, output_tokens: 0 },
      },
    },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: usage.output_tokens },
    },
    { type: 'message_stop' },
  ]);
}

/** 500 не входит в RETRYABLE_STATUS_CODES — фоллбэк начинается сразу, без sleep. */
function anthropicFailure(status = 500, body = 'anthropic is down'): Response {
  return new Response(body, { status });
}

function openaiOk(
  text: string,
  usage: { prompt_tokens: number; completion_tokens: number } = {
    prompt_tokens: 12,
    completion_tokens: 6,
  }
) {
  return { choices: [{ message: { content: text } }], usage };
}

function openaiFailure(message = 'openai is down') {
  return Object.assign(new Error(message), { status: 500 });
}

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** Запрос, который не завершается сам — только по signal. */
function hangUntilAbort(init?: RequestInit): Promise<Response> {
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

function sseEvents(texts: string[]): string {
  return texts
    .map(
      (text) =>
        `data: ${JSON.stringify({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text },
        })}\n`
    )
    .join('');
}

function sseResponse(texts: string[]): Response {
  const body = sseEvents(texts) + 'data: [DONE]\n';
  return new Response(new TextEncoder().encode(body), { status: 200 });
}

/**
 * Общий билдер SSE-тела из произвольной последовательности фреймов —
 * каждый фрейм становится строкой `data: {...}\n`. `sseEvents()`/`sseResponse()`
 * выше годятся только для чистого потока `content_block_delta`; этот билдер
 * нужен там, где важны `message_start`/`message_delta` usage или mid-stream
 * `error`-фрейм (translation-gy3 streaming fix).
 */
function anthropicSseFrames(frames: Record<string, unknown>[]): string {
  return frames.map((frame) => `data: ${JSON.stringify(frame)}\n`).join('');
}

function anthropicSseFramesResponse(frames: Record<string, unknown>[]): Response {
  return new Response(anthropicSseFrames(frames), { status: 200 });
}

/**
 * SSE-ответ, застывающий после первой порции. Эагерный насос читает токены сам,
 * поэтому без такого шлюза «потребитель разорвал стрим на середине» превратился
 * бы в гонку с уже дочитанным ответом.
 */
function gatedSseResponse(first: string[], rest: string[]) {
  let release!: () => void;
  const gate = new Promise<'released'>((resolve) => {
    release = () => resolve('released');
  });
  const encoder = new TextEncoder();

  const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode(sseEvents(first)));

        const signal = init?.signal;
        const aborted = new Promise<'aborted'>((resolve) => {
          if (!signal) return;
          if (signal.aborted) resolve('aborted');
          else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
        });

        if ((await Promise.race([gate, aborted])) === 'aborted') {
          controller.error(abortError());
          return;
        }
        controller.enqueue(encoder.encode(sseEvents(rest) + 'data: [DONE]\n'));
        controller.close();
      },
      cancel() {
        release();
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };

  return { fetchImpl, release };
}

/**
 * Слушатели внешнего signal обязаны сниматься на любом пути завершения —
 * иначе долгоживущий контроллер вызывающего копит их от операции к операции.
 */
function trackSignalListeners(signal: AbortSignal) {
  const added = vi.spyOn(signal, 'addEventListener');
  const removed = vi.spyOn(signal, 'removeEventListener');
  return {
    expectAllReleased() {
      for (const [, handler] of added.mock.calls) {
        expect(removed.mock.calls.some(([, other]) => other === handler)).toBe(true);
      }
    },
  };
}

function anthropicRequestBodies(): Record<string, unknown>[] {
  return fetchMock.mock.calls
    .filter((call) => call[0] === ANTHROPIC_URL)
    .map((call) => JSON.parse((call[1] as RequestInit).body as string));
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

describe('resolveFallbackPolicy', () => {
  it('оставляет legacy CROSS_PROVIDER, когда модель не закреплена', () => {
    expect(resolveFallbackPolicy({ messages: MESSAGES })).toBe('CROSS_PROVIDER');
  });

  it('fail-closed (NONE) при закреплённой модели без providerModels', () => {
    expect(
      resolveFallbackPolicy({
        messages: MESSAGES,
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      })
    ).toBe('NONE');
  });

  it('разрешает CROSS_PROVIDER, когда для резерва задан свой model ID', () => {
    expect(
      resolveFallbackPolicy({
        messages: MESSAGES,
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        providerModels: { openai: 'gpt-4o-mini' },
      })
    ).toBe('CROSS_PROVIDER');
  });

  it('явно заданная политика важнее дефолта, когда резерв достижим', () => {
    expect(
      resolveFallbackPolicy({
        messages: MESSAGES,
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        fallbackPolicy: 'SAME_PROVIDER_ONLY',
        providerModels: { anthropic: 'claude-haiku-4' },
      })
    ).toBe('SAME_PROVIDER_ONLY');
  });

  it('возвращает ФАКТИЧЕСКУЮ политику: явный CROSS_PROVIDER при пиннинге без карты моделей — это NONE', () => {
    // Иначе артефакт прогона (A2) писал бы «CROSS_PROVIDER» там, где фоллбэк
    // на самом деле заблокирован — телеметрия врала бы про поведение.
    expect(
      resolveFallbackPolicy({
        messages: MESSAGES,
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        fallbackPolicy: 'CROSS_PROVIDER',
      })
    ).toBe('NONE');
  });

  it('SAME_PROVIDER_ONLY без достижимой альтернативной модели — это NONE', () => {
    expect(
      resolveFallbackPolicy({
        messages: MESSAGES,
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        fallbackPolicy: 'SAME_PROVIDER_ONLY',
      })
    ).toBe('NONE');
    expect(
      resolveFallbackPolicy({
        messages: MESSAGES,
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        fallbackPolicy: 'SAME_PROVIDER_ONLY',
        providerModels: { anthropic: 'claude-sonnet-5' },
      })
    ).toBe('NONE');
  });
});

describe('beforeProviderAttempt hard circuit breaker', () => {
  it('budgeted OpenAI request disables hidden SDK retries', async () => {
    openaiCreate.mockResolvedValue(openaiOk('ok'));
    await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'openai',
      fallbackPolicy: 'NONE',
      beforeProviderAttempt: () => {},
    });

    expect(openaiCreate.mock.calls[0][1]).toMatchObject({ maxRetries: 0 });
  });

  it('ordinary production OpenAI request preserves the shared client retry policy', async () => {
    openaiCreate.mockResolvedValue(openaiOk('ok'));
    await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'openai',
      fallbackPolicy: 'NONE',
    });

    expect(openaiCreate.mock.calls[0][1]).not.toHaveProperty('maxRetries');
  });

  it('ceiling=1 prevents the second primary raw retry', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(anthropicFailure(429, 'rate_limit'));
      let reservations = 0;
      const promise = createChatCompletionDetailed({
        messages: MESSAGES,
        provider: 'anthropic',
        fallbackPolicy: 'NONE',
        beforeProviderAttempt: () => {
          if (reservations >= 1) throw new Error('paid-call ceiling');
          reservations += 1;
        },
      });
      const rejection = expect(promise).rejects.toThrow('paid-call ceiling');

      await vi.runAllTimersAsync();
      await rejection;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(reservations).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ceiling=1 prevents a fallback raw request after the primary request', async () => {
    fetchMock.mockResolvedValue(anthropicFailure(500));
    openaiCreate.mockResolvedValue(openaiOk('must not be reached'));
    let reservations = 0;

    await expect(
      createChatCompletionDetailed({
        messages: MESSAGES,
        provider: 'anthropic',
        providerModels: { openai: 'gpt-fallback' },
        fallbackPolicy: 'CROSS_PROVIDER',
        beforeProviderAttempt: () => {
          if (reservations >= 1) throw new Error('paid-call ceiling');
          reservations += 1;
        },
      })
    ).rejects.toThrow('paid-call ceiling');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(openaiCreate).not.toHaveBeenCalled();
    expect(reservations).toBe(1);
  });
});

describe('resolveRunConfig', () => {
  it('отдаёт фактическую конфигурацию прогона, а не сырые env', () => {
    expect(
      resolveRunConfig({
        messages: MESSAGES,
        provider: 'openai',
        model: 'gpt-5-mini',
        promptVersion: 'extraction@3',
        requestTimeoutMs: 1000,
      })
    ).toEqual({
      provider: 'openai',
      model: 'gpt-5-mini',
      promptVersion: 'extraction@3',
      fallbackPolicy: 'NONE',
      requestTimeoutMs: 1000,
      totalDeadlineMs: undefined,
    });
  });

  it('подставляет env-дефолты, когда модель не закреплена', () => {
    expect(resolveRunConfig({ messages: MESSAGES })).toMatchObject({
      provider: 'anthropic',
      model: 'claude-env-default',
      promptVersion: 'unversioned',
      fallbackPolicy: 'CROSS_PROVIDER',
    });
  });
});

describe('createChatCompletionDetailed — primary success', () => {
  it('возвращает текст и телеметрию первой попытки', async () => {
    fetchMock.mockResolvedValue(anthropicOk('hello'));

    const result = await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
    });

    expect(result.text).toBe('hello');
    expect(result.servedByProvider).toBe('anthropic');
    expect(result.servedByModel).toBe('claude-env-default');
    expect(result.fallbackUsed).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-env-default',
      outcome: 'SUCCESS',
    });
    expect(typeof result.attempts[0].latencyMs).toBe('number');
    expect(Number.isNaN(Date.parse(result.attempts[0].startedAt))).toBe(false);
    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it('createChatCompletion остаётся тонкой обёрткой над .text', async () => {
    fetchMock.mockResolvedValue(anthropicOk('hello'));
    await expect(
      createChatCompletion({ messages: MESSAGES, provider: 'anthropic' })
    ).resolves.toBe('hello');
  });

  // Cost meter (Task 37, 2026-08-09): token usage was previously discarded
  // entirely at this layer — callAnthropic/callOpenAI returned only `string`,
  // throwing away the provider's own usage block. No cost/call meter could
  // exist without this. Captured per-attempt (not just on the final result)
  // because a failed/retried attempt still costs real tokens.
  it('захватывает usage из ответа Anthropic (input_tokens/output_tokens)', async () => {
    fetchMock.mockResolvedValue(anthropicOk('hello', { input_tokens: 123, output_tokens: 45 }));

    const result = await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
    });

    expect(result.attempts[0].usage).toEqual({ inputTokens: 123, outputTokens: 45 });
  });

  it('захватывает usage из ответа OpenAI (prompt_tokens/completion_tokens)', async () => {
    openaiCreate.mockResolvedValue(openaiOk('hi', { prompt_tokens: 77, completion_tokens: 33 }));

    const result = await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'openai',
    });

    expect(result.attempts[0].usage).toEqual({ inputTokens: 77, outputTokens: 33 });
  });

  // Call-trace log (2026-08-10): the user has zero visibility into
  // what was actually SENT to the model, only aggregate cost. requestMessages
  // is the source for that — the exact prompt behind any given attempt.
  it('несёт requestMessages — ровно options.messages, для трассировки вызова', async () => {
    fetchMock.mockResolvedValue(anthropicOk('hello'));

    const result = await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
    });

    expect(result.requestMessages).toEqual(MESSAGES);
  });
});

describe('OpenAI JSON-режим требует упоминания JSON в сообщениях', () => {
  // OpenAI отклоняет response_format:json_object, если слово JSON не встречается
  // ни в одном сообщении — это их API-требование. Anthropic-путь такую
  // инструкцию добавлял, OpenAI-путь слал messages как есть: на моках зелено, на
  // живом вызове 400. Ровно тот класс «в тестах работает, в проде нет».
  it('добавляет инструкцию, когда вызывающий про JSON не написал', async () => {
    openaiCreate.mockResolvedValue(openaiOk('{"ok":true}'));

    await createChatCompletionDetailed({
      messages: [{ role: 'user', content: 'Извлеки правила из документа.' }],
      provider: 'openai',
      responseFormat: 'json_object',
    });

    const sent = openaiCreate.mock.calls[0][0].messages as { content: string }[];
    expect(sent.some((m) => /json/i.test(m.content))).toBe(true);
  });

  it('не дублирует инструкцию, если вызывающий уже просит JSON', async () => {
    openaiCreate.mockResolvedValue(openaiOk('{"ok":true}'));

    await createChatCompletionDetailed({
      messages: [{ role: 'user', content: 'Ответь в формате JSON.' }],
      provider: 'openai',
      responseFormat: 'json_object',
    });

    const sent = openaiCreate.mock.calls[0][0].messages as { content: string }[];
    expect(sent).toHaveLength(1);
  });

  it('без json_object сообщения не трогаются', async () => {
    openaiCreate.mockResolvedValue(openaiOk('просто текст'));

    await createChatCompletionDetailed({
      messages: [{ role: 'user', content: 'Расскажи про апостиль.' }],
      provider: 'openai',
    });

    const sent = openaiCreate.mock.calls[0][0].messages as { content: string }[];
    expect(sent).toHaveLength(1);
    expect(/json/i.test(sent[0].content)).toBe(false);
  });
});

describe('prompt caching (Anthropic)', () => {
  // W1-B (2026-08-10): большие system-промпты (экстракция, coverage-audit,
  // QueryFrame) переотправлялись на КАЖДЫЙ вызов по полной входной цене.
  // Минимумы кэширования — из скилла `claude-api` (сверено 2026-08-10):
  // claude-sonnet-5 → 1024 токена.

  /** ~5250 ASCII-символов ≈ 1312 токенов по оценке провайдер-слоя — выше
   *  минимума Sonnet 5 (1024) и ниже минимума неизвестной модели (4096). */
  const LONG_SYSTEM = 'System instructions line. '.repeat(210);

  it('ставит cache breakpoint на system-промпт, когда он выше минимума модели', async () => {
    fetchMock.mockResolvedValue(anthropicOk('ok'));

    await createChatCompletionDetailed({
      messages: [{ role: 'system', content: LONG_SYSTEM }, ...MESSAGES],
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });

    expect(anthropicRequestBodies()[0].system).toEqual([
      {
        type: 'text',
        text: LONG_SYSTEM.trim(),
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('короткий system-промпт остаётся строкой: breakpoint ниже минимума впустую', async () => {
    fetchMock.mockResolvedValue(anthropicOk('ok'));

    await createChatCompletionDetailed({
      messages: [{ role: 'system', content: 'Отвечай кратко.' }, ...MESSAGES],
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });

    expect(anthropicRequestBodies()[0].system).toBe('Отвечай кратко.');
  });

  it('модель с неизвестным минимумом кэшируется fail-closed, а не наугад', async () => {
    // claude-env-default нет в таблице минимумов — берётся самый строгий
    // документированный минимум (4096), и промпт на ~1300 токенов его не
    // проходит. Иначе слой ставил бы breakpoint вслепую на модели, чей
    // порог может оказаться выше (минимум НЕ монотонен по поколениям).
    fetchMock.mockResolvedValue(anthropicOk('ok'));

    await createChatCompletionDetailed({
      messages: [{ role: 'system', content: LONG_SYSTEM }, ...MESSAGES],
      provider: 'anthropic',
    });

    expect(anthropicRequestBodies()[0].system).toBe(LONG_SYSTEM.trim());
  });

  it('стриминг кэширует тот же system-префикс', async () => {
    fetchMock.mockResolvedValue(sseResponse(['ok']));

    const operation = createChatCompletionStreamDetailed({
      messages: [{ role: 'system', content: LONG_SYSTEM }, ...MESSAGES],
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });
    await operation.completion;

    expect(anthropicRequestBodies()[0].system).toEqual([
      {
        type: 'text',
        text: LONG_SYSTEM.trim(),
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('OpenAI-путь не трогается: у него другая семантика кэширования', async () => {
    openaiCreate.mockResolvedValue(openaiOk('ok'));

    await createChatCompletionDetailed({
      messages: [{ role: 'system', content: LONG_SYSTEM }, ...MESSAGES],
      provider: 'openai',
      model: 'gpt-4o',
    });

    expect(JSON.stringify(openaiCreate.mock.calls[0][0])).not.toContain('cache_control');
  });

  it('поднимает cache-счётчики Anthropic в usage — добавочно, не подменяя input/output', async () => {
    fetchMock.mockResolvedValue(
      anthropicSseFramesResponse([
        {
          type: 'message_start',
          message: {
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            model: 'test-model',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 12,
              output_tokens: 0,
              cache_creation_input_tokens: 1300,
              cache_read_input_tokens: 0,
            },
          },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 5 },
        },
        { type: 'message_stop' },
      ])
    );

    const result = await createChatCompletionDetailed({
      messages: [{ role: 'system', content: LONG_SYSTEM }, ...MESSAGES],
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });

    expect(result.attempts[0].usage).toEqual({
      inputTokens: 12,
      outputTokens: 5,
      cacheCreationInputTokens: 1300,
      cacheReadInputTokens: 0,
    });
  });

  it('без cache-счётчиков usage остаётся ровно {inputTokens, outputTokens}', async () => {
    // Регрессия на уже существующие моки в других файлах: они сверяют usage
    // через toEqual, и ключ со значением undefined сделал бы их красными.
    fetchMock.mockResolvedValue(anthropicOk('ok', { input_tokens: 10, output_tokens: 5 }));

    const result = await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
    });

    expect(result.attempts[0].usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});

describe('createChatCompletionDetailed — фоллбэк', () => {
  it('при providerModels уходит к резерву с ЕГО model ID, а не с закреплённым', async () => {
    fetchMock.mockResolvedValue(anthropicFailure());
    openaiCreate.mockResolvedValue(openaiOk('from openai'));

    const result = await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      providerModels: { anthropic: 'claude-sonnet-5', openai: 'gpt-4o-mini' },
    });

    expect(result.text).toBe('from openai');
    expect(result.servedByProvider).toBe('openai');
    expect(result.servedByModel).toBe('gpt-4o-mini');
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts.map((a) => a.outcome)).toEqual(['ERROR', 'SUCCESS']);
    expect(result.attempts[0].statusCode).toBe(500);

    // Регрессия, ради которой существует PR: закреплённая claude-модель
    // уезжала в OpenAI и возвращала model_not_found.
    expect(openaiCreate).toHaveBeenCalledTimes(1);
    expect(openaiCreate.mock.calls[0][0].model).toBe('gpt-4o-mini');
    expect(anthropicRequestBodies()[0].model).toBe('claude-sonnet-5');

    // Call-trace log: retry/fallback переезжают к другому провайдеру/модели, но НЕ
    // меняют промпт — requestMessages на результате остаётся тем же, что было
    // отправлено первичной попытке.
    expect(result.requestMessages).toEqual(MESSAGES);
  });

  it('fail-closed: закреплённая модель без providerModels НЕ уходит другому провайдеру', async () => {
    fetchMock.mockResolvedValue(anthropicFailure());
    openaiCreate.mockResolvedValue(openaiOk('should never be used'));

    const error = await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ChatCompletionError);
    expect((error as ChatCompletionError).attempts).toHaveLength(1);
    expect((error as ChatCompletionError).attempts[0].provider).toBe('anthropic');
    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it('явный CROSS_PROVIDER не отменяет fail-closed для закреплённой модели', async () => {
    fetchMock.mockResolvedValue(anthropicFailure());
    openaiCreate.mockResolvedValue(openaiOk('should never be used'));

    await expect(
      createChatCompletionDetailed({
        messages: MESSAGES,
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        fallbackPolicy: 'CROSS_PROVIDER',
      })
    ).rejects.toBeInstanceOf(ChatCompletionError);

    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it('legacy: незакреплённый вызов по-прежнему падает на другого провайдера с его дефолтом', async () => {
    fetchMock.mockResolvedValue(anthropicFailure());
    openaiCreate.mockResolvedValue(openaiOk('legacy fallback'));

    const result = await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
    });

    expect(result.text).toBe('legacy fallback');
    expect(result.servedByProvider).toBe('openai');
    expect(result.servedByModel).toBe('gpt-env-default');
    expect(result.fallbackUsed).toBe(true);
    expect(openaiCreate.mock.calls[0][0].model).toBe('gpt-env-default');
  });

  it('legacy-фоллбэк работает и когда провайдер выбран через AI_PROVIDER, без options.provider', async () => {
    // Регрессия на все 34 существующих call site: они не закрепляют модель и
    // не передают provider — фоллбэк для них обязан остаться живым.
    fetchMock.mockResolvedValue(anthropicFailure());
    openaiCreate.mockResolvedValue(openaiOk('still resilient'));

    const result = await createChatCompletionDetailed({ messages: MESSAGES });

    expect(result.text).toBe('still resilient');
    expect(result.servedByProvider).toBe('openai');
    expect(result.fallbackUsed).toBe(true);
  });

  it('SAME_PROVIDER_ONLY уходит на альтернативную модель того же провайдера', async () => {
    fetchMock
      .mockResolvedValueOnce(anthropicFailure())
      .mockResolvedValueOnce(anthropicOk('from haiku'));

    const result = await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      fallbackPolicy: 'SAME_PROVIDER_ONLY',
      providerModels: { anthropic: 'claude-haiku-4' },
    });

    expect(result.servedByProvider).toBe('anthropic');
    expect(result.servedByModel).toBe('claude-haiku-4');
    expect(result.fallbackUsed).toBe(true);
    expect(anthropicRequestBodies().map((b) => b.model)).toEqual([
      'claude-sonnet-5',
      'claude-haiku-4',
    ]);
    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it('NONE не пробует резерв вовсе', async () => {
    fetchMock.mockResolvedValue(anthropicFailure());

    await expect(
      createChatCompletionDetailed({
        messages: MESSAGES,
        provider: 'anthropic',
        fallbackPolicy: 'NONE',
      })
    ).rejects.toBeInstanceOf(ChatCompletionError);

    expect(openaiCreate).not.toHaveBeenCalled();
  });
});

describe('createChatCompletionDetailed — полный отказ', () => {
  it('падают оба провайдера → ChatCompletionError с двумя попытками', async () => {
    fetchMock.mockResolvedValue(anthropicFailure());
    openaiCreate.mockRejectedValue(openaiFailure());

    const error = (await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
    }).catch((e: unknown) => e)) as ChatCompletionError;

    expect(error).toBeInstanceOf(ChatCompletionError);
    expect(error.attempts).toHaveLength(2);
    expect(error.attempts.map((a) => a.provider)).toEqual(['anthropic', 'openai']);
    expect(error.attempts.every((a) => a.outcome === 'ERROR')).toBe(true);
  });

  it('message — сырое сообщение ПЕРВИЧНОГО провайдера, без сводки попыток', async () => {
    fetchMock.mockResolvedValue(anthropicFailure(500, 'anthropic exploded'));
    openaiCreate.mockRejectedValue(openaiFailure('openai exploded'));

    const error = (await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
    }).catch((e: unknown) => e)) as ChatCompletionError;

    // Два сегодняшних потребителя читают текст как есть: health-эндпоинт —
    // error.message, consistency-gate — String(err). Ни один не должен
    // разбирать добавленный provider-слоем формат.
    expect(error.message).toBe('Anthropic API error (500): anthropic exploded');
    expect(String(error)).toContain('anthropic exploded');
    expect((error.cause as Error).message).toContain('anthropic exploded');
    expect(error.statusCode).toBe(500);

    // Диагностика резерва не потеряна — она в структурных полях, не в тексте.
    expect(error.message).not.toContain('openai exploded');
    expect(error.attempts).toHaveLength(2);
    expect(error.attempts[1]).toMatchObject({
      provider: 'openai',
      outcome: 'ERROR',
      statusCode: 500,
    });

    // Call-trace log: полный отказ (ни один провайдер не ответил) — ответа нет
    // вообще, но что именно спрашивали остаётся видимым в трассировке.
    expect(error.requestMessages).toEqual(MESSAGES);
  });
});

describe('createChatCompletionDetailed — конфигурация заморожена на время вызова', () => {
  it('мутация env между первичной попыткой и резервом не меняет модель резерва', async () => {
    // Дефолты читаются во время вызова (это лучше для тестируемости), но внутри
    // ОДНОГО вызова обязаны быть заморожены: иначе резерв поехал бы с моделью,
    // которую вызывающий никогда не запрашивал.
    fetchMock.mockImplementation(() => {
      vi.stubEnv('OPENAI_CHAT_MODEL', 'gpt-mutated-mid-call');
      vi.stubEnv('AI_TEMPERATURE', '0.99');
      return Promise.resolve(anthropicFailure());
    });
    openaiCreate.mockResolvedValue(openaiOk('served by fallback'));

    const result = await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
    });

    expect(result.servedByModel).toBe('gpt-env-default');
    expect(openaiCreate.mock.calls[0][0].model).toBe('gpt-env-default');
    expect(openaiCreate.mock.calls[0][0].temperature).toBe(0.3);
  });

  it('мутация env не меняет бюджет токенов и температуру уже начатого вызова', async () => {
    vi.stubEnv('ANTHROPIC_MAX_TOKENS', '2048');
    fetchMock.mockImplementation(() => {
      vi.stubEnv('ANTHROPIC_MAX_TOKENS', '77');
      vi.stubEnv('AI_TEMPERATURE', '0.99');
      return Promise.resolve(anthropicFailure());
    });

    await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      fallbackPolicy: 'SAME_PROVIDER_ONLY',
      providerModels: { anthropic: 'claude-haiku-4' },
    }).catch(() => undefined);

    const bodies = anthropicRequestBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies.map((b) => b.model)).toEqual(['claude-sonnet-5', 'claude-haiku-4']);
    expect(bodies.map((b) => b.max_tokens)).toEqual([2048, 2048]);
    expect(bodies.map((b) => b.temperature)).toEqual([0.3, 0.3]);
  });

  it('стриминг тоже фиксирует конфигурацию в момент создания операции', async () => {
    fetchMock.mockResolvedValue(sseResponse(['ok']));

    const operation = createChatCompletionStreamDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
    });
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-mutated-mid-stream');
    vi.stubEnv('AI_TEMPERATURE', '0.99');

    const tokens: string[] = [];
    for await (const token of operation.tokens) tokens.push(token);
    const metadata = await operation.completion;

    expect(tokens).toEqual(['ok']);
    expect(metadata.servedByModel).toBe('claude-env-default');
    expect(anthropicRequestBodies()[0].temperature).toBe(0.3);
  });
});

describe('createChatCompletionDetailed — что считается транзиентной ошибкой', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('структурный retryable-статус по-прежнему запускает retry', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(anthropicFailure(503, 'upstream hiccup'))
      .mockResolvedValueOnce(anthropicOk('recovered'));

    const pending = createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      fallbackPolicy: 'NONE',
    });
    // Первый backoff — BASE_DELAY_MS (1000мс).
    await vi.advanceTimersByTimeAsync(1000);

    const result = await pending;
    expect(result.text).toBe('recovered');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ outcome: 'ERROR', statusCode: 503 });
    expect(result.attempts[1].outcome).toBe('SUCCESS');
  });

  it('число, похожее на статус, В ТЕКСТЕ сообщения retry НЕ запускает', async () => {
    // Иначе любая ошибка, чей текст содержит «(429)» — например эхо чужого
    // payload — превращалась бы в четыре обращения к API и ~7с backoff.
    vi.stubEnv('AI_PROVIDER', 'openai');
    openaiCreate.mockRejectedValue(new Error('stream chunk (429) failed to parse'));

    const error = (await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'openai',
      fallbackPolicy: 'NONE',
    }).catch((e: unknown) => e)) as ChatCompletionError;

    expect(error).toBeInstanceOf(ChatCompletionError);
    expect(openaiCreate).toHaveBeenCalledTimes(1);
    expect(error.attempts).toHaveLength(1);
    // Выдуманный статус не должен попадать и в телеметрию.
    expect(error.attempts[0].statusCode).toBeUndefined();
  });

  it('нормализованный код ошибки провайдера запускает retry без всякого статуса', async () => {
    vi.useFakeTimers();
    vi.stubEnv('AI_PROVIDER', 'openai');
    openaiCreate
      .mockRejectedValueOnce(
        Object.assign(new Error('fetch failed'), {
          cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        })
      )
      .mockResolvedValueOnce(openaiOk('recovered'));

    const pending = createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'openai',
      fallbackPolicy: 'NONE',
    });
    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toMatchObject({ text: 'recovered' });
    expect(openaiCreate).toHaveBeenCalledTimes(2);
  });
});

describe('createChatCompletionDetailed — таймауты и отмена', () => {
  it('таймаут попытки внутри totalDeadlineMs: ABORTED + резерв успевает', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      hangUntilAbort(init)
    );
    openaiCreate.mockResolvedValue(openaiOk('rescued'));

    const result = await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      requestTimeoutMs: 30,
      totalDeadlineMs: 5000,
    });

    expect(result.text).toBe('rescued');
    expect(result.fallbackUsed).toBe(true);
    expect(result.attempts[0]).toMatchObject({
      outcome: 'ABORTED',
      errorCode: 'ATTEMPT_TIMEOUT',
    });
    expect(result.attempts[1].outcome).toBe('SUCCESS');
  });

  it('превышение totalDeadlineMs: резерв не начинается', async () => {
    // Решение принимается по ЗАПИСАННОМУ исходу попытки: таймер может
    // сработать на доли миллисекунды раньше срока, и перемер часов показал бы
    // «бюджет ещё есть» уже после наступления дедлайна.
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      hangUntilAbort(init)
    );
    openaiCreate.mockResolvedValue(openaiOk('too late'));

    const error = (await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      totalDeadlineMs: 40,
    }).catch((e: unknown) => e)) as ChatCompletionError;

    expect(error).toBeInstanceOf(ChatCompletionError);
    expect(error.attempts).toHaveLength(1);
    expect(error.attempts[0]).toMatchObject({
      outcome: 'ABORTED',
      errorCode: 'TOTAL_DEADLINE_EXCEEDED',
    });
    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it('retry не начинается, если backoff не укладывается в дедлайн', async () => {
    // 429 — retryable, backoff 1000ms; дедлайна 150ms на него не хватает,
    // поэтому попытка к первичному провайдеру ровно одна.
    fetchMock.mockResolvedValue(anthropicFailure(429, 'rate_limit'));
    openaiCreate.mockResolvedValue(openaiOk('fallback after skipped retry'));

    const result = await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      totalDeadlineMs: 150,
    });

    expect(result.text).toBe('fallback after skipped retry');
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({
      provider: 'anthropic',
      outcome: 'ERROR',
      statusCode: 429,
    });
    expect(result.attempts[1].provider).toBe('openai');
  });

  it('requestTimeoutMs: 0 означает «времени нет», а не «времени сколько угодно»', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      hangUntilAbort(init)
    );
    openaiCreate.mockResolvedValue(openaiOk('rescued'));

    const result = await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      requestTimeoutMs: 0,
    });

    expect(result.attempts[0]).toMatchObject({
      outcome: 'ABORTED',
      errorCode: 'ATTEMPT_TIMEOUT',
    });
    expect(result.fallbackUsed).toBe(true);
  });

  it('внешняя отмена → ABORTED_BY_CALLER и никакого резерва', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      setTimeout(() => controller.abort(), 10);
      return hangUntilAbort(init);
    });
    openaiCreate.mockResolvedValue(openaiOk('should never be used'));

    const error = (await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      signal: controller.signal,
    }).catch((e: unknown) => e)) as ChatCompletionError;

    expect(error).toBeInstanceOf(ChatCompletionError);
    expect(error.attempts).toHaveLength(1);
    expect(error.attempts[0]).toMatchObject({
      outcome: 'ABORTED',
      errorCode: 'ABORTED_BY_CALLER',
    });
    expect(openaiCreate).not.toHaveBeenCalled();
  });
});

describe('streaming', () => {
  it('streamChatCompletionTokens уважает options.provider, а не только AI_PROVIDER', async () => {
    vi.stubEnv('AI_PROVIDER', 'openai');
    fetchMock.mockResolvedValue(sseResponse(['a', 'b']));

    const tokens: string[] = [];
    for await (const token of streamChatCompletionTokens({
      messages: MESSAGES,
      provider: 'anthropic',
    })) {
      tokens.push(token);
    }

    expect(tokens).toEqual(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(ANTHROPIC_URL);
    expect(openaiCreate).not.toHaveBeenCalled();
  });

  it('completion разрешается полным текстом при нормальном завершении', async () => {
    fetchMock.mockResolvedValue(sseResponse(['foo', 'bar']));

    const operation = createChatCompletionStreamDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
    });

    const tokens: string[] = [];
    for await (const token of operation.tokens) tokens.push(token);

    const metadata = await operation.completion;
    expect(tokens).toEqual(['foo', 'bar']);
    expect(metadata.text).toBe('foobar');
    expect(metadata.servedByModel).toBe('claude-sonnet-5');
    expect(metadata.fallbackUsed).toBe(false);
    expect(metadata.attempts).toHaveLength(1);
    expect(metadata.attempts[0].outcome).toBe('SUCCESS');
    // Call-trace log: тот же call-trace источник, что и у не-стримингового пути.
    expect(metadata.requestMessages).toEqual(MESSAGES);
  });

  it('completion разрешается, даже если tokens не читали ВООБЩЕ', async () => {
    // Ровно тот случай, ради которого операция стала эагерной: у ленивого
    // генератора тело (и его finally) не выполнялось, пока никто не итерировал,
    // и completion висела вечно вместе с AbortController и слушателем signal.
    fetchMock.mockResolvedValue(sseResponse(['foo', 'bar']));

    const operation = createChatCompletionStreamDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
    });

    const metadata = await operation.completion;
    expect(metadata.text).toBe('foobar');
    expect(metadata.attempts).toHaveLength(1);
    expect(metadata.attempts[0].outcome).toBe('SUCCESS');
  });

  it('таймер попытки снимается на пути «tokens не читали»', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockResolvedValue(sseResponse(['foo']));

      const operation = createChatCompletionStreamDetailed({
        messages: MESSAGES,
        provider: 'anthropic',
        requestTimeoutMs: 30_000,
      });
      // Проверка живая: до завершения таймер действительно висит.
      expect(vi.getTimerCount()).toBe(1);

      await operation.completion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('слушатель внешнего signal снимается, даже если tokens не читали', async () => {
    fetchMock.mockResolvedValue(sseResponse(['foo']));
    const controller = new AbortController();
    const listeners = trackSignalListeners(controller.signal);

    const operation = createChatCompletionStreamDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      signal: controller.signal,
    });

    await operation.completion;
    listeners.expectAllReleased();
  });

  it('abort() до первого чтения отклоняет completion и не оставляет висяков', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      hangUntilAbort(init)
    );
    const controller = new AbortController();
    const listeners = trackSignalListeners(controller.signal);

    const operation = createChatCompletionStreamDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      signal: controller.signal,
    });
    operation.abort('caller changed its mind');
    // Причину называет первая отмена: безаргументный повтор её не стирает.
    operation.abort();

    const error = (await operation.completion.catch(
      (e: unknown) => e
    )) as ChatCompletionError;
    expect(error).toBeInstanceOf(ChatCompletionError);
    expect(error.message).toBe('caller changed its mind');
    expect(error.attempts[0]).toMatchObject({
      outcome: 'ABORTED',
      errorCode: 'ABORTED_BY_CALLER',
    });
    listeners.expectAllReleased();
    // Call-trace log: даже при явной отмене видно, что именно спрашивали.
    expect(error.requestMessages).toEqual(MESSAGES);

    // Повторный abort() и abort() после завершения — no-op, не второй attempt.
    operation.abort();
    expect(error.attempts).toHaveLength(1);
  });

  it('потребитель, подключившийся ПОСЛЕ завершения, получает все токены', async () => {
    fetchMock.mockResolvedValue(sseResponse(['one', 'two', 'three']));

    const operation = createChatCompletionStreamDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
    });

    const metadata = await operation.completion;
    expect(metadata.text).toBe('onetwothree');

    const tokens: string[] = [];
    for await (const token of operation.tokens) tokens.push(token);
    expect(tokens).toEqual(['one', 'two', 'three']);
  });

  it('ранний разрыв на середине стрима: completion разрешается префиксом', async () => {
    const gated = gatedSseResponse(['one'], ['two', 'three']);
    fetchMock.mockImplementation(gated.fetchImpl);
    const controller = new AbortController();
    const listeners = trackSignalListeners(controller.signal);

    const operation = createChatCompletionStreamDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      signal: controller.signal,
    });

    const tokens: string[] = [];
    for await (const token of operation.tokens) {
      tokens.push(token);
      break;
    }

    const metadata = await operation.completion;
    expect(tokens).toEqual(['one']);
    expect(metadata.text).toBe('one');
    expect(metadata.attempts).toHaveLength(1);
    expect(metadata.attempts[0]).toMatchObject({
      outcome: 'ABORTED',
      errorCode: 'CONSUMER_CANCELLED',
    });
    // Оставшиеся токены провайдер уже не отдаёт — соединение закрыто.
    expect(metadata.text).not.toContain('two');
    listeners.expectAllReleased();
  });

  it('явный abort() важнее выхода потребителя из for await', async () => {
    // Иначе `operation.abort(); break;` тихо превращался бы в разрешённую
    // completion, хотя вызывающий явно объявил прогон неудавшимся.
    const gated = gatedSseResponse(['one'], ['two']);
    fetchMock.mockImplementation(gated.fetchImpl);

    const operation = createChatCompletionStreamDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
    });

    for await (const token of operation.tokens) {
      expect(token).toBe('one');
      operation.abort('caller gave up');
      break;
    }

    const error = (await operation.completion.catch(
      (e: unknown) => e
    )) as ChatCompletionError;
    expect(error).toBeInstanceOf(ChatCompletionError);
    expect(error.message).toBe('caller gave up');
    expect(error.attempts[0]).toMatchObject({
      outcome: 'ABORTED',
      errorCode: 'ABORTED_BY_CALLER',
    });
  });

  it('буфер непрочитанных токенов ограничен сверху', async () => {
    // Эагерность не должна покупаться неограниченной памятью: если потребителя
    // нет, а провайдер льёт без конца, операция обязана оборваться сама.
    const chunk = 'x'.repeat(100_000);
    fetchMock.mockResolvedValue(
      sseResponse(Array.from({ length: 41 }, () => chunk))
    );

    const operation = createChatCompletionStreamDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
    });

    const error = (await operation.completion.catch(
      (e: unknown) => e
    )) as ChatCompletionError;
    expect(error).toBeInstanceOf(ChatCompletionError);
    expect(error.errorCode).toBe('STREAM_BUFFER_OVERFLOW');
    expect(error.attempts[0]).toMatchObject({
      outcome: 'ERROR',
      errorCode: 'STREAM_BUFFER_OVERFLOW',
    });
  });

  it('исключение в теле потребителя закрывает стрим так же, как break', async () => {
    const gated = gatedSseResponse(['one'], ['two']);
    fetchMock.mockImplementation(gated.fetchImpl);

    const operation = createChatCompletionStreamDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
    });

    await expect(
      (async () => {
        for await (const token of operation.tokens) {
          throw new Error(`consumer blew up on ${token}`);
        }
      })()
    ).rejects.toThrow('consumer blew up on one');

    const metadata = await operation.completion;
    expect(metadata.attempts[0].errorCode).toBe('CONSUMER_CANCELLED');
  });

  it('ошибка провайдера ДО первого токена отклоняет completion без потребителя', async () => {
    fetchMock.mockResolvedValue(anthropicFailure(503, 'upstream unavailable'));
    const controller = new AbortController();
    const listeners = trackSignalListeners(controller.signal);

    const operation = createChatCompletionStreamDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      signal: controller.signal,
    });

    const error = (await operation.completion.catch(
      (e: unknown) => e
    )) as ChatCompletionError;
    expect(error).toBeInstanceOf(ChatCompletionError);
    expect(error.attempts).toHaveLength(1);
    expect(error.attempts[0]).toMatchObject({ outcome: 'ERROR', statusCode: 503 });
    // Текст — сырое сообщение провайдера, без сводки попыток.
    expect(error.message).toBe('Anthropic API error (503): upstream unavailable');
    expect(error.statusCode).toBe(503);
    listeners.expectAllReleased();
  });

  it('ошибка провайдера доходит и до потребителя tokens', async () => {
    fetchMock.mockResolvedValue(anthropicFailure(503, 'upstream unavailable'));

    const operation = createChatCompletionStreamDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
    });

    await expect(
      (async () => {
        for await (const token of operation.tokens) void token;
      })()
    ).rejects.toThrow('Anthropic API error (503)');

    await expect(operation.completion).rejects.toBeInstanceOf(ChatCompletionError);
  });

  it('внешняя отмена стрима отмечается ABORTED, не ERROR', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      setTimeout(() => controller.abort(), 10);
      return hangUntilAbort(init);
    });
    const listeners = trackSignalListeners(controller.signal);

    const operation = createChatCompletionStreamDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      signal: controller.signal,
    });

    await expect(
      (async () => {
        for await (const token of operation.tokens) void token;
      })()
    ).rejects.toThrow();

    const error = (await operation.completion.catch(
      (e: unknown) => e
    )) as ChatCompletionError;
    expect(error.attempts[0]).toMatchObject({
      outcome: 'ABORTED',
      errorCode: 'ABORTED_BY_CALLER',
    });
    listeners.expectAllReleased();
  });

  it('таймаут стрима отмечается собственным кодом бюджета', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      hangUntilAbort(init)
    );

    const operation = createChatCompletionStreamDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      requestTimeoutMs: 20,
    });

    const error = (await operation.completion.catch(
      (e: unknown) => e
    )) as ChatCompletionError;
    expect(error.attempts[0]).toMatchObject({
      outcome: 'ABORTED',
      errorCode: 'ATTEMPT_TIMEOUT',
    });
  });
});

/**
 * translation-gy3: `callAnthropic` (the NON-streaming `createChatCompletionDetailed`
 * path) sends `max_tokens` without `stream: true`. Above ~16K max_tokens this
 * idles through Anthropic's think+generate phase until the server closes the
 * socket — `TypeError: fetch failed` — with all 3 retries hitting the same
 * wall. Fix: stream unconditionally in `callAnthropic`, reusing the SSE
 * parser `streamProviderTokens` already has, and buffer it into the same
 * single `ChatCompletionResult` callers already get (no public contract
 * change — `createChatCompletionDetailed` still returns one buffered result,
 * not an async iterable).
 */
describe('callAnthropic reads SSE (translation-gy3 streaming fix)', () => {
  it('stream:true присутствует в теле запроса даже при maxTokens 16000', async () => {
    // Anthropic требует стрим выше ~16K max_tokens — порог, на котором и падал
    // живой прогон. Мы проверяем только исходящее тело, поэтому содержимое
    // ответа само по себе неважно — НО он обязан быть ПОЛНЫМ SSE-стримом
    // (anthropicOk), а не `{}`: с completeness-гейтом (translation-gy3
    // hardening) пустое тело классифицируется как incomplete_stream и
    // ретраится 3 раза РЕАЛЬНЫМИ таймерами (тут нет vi.useFakeTimers()) —
    // тест раньше проходил случайно быстро, а стал бы падать по таймауту.
    fetchMock.mockResolvedValue(anthropicOk('ok'));

    await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      maxTokens: 16000,
      fallbackPolicy: 'NONE',
    }).catch(() => undefined);

    expect(anthropicRequestBodies()[0]).toMatchObject({ stream: true, max_tokens: 16000 });
  });

  it('SSE-фреймы (message_start → content_block_delta → message_delta → message_stop) собираются в тот же результат, что раньше давал плоский JSON', async () => {
    const wholeText = 'ответ, пришедший одним content_block_delta без разбивки';
    fetchMock.mockResolvedValue(
      anthropicSseFramesResponse([
        {
          type: 'message_start',
          message: {
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            model: 'test-model',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 42,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 17,
            },
          },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: wholeText } },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 9 },
        },
        { type: 'message_stop' },
      ])
    );

    const result = await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      fallbackPolicy: 'NONE',
    });

    // rawText реконструируется байт-в-байт: ОДИН content_block_delta несёт
    // целый текст без разбивки — это то, на что смотрит wasRepaired() в
    // structured-output.ts.
    expect(result.text).toBe(wholeText);
    expect(result.rawText).toBe(wholeText);
    expect(result.attempts).toHaveLength(1);
    // message_start даёт input_tokens/cache-счётчики и НАЧАЛЬНЫЙ output_tokens
    // (0) — message_delta.usage.output_tokens (9) обязан его ЗАМЕСТИТЬ.
    expect(result.attempts[0].usage).toEqual({
      inputTokens: 42,
      outputTokens: 9,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 17,
    });
  });

  it('регрессия cost ledger: успешный стримленый вызов несёт usage — CostLedger.record() с maxTotalUsd не бросает UnverifiableCostError', async () => {
    // Ловушка: CostLedger.record() бросает UnverifiableCostError, когда
    // maxTotalUsd задан, а SUCCESS-попытка приходит БЕЗ usage. Aurora-раннер
    // всегда задаёт бюджет — значит, если стриминговый путь вернёт успешный
    // результат без usage, первый же успешный вызов ЛЮБОГО бюджетированного
    // прогона падает. Собран напрямую через anthropicSseFramesResponse (а не
    // через anthropicOk), чтобы ДО фикса тест падал по правильной причине —
    // старый response.json() не переживает SSE-тело, а не потому, что usage
    // случайно совпал с уже работавшим плоским JSON.
    fetchMock.mockResolvedValue(
      anthropicSseFramesResponse([
        {
          type: 'message_start',
          message: {
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            model: 'test-model',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 0 },
          },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 50 },
        },
        { type: 'message_stop' },
      ])
    );

    const result = await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      model: 'claude-sonnet-5', // ценённая модель — см. MODEL_PRICING в cost.ts
      fallbackPolicy: 'NONE',
    });

    const ledger = new CostLedger({ maxTotalUsd: 100 });
    expect(() => ledger.record('test-purpose', result.attempts)).not.toThrow();
  });

  it('mid-stream error-фрейм всплывает как ChatCompletionError с errorCode, а не тонет молча', async () => {
    // Существующий парсер фильтровал только content_block_delta и МОЛЧА
    // проглатывал всё остальное, включая error-фреймы — retry/fallback
    // классификация никогда их не видела. fallbackPolicy: 'NONE', чтобы
    // проверить именно классификацию ошибки, а не то, что резерв её замаскировал.
    vi.useFakeTimers();
    try {
      // overloaded_error ретраится — mockImplementation, а не mockResolvedValue:
      // каждый retry обязан получить СВЕЖИЙ Response с непрочитанным телом,
      // иначе повторное чтение того же стрима падает с ERR_INVALID_STATE, а не
      // с той ошибкой, которую тест проверяет.
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          anthropicSseFramesResponse([
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
            { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
          ])
        )
      );

      const promise = createChatCompletionDetailed({
        messages: MESSAGES,
        provider: 'anthropic',
        fallbackPolicy: 'NONE',
      });
      // Снимаем таймеры backoff'а (RETRYABLE_ERROR_CODES), прежде чем ждать
      // финальное отклонение.
      const errorPromise = promise.catch((e: unknown) => e);
      await vi.runAllTimersAsync();
      const error = (await errorPromise) as ChatCompletionError;

      expect(error).toBeInstanceOf(ChatCompletionError);
      expect(error.errorCode).toBe('overloaded_error');
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Model-migration regression: `thinking` was never set anywhere in this file
 * — omission used to mean "no extended thinking". On Claude Sonnet 5 (and
 * Claude Opus 5) omission enables ADAPTIVE thinking instead, the opposite of
 * the semantics every call site in this file was written for (structured
 * JSON extraction/audit/classification, not reasoning). Live evidence: the
 * dependency-graph-proposal stage (maxTokens: 16000) burned the entire
 * budget on thinking twice in a row — outputTokens: 16000/16000, rawText: ''
 * — surfacing a confusing SCHEMA_MISMATCH instead of an honest truncation
 * error. See the comments at the `thinking: { type: 'disabled' }` call sites
 * in chat-provider.ts for the full writeup; these tests are the RED/GREEN
 * evidence for the fix.
 */
describe('thinking: disabled — восстановление pre-Sonnet-5 семантики', () => {
  it('буферизованный путь (postAnthropicMessages) отправляет thinking: {type: "disabled"}', async () => {
    fetchMock.mockResolvedValue(anthropicOk('ok'));

    await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
    });

    expect(anthropicRequestBodies()[0]).toMatchObject({
      thinking: { type: 'disabled' },
    });
  });

  it('token-streaming путь (streamProviderTokens/buildBody) тоже отправляет thinking: {type: "disabled"}', async () => {
    fetchMock.mockResolvedValue(sseResponse(['ok']));

    const tokens: string[] = [];
    for await (const token of streamChatCompletionTokens({
      messages: MESSAGES,
      provider: 'anthropic',
    })) {
      tokens.push(token);
    }

    expect(tokens).toEqual(['ok']);
    expect(anthropicRequestBodies()[0]).toMatchObject({
      thinking: { type: 'disabled' },
    });
  });

  // Interaction check (see chat-provider.ts:997 area — temperature-deprecated
  // retry): the retry only strips `temperature` on the second attempt, it
  // must never drop `thinking`. Both raw HTTP bodies carry thinking:disabled.
  it('thinking:disabled присутствует в ОБОИХ попытках temperature-deprecated ретрая', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('temperature: deprecated for this model', { status: 400 }))
      .mockResolvedValueOnce(anthropicOk('recovered'));

    const result = await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      fallbackPolicy: 'NONE',
    });

    expect(result.text).toBe('recovered');
    const bodies = anthropicRequestBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ thinking: { type: 'disabled' }, temperature: 0.3 });
    expect(bodies[1]).toMatchObject({ thinking: { type: 'disabled' } });
    expect(bodies[1].temperature).toBeUndefined();
  });
});

/**
 * translation-gy3 hardening (2026-08-11): `callAnthropic` had no notion of a
 * COMPLETE Anthropic message, so a stream cut short by a mid-response socket
 * close (SSE has no Content-Length — a FIN mid-stream is indistinguishable
 * from a clean end) could return SUCCESS built from whatever partial state
 * happened to be collected. Worst case (Path B below): `message_start`'s
 * PROVISIONAL `usage.output_tokens` (almost always 0) satisfied the old
 * `typeof outputTokens === 'number'` guard on its own, so a stream that died
 * before `message_delta` ever arrived came back as a real SUCCESS with
 * `usage.outputTokens: 0` and — if any text had already streamed in —
 * partial text presented as the complete answer. This describe block is the
 * RED/GREEN evidence for the fix: a completeness gate in `callAnthropic` plus
 * an end-of-stream flush in `parseAnthropicSseFrames`.
 */
describe('callAnthropic completeness gate (translation-gy3 hardening)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Path A: 200 с пустым телом — ERROR, а не фиктивный SUCCESS с usage: null, и классифицируется как retryable', async () => {
    // Раньше response.json() на пустом теле падал сам по себе (ERROR) — это
    // была РЕГРЕССИЯ по сравнению со старым не-стримовым путём. С SSE-парсером
    // пустое тело — это просто ноль фреймов; без гейта цикл дал бы SUCCESS с
    // usage: null, и CostLedger.record() падал бы на UnverifiableCostError на
    // любом бюджетированном прогоне — далеко от настоящей причины.
    vi.useFakeTimers();
    // mockImplementation, а не mockResolvedValue: каждый retry обязан
    // получить СВЕЖИЙ Response — тот же самый объект на повторное чтение
    // упал бы с ERR_INVALID_STATE, а не с ошибкой, которую проверяет тест.
    fetchMock.mockImplementation(() => Promise.resolve(new Response('', { status: 200 })));

    const promise = createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      fallbackPolicy: 'NONE',
    });
    const errorPromise = promise.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const error = (await errorPromise) as ChatCompletionError;

    expect(error).toBeInstanceOf(ChatCompletionError);
    expect(error.errorCode).toBe('incomplete_stream');
    expect(error.message).toContain('no SSE frames were received');

    // retryable — доказано ДЕЙСТВИЕМ (внутренний retry-цикл реально дёргает
    // fetch ещё 3 раза тем же провайдером: MAX_RETRIES=3 → 4 попытки), а не
    // только чтением классификатора.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(error.attempts).toHaveLength(4);
    expect(
      error.attempts.every((a) => a.outcome === 'ERROR' && a.errorCode === 'incomplete_stream')
    ).toBe(true);
    // Внешняя политика (то, что читают вызывающие после полного отказа)
    // согласна с внутренней: errorCode retryable → статуса нет →
    // isRetryableChatCompletionError по умолчанию true для status===undefined.
    expect(isRetryableChatCompletionError(error)).toBe(true);
  });

  it('Path B (money bug): message_start + частичный текст, БЕЗ message_delta — ERROR, никогда не SUCCESS с partial text и outputTokens: 0', async () => {
    vi.useFakeTimers();
    const partialText = 'частичный ответ, пришедший до обрыва соединения';
    // mockImplementation — каждый retry получает свежий Response.
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        anthropicSseFramesResponse([
          {
            type: 'message_start',
            message: {
              id: 'msg_test',
              type: 'message',
              role: 'assistant',
              model: 'test-model',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              // 2500 РЕАЛЬНЫХ input-токенов уже потрачены; output_tokens: 0
              // здесь — ПРОВИЗОРНОЕ значение Anthropic (стрим только начался),
              // не финальное. Ниже никакого message_delta не будет —
              // соединение обрывается сразу после текста.
              usage: { input_tokens: 2500, output_tokens: 0 },
            },
          },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: partialText } },
          // Обрыв здесь. Ни message_delta, ни message_stop не приходят.
        ])
      )
    );

    const promise = createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      fallbackPolicy: 'NONE',
    });
    const outcomePromise = promise.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const outcome = await outcomePromise;

    // УТВЕРЖДЕНИЕ, РАДИ КОТОРОГО СУЩЕСТВУЕТ ЭТОТ ТЕСТ: до фикса именно эта
    // форма — partial text как будто это полный ответ, с outputTokens: 0 —
    // возвращалась как SUCCESS. Проверяем явно и отдельно от instanceof-теста
    // ниже, чтобы регрессия провалилась ИМЕННО на этой строке с неправильной
    // формой в diff, а не на общем «not an Error».
    expect(outcome).not.toMatchObject({
      text: partialText,
      attempts: [expect.objectContaining({ usage: { inputTokens: 2500, outputTokens: 0 } })],
    });

    expect(outcome).toBeInstanceOf(ChatCompletionError);
    const error = outcome as ChatCompletionError;
    expect(error.errorCode).toBe('incomplete_stream');
    // Ни один attempt не несёт usage вовсе — тем более не {outputTokens: 0}.
    expect(error.attempts.every((a) => a.usage === undefined)).toBe(true);
    expect(isRetryableChatCompletionError(error)).toBe(true);
  });

  it('Path C: message_start без input_tokens в usage — ERROR, не SUCCESS с usage: null', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        anthropicSseFramesResponse([
          {
            type: 'message_start',
            message: {
              id: 'msg_test',
              type: 'message',
              role: 'assistant',
              model: 'test-model',
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { output_tokens: 0 }, // input_tokens отсутствует целиком
            },
          },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 3 },
          },
          { type: 'message_stop' },
        ])
      )
    );

    const promise = createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      fallbackPolicy: 'NONE',
    });
    const errorPromise = promise.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const error = (await errorPromise) as ChatCompletionError;

    expect(error).toBeInstanceOf(ChatCompletionError);
    expect(error.errorCode).toBe('incomplete_stream');
    expect(error.message).toContain('input_tokens');
  });

  it('Path D: content_block_delta + message_delta без message_start — ERROR', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        anthropicSseFramesResponse([
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 3 },
          },
          { type: 'message_stop' },
        ])
      )
    );

    const promise = createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      fallbackPolicy: 'NONE',
    });
    const errorPromise = promise.catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const error = (await errorPromise) as ChatCompletionError;

    expect(error).toBeInstanceOf(ChatCompletionError);
    expect(error.errorCode).toBe('incomplete_stream');
    expect(error.message).toContain('message_start');
  });

  it('Path E: финальный message_delta БЕЗ завершающего \\n всё равно парсится — доказывает EOS flush', async () => {
    // Без EOS-флаша эта последняя (незавершённая \n) строка осталась бы в
    // buffer и была бы молча отброшена — Path E из ревью деградировал бы
    // обратно в Path B (message_delta потерян → outputTokens не пришёл).
    const wholeText = 'ответ, полностью пришедший до обрыва хвостового переноса строки';
    const frames = [
      {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'test-model',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 30, output_tokens: 0 },
        },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: wholeText } },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 11 },
      },
      // Обрыв здесь — message_stop так и не пришёл, а сам message_delta не
      // терминирован \n (см. построение body ниже).
    ];
    const lines = frames.map((frame) => `data: ${JSON.stringify(frame)}`);
    // Каждая строка сохраняет СВОЙ разделитель, кроме самой последней — так
    // смоделирован сокет, закрывшийся ровно на последнем байте message_delta,
    // до того как ушёл завершающий \n.
    const body = lines.slice(0, -1).map((line) => `${line}\n`).join('') + lines[lines.length - 1];
    fetchMock.mockResolvedValue(new Response(body, { status: 200 }));

    const result = await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      fallbackPolicy: 'NONE',
    });

    expect(result.text).toBe(wholeText);
    expect(result.rawText).toBe(wholeText);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].outcome).toBe('SUCCESS');
    expect(result.attempts[0].usage).toEqual({ inputTokens: 30, outputTokens: 11 });
  });

  it('regression guard: happy-path стрим (message_start → delta → message_delta → message_stop) по-прежнему даёт байт-в-байт тот же usage', async () => {
    // Гейт не должен требовать НИЧЕГО сверх того, что нормальный ответ уже
    // несёт — этот тест сгорел бы, потребуй гейт что-то лишнее (например,
    // message_stop, который сознательно не требуется — см. комментарий в
    // callAnthropic).
    fetchMock.mockResolvedValue(anthropicOk('hello', { input_tokens: 10, output_tokens: 5 }));

    const result = await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      fallbackPolicy: 'NONE',
    });

    expect(result.text).toBe('hello');
    expect(result.rawText).toBe('hello');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].outcome).toBe('SUCCESS');
    expect(result.attempts[0].usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });
});

describe('normalizeJsonResponse — проза перед JSON (thinking: disabled, 2026-08-11)', () => {
  // Точная форма реального ответа: scratchpad/aurora-v11/call-trace.jsonl,
  // последняя запись на момент бага (coverage-audit, 604 output tokens —
  // не обрыв, errorMessage в трассе: "findings: Invalid input: expected
  // array, received undefined [invalid_type]"). С выключенным `thinking`
  // (см. postAnthropicMessages) модель рассуждает вслух и по ходу
  // ЦИТИРУЕТ пример JSON (`{"all":[...]}`, в одинарных бэктиках прямо в
  // прозе), а настоящий ответ идёт только в ```json-заборе в конце.
  const REAL_COVERAGE_AUDIT_RESPONSE =
    "Смотрю на unit 4: в описании uncertainties говорится, что triggerCondition и parentExtractionRef оставлены null, но в самом JSON видно, что triggerCondition установлен на `{\"all\":[{\"fact\":\"helperPresent\",\"equals\":false}]}`, а parentExtractionRef установлен на \"b2-u3\". Это внутреннее несоответствие между полями и описанием uncertainty — сама uncertainty утверждает одно, а структура показывает другое. Также \"helperPresent\" не связано по смыслу с \"желанием продолжить\" — это придуманный trigger, не вытекающий из текста.\n\nТакже стоит проверить \"1\" — там numericConstraint unit \"секунд\" (не \"seconds\"), но так как проверка на русском, это, вероятно, приемлемо в контексте локали; сосредоточусь на структурных проблемах согласно инструкции.\n\n```json\n{\"findings\": [\n  {\"verdict\": \"UNREPRESENTED_CLAUSE\", \"quote\": \"желание продолжить не отменяет ограничение\", \"explanation\": \"Unit b2-u4 содержит противоречие: triggerCondition фактически задан как {helperPresent: false}, хотя явного основания для такого условия в тексте нет («желание продолжить» не относится к присутствию помощника), и при этом собственная uncertainty утверждает, что triggerCondition и parentExtractionRef оставлены null — что не соответствует фактическому содержанию unit. Это структурная ошибка: либо trigger придуман и должен быть удалён (оставлен null, как заявлено в uncertainty), либо uncertainty неверно описывает реальную структуру unit. В любом случае корректное представление этого утверждения (presentation-only, без придуманного trigger) отсутствует.\"}\n]}\n```";

  it('реальный обрыв: находит настоящий ответ (```json-забор), а не пример-цитату внутри рассуждения', () => {
    const result = normalizeJsonResponse(REAL_COVERAGE_AUDIT_RESPONSE);
    const parsed = JSON.parse(result) as { findings?: unknown };

    expect(parsed).not.toHaveProperty('all'); // это была бы форма примера-цитаты, не ответа
    expect(Array.isArray(parsed.findings)).toBe(true);
    expect(parsed.findings).toEqual([
      expect.objectContaining({
        verdict: 'UNREPRESENTED_CLAUSE',
        quote: 'желание продолжить не отменяет ограничение',
      }),
    ]);
  });

  it('забор в позиции 0 — прежнее поведение не изменилось', () => {
    const payload = { kind: 'PRICE', price: 100 };
    const result = normalizeJsonResponse('```json\n' + JSON.stringify(payload) + '\n```');
    expect(JSON.parse(result)).toEqual(payload);
  });

  it('без забора, чистый JSON — прежнее поведение не изменилось', () => {
    const payload = { kind: 'PRICE', price: 100 };
    const result = normalizeJsonResponse(JSON.stringify(payload));
    expect(JSON.parse(result)).toEqual(payload);
  });

  it('несколько заборов: побеждает последний, что разбирается как JSON', () => {
    const early = { role: 'example', note: 'не используй меня' };
    const real = { role: 'answer', note: 'используй меня' };
    const text =
      'Пример структуры:\n```json\n' +
      JSON.stringify(early) +
      '\n```\n\nА вот настоящий ответ:\n```json\n' +
      JSON.stringify(real) +
      '\n```';

    expect(JSON.parse(normalizeJsonResponse(text))).toEqual(real);
  });

  it('последний забор — не JSON: откатывается к более раннему валидному забору, а не к первой скобке в тексте', () => {
    const real = { role: 'answer', note: 'используй меня' };
    const text =
      '```json\n' +
      JSON.stringify(real) +
      '\n```\n\nИ ещё заметка от модели:\n```\nэто вообще не JSON, просто текст\n```';

    expect(JSON.parse(normalizeJsonResponse(text))).toEqual(real);
  });

  // Различает Fix A от Fix B: контент ПОСЛЕ настоящего забора, который сам
  // по себе тоже похож на полный JSON, не должен перебивать забор — заборы
  // разбираются ПЕРВЫМИ и целиком, раньше, чем в дело идёт сканирование
  // голых скобок по всему тексту.
  it('приоритет забора над отдельным JSON-фрагментом ПОСЛЕ него', () => {
    const real = { findings: [{ verdict: 'REAL' }] };
    const decoyAfterFence = { findings: [] };
    const text =
      'Вот ответ:\n```json\n' +
      JSON.stringify(real) +
      '\n```\n\nP.S. для сравнения раньше было бы `' +
      JSON.stringify(decoyAfterFence) +
      '` (пустой массив).';

    expect(JSON.parse(normalizeJsonResponse(text))).toEqual(real);
  });

  // Различает Fix B от старого поведения: без единого забора, прозы ДО и
  // ПОСЛЕ первого JSON-подобного фрагмента, старый код склеивал оба
  // значения в одну нераспознаваемую строку и падал в '{}' (эмпирически
  // проверено на реальной фикстуре выше — тот же механизм).
  it('без заборов вовсе, два независимых JSON-значения подряд: побеждает последнее', () => {
    const text =
      'Например, формат такой: {"example":true}. А теперь настоящий ответ: {"kind":"X","value":1}';

    expect(JSON.parse(normalizeJsonResponse(text))).toEqual({ kind: 'X', value: 1 });
  });

  it('оборванный (незакрытый) ```json-забор посреди прозы: результат всё ещё парсится (обрыв остаётся виден raw-тексту, не этой функции)', () => {
    const text = 'Рассуждаю над ответом...\n\n```json\n{"findings": [{"verdict": "UNREPRESENTED';

    // normalizeJsonResponse() сама не отвечает за детекцию обрыва — это
    // работа wasRepaired() в structured-output.ts, которая сравнивает
    // СЫРОЙ текст (несбалансированный здесь) с результатом ЭТОЙ функции.
    // Эта функция обязана лишь не бросить исключение и вернуть что-то
    // парсящееся — иначе wasRepaired() не дойдёт до сравнения балансов и
    // ответ уйдёт как INVALID_JSON, а не TRUNCATED_JSON.
    const result = normalizeJsonResponse(text);
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('проза без единого валидного JSON где-либо — как и раньше, пустой объект', () => {
    expect(normalizeJsonResponse('Извините, не могу ответить.')).toBe('{}');
  });

  it('пустой ответ — как и раньше, пустой объект', () => {
    expect(normalizeJsonResponse('   ')).toBe('{}');
  });
});

describe('JSON-only инструкция явно запрещает преамбулу и код-забор (2026-08-11)', () => {
  // «Не оборачивай в markdown» само по себе не запрещает прозу ДО/ПОСЛЕ
  // объекта — только обёртку вокруг него. С выключенным `thinking`
  // (Sonnet 5 / Opus 5, см. postAnthropicMessages) рассуждение вслух прямо
  // в ответе стало нормой, и прежней формулировки было недостаточно, чтобы
  // это явно запретить. normalizeJsonResponse остаётся обязательной сеткой
  // безопасности независимо от этой инструкции — она лишь снижает частоту.
  it('Anthropic system-инструкция явно запрещает преамбулу, объяснение и код-забор — прежний текст сохранён', async () => {
    fetchMock.mockResolvedValue(anthropicOk('{"ok":true}'));

    await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      responseFormat: 'json_object',
    });

    const system = anthropicRequestBodies()[0].system as string;
    expect(system).toContain('no preamble');
    expect(system).toContain('no code fence');
    expect(system).toContain('Respond with valid JSON only.');
    expect(system).toContain('Do not wrap in markdown or add commentary.');
  });

  it('OpenAI JSON-инструкция явно запрещает преамбулу, объяснение и код-забор — прежний текст сохранён', async () => {
    openaiCreate.mockResolvedValue(openaiOk('{"ok":true}'));

    await createChatCompletionDetailed({
      messages: [{ role: 'user', content: 'Извлеки правила из документа.' }],
      provider: 'openai',
      responseFormat: 'json_object',
    });

    const sent = openaiCreate.mock.calls[0][0].messages as { role: string; content: string }[];
    const instruction = sent[sent.length - 1].content;
    expect(instruction).toContain('no preamble');
    expect(instruction).toContain('no code fence');
    expect(instruction).toContain('Respond with valid JSON only.');
    expect(instruction).toContain('Do not wrap in markdown or add commentary.');
  });

  it('обе инструкции — Anthropic и OpenAI — используют один и тот же текст (не разошлись)', async () => {
    fetchMock.mockResolvedValue(anthropicOk('{"ok":true}'));
    openaiCreate.mockResolvedValue(openaiOk('{"ok":true}'));

    await createChatCompletionDetailed({
      messages: MESSAGES,
      provider: 'anthropic',
      responseFormat: 'json_object',
    });
    await createChatCompletionDetailed({
      messages: [{ role: 'user', content: 'Извлеки правила из документа.' }],
      provider: 'openai',
      responseFormat: 'json_object',
    });

    const anthropicSystem = anthropicRequestBodies()[0].system as string;
    const sent = openaiCreate.mock.calls[0][0].messages as { role: string; content: string }[];
    const openaiInstruction = sent[sent.length - 1].content;

    expect(anthropicSystem).toBe(openaiInstruction);
  });
});
