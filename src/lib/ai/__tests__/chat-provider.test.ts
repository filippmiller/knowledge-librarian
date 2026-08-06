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
  resolveFallbackPolicy,
  resolveRunConfig,
  streamChatCompletionTokens,
  type ChatCompletionOptions,
} from '../chat-provider';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MESSAGES: ChatCompletionOptions['messages'] = [
  { role: 'user', content: 'hi' },
];

let fetchMock: ReturnType<typeof vi.fn>;

function anthropicOk(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), {
    status: 200,
  });
}

/** 500 не входит в RETRYABLE_STATUS_CODES — фоллбэк начинается сразу, без sleep. */
function anthropicFailure(status = 500, body = 'anthropic is down'): Response {
  return new Response(body, { status });
}

function openaiOk(text: string) {
  return { choices: [{ message: { content: text } }] };
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
          delta: { text },
        })}\n`
    )
    .join('');
}

function sseResponse(texts: string[]): Response {
  const body = sseEvents(texts) + 'data: [DONE]\n';
  return new Response(new TextEncoder().encode(body), { status: 200 });
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
