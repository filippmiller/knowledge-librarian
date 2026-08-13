import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const generateEmbeddingsMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/openai', () => ({
  generateEmbeddings: generateEmbeddingsMock,
  EMBEDDING_MODEL: 'text-embedding-3-small',
  EMBEDDING_DIMENSIONS: 1536,
}));

import { OpenAIEmbeddingProvider } from '../embedding-provider';

beforeEach(() => {
  generateEmbeddingsMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenAIEmbeddingProvider', () => {
  it('embed() возвращает вектора в порядке входных текстов', async () => {
    generateEmbeddingsMock.mockResolvedValue([[0.1, 0.2], [0.3, 0.4]]);

    const provider = new OpenAIEmbeddingProvider();
    const result = await provider.embed(['текст 1', 'текст 2']);

    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(generateEmbeddingsMock).toHaveBeenCalledWith(['текст 1', 'текст 2'], undefined, expect.any(Function));
  });

  it('modelInfo() отдаёт provider/model/dimensions — нужно для воспроизводимости артефакта (acceptance criterion PR G)', () => {
    const provider = new OpenAIEmbeddingProvider();
    const info = provider.modelInfo();
    expect(info.provider).toBe('openai');
    expect(info.model).toBe('text-embedding-3-small');
    expect(info.dimensions).toBe(1536);
  });

  it('пустой массив текстов — не зовёт API, возвращает пустой массив', async () => {
    const provider = new OpenAIEmbeddingProvider();
    const result = await provider.embed([]);
    expect(result).toEqual([]);
    expect(generateEmbeddingsMock).not.toHaveBeenCalled();
  });

  it('ceiling=1 blocks the second embedding request before generateEmbeddings()', async () => {
    generateEmbeddingsMock.mockResolvedValue([[0.1, 0.2]]);
    let reservations = 0;
    const provider = new OpenAIEmbeddingProvider(() => {
      if (reservations >= 1) throw new Error('paid-call ceiling');
      reservations += 1;
    });

    await provider.embed(['corpus']);
    await expect(provider.embed(['query'])).rejects.toThrow('paid-call ceiling');

    expect(generateEmbeddingsMock).toHaveBeenCalledTimes(1);
    expect(generateEmbeddingsMock).toHaveBeenCalledWith(['corpus'], { maxRetries: 0 }, expect.any(Function));
    expect(reservations).toBe(1);
  });

  it('reports exact embedding token usage as a priced completion attempt', async () => {
    generateEmbeddingsMock.mockImplementation(async (_texts, _options, onUsage) => {
      onUsage({ inputTokens: 321, outputTokens: 0 });
      return [[0.1, 0.2]];
    });
    const attempts: unknown[] = [];
    const provider = new OpenAIEmbeddingProvider(undefined, (attempt) => attempts.push(attempt));

    await provider.embed(['priced corpus']);

    expect(attempts).toEqual([
      expect.objectContaining({
        provider: 'openai', model: 'text-embedding-3-small', outcome: 'SUCCESS',
        usage: { inputTokens: 321, outputTokens: 0 },
      }),
    ]);
  });

  it('retries terminated transport locally and succeeds on the third raw attempt', async () => {
    generateEmbeddingsMock
      .mockRejectedValueOnce(new Error('terminated'))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockImplementationOnce(async (_texts, _options, onUsage) => {
        onUsage({ inputTokens: 9, outputTokens: 0 });
        return [[0.3]];
      });
    let reservations = 0;
    const attempts: Array<{ outcome: string }> = [];
    const provider = new OpenAIEmbeddingProvider(
      () => { reservations += 1; },
      (attempt) => attempts.push(attempt)
    );

    await expect(provider.embed(['query'])).resolves.toEqual([[0.3]]);
    expect(reservations).toBe(3);
    expect(generateEmbeddingsMock).toHaveBeenCalledTimes(3);
    expect(attempts.map((attempt) => attempt.outcome)).toEqual(['ERROR', 'ERROR', 'SUCCESS']);
  });

  it('does not retry permanent HTTP 400', async () => {
    generateEmbeddingsMock.mockRejectedValue(Object.assign(new Error('bad request'), { status: 400 }));
    let reservations = 0;
    const attempts: Array<{ outcome: string; statusCode?: number }> = [];
    const provider = new OpenAIEmbeddingProvider(
      () => { reservations += 1; },
      (attempt) => attempts.push(attempt)
    );

    await expect(provider.embed(['query'])).rejects.toThrow('bad request');
    expect(reservations).toBe(1);
    expect(generateEmbeddingsMock).toHaveBeenCalledTimes(1);
    expect(attempts).toEqual([expect.objectContaining({ outcome: 'ERROR', statusCode: 400 })]);
  });

  it('does not misclassify or repeat a paid success when the accounting ceiling throws', async () => {
    generateEmbeddingsMock.mockImplementation(async (_texts, _options, onUsage) => {
      onUsage({ inputTokens: 9, outputTokens: 0 });
      return [[0.3]];
    });
    let reservations = 0;
    const outcomes: string[] = [];
    const ceiling = new Error('cost ceiling');
    const provider = new OpenAIEmbeddingProvider(
      () => { reservations += 1; },
      (attempt) => { outcomes.push(attempt.outcome); throw ceiling; }
    );

    await expect(provider.embed(['query'])).rejects.toBe(ceiling);
    expect(reservations).toBe(1);
    expect(generateEmbeddingsMock).toHaveBeenCalledTimes(1);
    expect(outcomes).toEqual(['SUCCESS']);
  });
});
