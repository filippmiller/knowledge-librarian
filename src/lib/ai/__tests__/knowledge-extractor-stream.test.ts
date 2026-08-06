import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createChatCompletionDetailedMock = vi.hoisted(() => vi.fn());
const createChatCompletionStreamDetailedMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/openai', () => ({
  openai: { chat: { completions: { create: vi.fn() } } },
  CHAT_MODEL: 'gpt-4o',
}));

const ruleFindMany = vi.hoisted(() => vi.fn());
const ruleCreate = vi.hoisted(() => vi.fn());
const stagedCreate = vi.hoisted(() => vi.fn());
const prismaMock = vi.hoisted(() => ({
  rule: { findMany: ruleFindMany, create: ruleCreate },
  stagedExtraction: { create: stagedCreate },
}));

vi.mock('@/lib/db', () => ({ default: prismaMock, prisma: prismaMock }));

// Частичный мок: подменяются ТОЛЬКО два вызывающих провайдера метода, а
// resolveRunConfig/getProvider/normalizeJsonResponse остаются настоящими —
// иначе тест проверял бы собственный резолвер, а не боевой.
vi.mock('@/lib/ai/chat-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../chat-provider')>()),
  createChatCompletionDetailed: createChatCompletionDetailedMock,
  createChatCompletionStreamDetailed: createChatCompletionStreamDetailedMock,
}));

import type {
  ChatCompletionOptions,
  ChatCompletionResult,
  CompletionAttempt,
  Provider,
} from '../chat-provider';
import {
  computeModelRelationship,
  computeRunModelConsistency,
  EXTRACTION_PROMPT_VERSION,
  summarizeRunModels,
  type LlmCallRecord,
} from '../extraction-run';
import {
  streamKnowledgeExtraction,
  type KnowledgeExtractionStreamEvent,
  type KnowledgeExtractionStreamResult,
} from '../knowledge-extractor-stream';

const VALID_JSON = JSON.stringify({
  rules: [
    {
      ruleCode: 'R-1',
      title: 'Тестовое правило про срок',
      body: 'Срок апостиля — 5 рабочих дней.',
      confidence: 0.95,
      sourceSpan: { quote: 'срок апостиля 5 рабочих дней', locationHint: 'раздел 1' },
    },
  ],
  qaPairs: [],
  uncertainties: [],
});

const UNPARSEABLE = 'Извините, JSON выдать не могу.';

/**
 * Модель, которую якобы «не существует»: если какой-то вызов уйдёт на дефолт
 * провайдера вместо закреплённой модели, это имя попадёт в артефакт и тест
 * это увидит.
 */
const PROVIDER_DEFAULT_SENTINEL = 'ANTHROPIC_ENV_DEFAULT_MODEL';

function attempt(provider: Provider, model: string): CompletionAttempt {
  return {
    provider,
    model,
    startedAt: '2026-08-06T00:00:00.000Z',
    latencyMs: 1,
    outcome: 'SUCCESS',
  };
}

/** Стрим, который отдаёт текст и сообщает, кто фактически ответил. */
function streamOperation(
  text: string,
  servedBy: { provider: Provider; model: string; fallbackUsed?: boolean },
  onDispose?: () => void
) {
  const result: ChatCompletionResult = {
    text,
    servedByProvider: servedBy.provider,
    servedByModel: servedBy.model,
    fallbackUsed: servedBy.fallbackUsed ?? false,
    attempts: [attempt(servedBy.provider, servedBy.model)],
  };
  return {
    tokens: (async function* () {
      try {
        yield text;
      } finally {
        onDispose?.();
      }
    })(),
    completion: Promise.resolve(result),
  };
}

/**
 * Не-стриминговый вызов, ЭХОМ повторяющий запрошенные provider/model. Именно
 * это ловит P0: если retry уйдёт без `model`, «фактическая» модель окажется
 * дефолтом провайдера, а не закреплённой.
 */
function echoDetailed(text: string) {
  return async (options: ChatCompletionOptions): Promise<ChatCompletionResult> => {
    const provider: Provider = options.provider ?? 'anthropic';
    const model = options.model ?? PROVIDER_DEFAULT_SENTINEL;
    return {
      text,
      servedByProvider: provider,
      servedByModel: model,
      fallbackUsed: false,
      attempts: [attempt(provider, model)],
    };
  };
}

