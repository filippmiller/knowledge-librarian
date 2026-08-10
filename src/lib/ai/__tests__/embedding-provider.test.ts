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
    expect(generateEmbeddingsMock).toHaveBeenCalledWith(['текст 1', 'текст 2'], undefined);
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
    expect(generateEmbeddingsMock).toHaveBeenCalledWith(['corpus'], { maxRetries: 0 });
    expect(reservations).toBe(1);
  });
});