async function collect(
  documentText: string
): Promise<{
  events: KnowledgeExtractionStreamEvent[];
  calls: LlmCallRecord[];
  result: KnowledgeExtractionStreamResult | null;
}> {
  const events: KnowledgeExtractionStreamEvent[] = [];
  let result: KnowledgeExtractionStreamResult | null = null;
  for await (const event of streamKnowledgeExtraction(documentText, [])) {
    events.push(event);
    if (event.type === 'result') result = event.data;
  }
  return {
    events,
    calls: events.flatMap((event) => (event.type === 'llm_call' ? [event.data] : [])),
    result,
  };
}

function streamCallOptions(index = 0): ChatCompletionOptions {
  return createChatCompletionStreamDetailedMock.mock.calls[index][0] as ChatCompletionOptions;
}

function detailedCallOptions(index = 0): ChatCompletionOptions {
  return createChatCompletionDetailedMock.mock.calls[index][0] as ChatCompletionOptions;
}

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
  vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
  vi.stubEnv('AI_PROVIDER', 'anthropic');
  vi.stubEnv('ANTHROPIC_MODEL', PROVIDER_DEFAULT_SENTINEL);
  vi.stubEnv('OPENAI_CHAT_MODEL', 'gpt-env-default');
  vi.stubEnv('EXTRACTION_MODEL', '');

  createChatCompletionDetailedMock.mockReset();
  createChatCompletionStreamDetailedMock.mockReset();

  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('единый ExtractionRunConfig на primary и retry', () => {
  it('закреплённая EXTRACTION_MODEL доезжает до retry, а не подменяется дефолтом провайдера', async () => {
    vi.stubEnv('EXTRACTION_MODEL', 'claude-pinned-extractor');
    createChatCompletionStreamDetailedMock.mockImplementation(() =>
      streamOperation(UNPARSEABLE, { provider: 'anthropic', model: 'claude-pinned-extractor' })
    );
    createChatCompletionDetailedMock.mockImplementation(echoDetailed(VALID_JSON));

    const { calls, result } = await collect('Короткий документ про апостиль.');

    expect(createChatCompletionDetailedMock).toHaveBeenCalledTimes(1);
    // Это и есть P0: раньше здесь не было ни `model`, ни провайдера.
    expect(detailedCallOptions()).toMatchObject({
      provider: 'anthropic',
      model: 'claude-pinned-extractor',
      promptVersion: EXTRACTION_PROMPT_VERSION,
      fallbackPolicy: 'NONE',
    });
    expect(detailedCallOptions().model).not.toBe(PROVIDER_DEFAULT_SENTINEL);

    const retry = calls.find((call) => call.role === 'EXTRACTION_RETRY');
    expect(retry?.servedByModel).toBe('claude-pinned-extractor');
    expect(result?.rules).toHaveLength(1);
  });

  it('primary и retry получают ОДИН И ТОТ ЖЕ набор маршрутизирующих полей', async () => {
    vi.stubEnv('EXTRACTION_MODEL', 'claude-pinned-extractor');
    createChatCompletionStreamDetailedMock.mockImplementation(() =>
      streamOperation(UNPARSEABLE, { provider: 'anthropic', model: 'claude-pinned-extractor' })
    );
    createChatCompletionDetailedMock.mockImplementation(echoDetailed(VALID_JSON));

    await collect('Короткий документ про апостиль.');

    const primary = streamCallOptions();
    const retry = detailedCallOptions();
    for (const field of ['provider', 'model', 'promptVersion', 'fallbackPolicy'] as const) {
      expect(retry[field]).toBe(primary[field]);
    }
  });

  it('без EXTRACTION_MODEL обе стороны едут на одной разрезолвленной модели провайдера', async () => {
    createChatCompletionStreamDetailedMock.mockImplementation(() =>
      streamOperation(UNPARSEABLE, { provider: 'anthropic', model: PROVIDER_DEFAULT_SENTINEL })
    );
    createChatCompletionDetailedMock.mockImplementation(echoDetailed(VALID_JSON));

    const { calls } = await collect('Короткий документ про апостиль.');

    expect(streamCallOptions().model).toBe(PROVIDER_DEFAULT_SENTINEL);
    expect(detailedCallOptions().model).toBe(PROVIDER_DEFAULT_SENTINEL);
    expect(computeRunModelConsistency(calls)).toBe('CONSISTENT');
  });
});

describe('журнал вызовов прогона', () => {
  it('пишет фактическую модель каждого батча, включая retry', async () => {
    vi.stubEnv('EXTRACTION_MODEL', 'claude-pinned-extractor');
    // 6000 символов → ровно два батча (BATCH_SIZE 4500, overlap 600).
    const document = 'Правило про апостиль и сроки. '.repeat(200);
    expect(document.length).toBeGreaterThan(4500);

    let streamCall = 0;
    createChatCompletionStreamDetailedMock.mockImplementation(() => {
      streamCall++;
      // Первый батч распарсится сразу, второй уйдёт в retry.
      return streamOperation(streamCall === 1 ? VALID_JSON : UNPARSEABLE, {
        provider: 'anthropic',
        model: 'claude-pinned-extractor',
      });
    });
    createChatCompletionDetailedMock.mockImplementation(echoDetailed(VALID_JSON));

    const { calls } = await collect(document);

    expect(calls.map((call) => `${call.role}#${call.batchIndex}`)).toEqual([
      'EXTRACTION_PRIMARY#1',
      'EXTRACTION_PRIMARY#2',
      'EXTRACTION_RETRY#2',
    ]);
    for (const call of calls) {
      expect(call.outcome).toBe('SUCCESS');
      expect(call.servedByProvider).toBe('anthropic');
      expect(call.servedByModel).toBe('claude-pinned-extractor');
      expect(call.promptVersion).toBe(EXTRACTION_PROMPT_VERSION);
      expect(call.attempts).toHaveLength(1);
      expect(call.sourceHash).toMatch(/^[0-9a-f]{16}$/);
    }
    // Батчи режут РАЗНЫЕ куски документа — хэши обязаны различаться.
    expect(calls[0].sourceHash).not.toBe(calls[1].sourceHash);
    // Retry относится к тому же тексту, что и его primary.
    expect(calls[2].sourceHash).toBe(calls[1].sourceHash);
  });

  it('прогон, где retry обслужен другой моделью, помечается MIXED', async () => {
    vi.stubEnv('EXTRACTION_MODEL', 'claude-pinned-extractor');
    createChatCompletionStreamDetailedMock.mockImplementation(() =>
      streamOperation(UNPARSEABLE, { provider: 'anthropic', model: 'claude-pinned-extractor' })
    );
    // Резерв сработал и ответил другой вендор — артефакт обязан это показать.
    createChatCompletionDetailedMock.mockResolvedValue({
      text: VALID_JSON,
      servedByProvider: 'openai',
      servedByModel: 'gpt-4o',
      fallbackUsed: true,
      attempts: [attempt('openai', 'gpt-4o')],
    } satisfies ChatCompletionResult);

    const { calls } = await collect('Короткий документ про апостиль.');

    expect(computeRunModelConsistency(calls)).toBe('MIXED');
    expect(
      computeModelRelationship(calls, [
        {
          ...calls[0],
          role: 'GRADER',
          batchIndex: null,
          servedByProvider: 'openai',
          servedByModel: 'gpt-4o',
        },
      ])
    ).toBe('MIXED');
    expect(calls.find((call) => call.role === 'EXTRACTION_RETRY')?.fallbackUsed).toBe(true);
  });

  it('упавший retry всё равно попадает в журнал — прогон не выглядит однородным задним числом', async () => {
    vi.stubEnv('EXTRACTION_MODEL', 'claude-pinned-extractor');
    createChatCompletionStreamDetailedMock.mockImplementation(() =>
      streamOperation(UNPARSEABLE, { provider: 'anthropic', model: 'claude-pinned-extractor' })
    );
    createChatCompletionDetailedMock.mockRejectedValue(new Error('провайдер лежит'));

    const { calls, events, result } = await collect('Короткий документ про апостиль.');

    const retry = calls.find((call) => call.role === 'EXTRACTION_RETRY');
    expect(retry).toBeDefined();
    expect(retry?.outcome).toBe('FAILED');
    expect(retry?.servedByModel).toBeNull();
    expect(retry?.requestedModel).toBe('claude-pinned-extractor');
    // Батч пропускается, документ не падает целиком — поведение как до PR.
    expect(events.some((event) => event.type === 'batch_skipped')).toBe(true);
    expect(result?.rules).toHaveLength(0);
  });

  it('сбой стрима регистрируется до того, как ошибка вылетит наружу', async () => {
    createChatCompletionStreamDetailedMock.mockImplementation(() => ({
      tokens: (async function* () {
        throw new Error('stream died');
        // eslint-disable-next-line no-unreachable
        yield '';
      })(),
      completion: Promise.resolve({
        text: '',
        servedByProvider: 'anthropic' as const,
        servedByModel: PROVIDER_DEFAULT_SENTINEL,
        fallbackUsed: false,
        attempts: [],
      }),
    }));

    const seen: LlmCallRecord[] = [];
    await expect(
      (async () => {
        for await (const event of streamKnowledgeExtraction('Короткий документ.', [])) {
          if (event.type === 'llm_call') seen.push(event.data);
        }
      })()
    ).rejects.toThrow('stream died');

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ role: 'EXTRACTION_PRIMARY', outcome: 'FAILED' });
  });
});

describe('фикстурный прогон: артефакт есть, знания не публикуются', () => {
  it('собирает сводку по фактическим моделям и не трогает БД', async () => {
    vi.stubEnv('EXTRACTION_MODEL', 'claude-pinned-extractor');
    createChatCompletionStreamDetailedMock.mockImplementation(() =>
      streamOperation(UNPARSEABLE, { provider: 'anthropic', model: 'claude-pinned-extractor' })
    );
    createChatCompletionDetailedMock.mockImplementation(echoDetailed(VALID_JSON));

    const { calls, result } = await collect('Фикстурный документ про апостиль.');

    // Судья на другом вендоре — единственный случай, дающий INDEPENDENT.
    const graderCalls: LlmCallRecord[] = [
      {
        ...calls[0],
        role: 'GRADER',
        batchIndex: null,
        label: 'Q01/usability_all',
        requestedProvider: 'openai',
        requestedModel: 'gpt-4o',
        servedByProvider: 'openai',
        servedByModel: 'gpt-4o',
      },
    ];
    const summary = summarizeRunModels(calls, graderCalls);

    expect(summary.extraction).toMatchObject({
      calls: 2,
      modelConsistency: 'CONSISTENT',
      servedIdentities: [{ provider: 'anthropic', model: 'claude-pinned-extractor' }],
    });
    expect(summary.relationship).toBe('DIFFERENT_PROVIDER');
    expect(summary.independence).toBe('INDEPENDENT');
    expect(summary.statement).toContain('ModelRelationship=DIFFERENT_PROVIDER');

    // Артефакт получен, правила извлечены — и при этом ни одной записи в БД:
    // прогон ничего не публикует в базу знаний.
    expect(result?.rules).toHaveLength(1);
    expect(ruleCreate).not.toHaveBeenCalled();
    expect(stagedCreate).not.toHaveBeenCalled();
    expect(ruleFindMany).not.toHaveBeenCalled();
  });
});

describe('потребление стрима', () => {
  it('ранний выход потребителя закрывает стрим провайдера, а не бросает его висеть', async () => {
    let disposed = false;
    createChatCompletionStreamDetailedMock.mockImplementation(() =>
      streamOperation(
        VALID_JSON,
        { provider: 'anthropic', model: PROVIDER_DEFAULT_SENTINEL },
        () => {
          disposed = true;
        }
      )
    );

    for await (const event of streamKnowledgeExtraction('Короткий документ.', [])) {
      if (event.type === 'token') break;
    }

    expect(disposed).toBe(true);
  });

  it('при нормальном проходе стрим тоже вычитывается до конца', async () => {
    let disposed = false;
    createChatCompletionStreamDetailedMock.mockImplementation(() =>
      streamOperation(
        VALID_JSON,
        { provider: 'anthropic', model: PROVIDER_DEFAULT_SENTINEL },
        () => {
          disposed = true;
        }
      )
    );

    const { result } = await collect('Короткий документ.');

    expect(disposed).toBe(true);
    expect(result?.rules).toHaveLength(1);
    expect(createChatCompletionDetailedMock).not.toHaveBeenCalled();
  });
});
