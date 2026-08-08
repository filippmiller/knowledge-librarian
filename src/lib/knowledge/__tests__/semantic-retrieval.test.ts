import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '@/lib/ai/embedding-provider';
import type { RankedCandidate, RerankCandidate, RerankerProvider } from '@/lib/ai/reranker-provider';
import { embedCandidates, retrieveUnits, type EmbeddingProvider } from '../semantic-retrieval';

/**
 * PR G acceptance criteria: recall@5 после reranking; recall@K ДО reranking
 * измеряется отдельно (видно, что чинить); trace показывает lexical/vector/
 * RRF/reranker ранги отдельно для каждого кандидата.
 */

/** Фейковый embedding: вектор из совпадений слов запроса с текстом кандидата
 *  — детерминированно, без сети, но ведёт себя как реальный cosine по смыслу
 *  для целей теста ранжирования. */
class FakeEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const lower = t.toLowerCase();
      // 3-мерный вектор: [упоминает "апостиль", упоминает "перевод", длина/100]
      return [
        lower.includes('апостиль') ? 1 : 0,
        lower.includes('перевод') ? 1 : 0,
        lower.length / 100,
      ];
    });
  }
  modelInfo(): ModelInfo {
    return { provider: 'fake', model: 'fake-embed-v1', dimensions: 3 };
  }
}

class FakeRerankerProvider implements RerankerProvider {
  constructor(private readonly scoresById: Record<string, number>) {}
  async rerank(
    _query: string,
    candidates: readonly RerankCandidate[]
  ): Promise<RankedCandidate[]> {
    return candidates
      .map((c) => ({ id: c.id, score: this.scoresById[c.id] ?? 0 }))
      .sort((a, b) => b.score - a.score);
  }
  modelInfo(): ModelInfo {
    return { provider: 'fake', model: 'fake-rerank-v1' };
  }
}

const CANDIDATES = [
  { unitId: 'apostille-1', retrievalText: 'Апостиль ставится в течение 5 рабочих дней' },
  { unitId: 'translation-1', retrievalText: 'Перевод паспорта требует нотариального заверения' },
  { unitId: 'unrelated-1', retrievalText: 'Часы работы офиса с 9 до 18' },
];

describe('embedCandidates', () => {
  it('вычисляет embedding для каждого кандидата, сохраняя unitId/retrievalText', async () => {
    const embedded = await embedCandidates(CANDIDATES, new FakeEmbeddingProvider());
    expect(embedded).toHaveLength(3);
    expect(embedded[0]).toMatchObject({ unitId: 'apostille-1', retrievalText: CANDIDATES[0].retrievalText });
    expect(embedded[0].embedding).toEqual([1, 0, expect.any(Number)]);
  });

  it('пустой список кандидатов — не зовёт провайдер, пустой результат', async () => {
    let called = false;
    const provider: EmbeddingProvider = {
      async embed(texts) {
        called = true;
        return texts.map(() => [0, 0, 0]);
      },
      modelInfo: () => ({ provider: 'fake', model: 'fake' }),
    };
    expect(await embedCandidates([], provider)).toEqual([]);
    expect(called).toBe(false);
  });
});

describe('retrieveUnits — оркестрация lexical + semantic + RRF + reranker', () => {
  it('находит релевантного кандидата по смыслу (semantic), даже если lexical промахнулся', async () => {
    const embedded = await embedCandidates(CANDIDATES, new FakeEmbeddingProvider());
    const result = await retrieveUnits('когда будет готов апостиль', embedded, {
      embeddingProvider: new FakeEmbeddingProvider(),
      rerankerProvider: new FakeRerankerProvider({ 'apostille-1': 0.9, 'translation-1': 0.1, 'unrelated-1': 0.0 }),
    });

    expect(result.topK[0]).toBe('apostille-1');
  });

  it('trace несёт lexical/vector/RRF/reranker ранг отдельно для каждого кандидата (acceptance criterion)', async () => {
    const embedded = await embedCandidates(CANDIDATES, new FakeEmbeddingProvider());
    const result = await retrieveUnits('апостиль', embedded, {
      embeddingProvider: new FakeEmbeddingProvider(),
      rerankerProvider: new FakeRerankerProvider({ 'apostille-1': 0.9 }),
    });

    const traceEntry = result.trace.find((t) => t.unitId === 'apostille-1')!;
    expect(traceEntry).toHaveProperty('lexicalRank');
    expect(traceEntry).toHaveProperty('vectorRank');
    expect(traceEntry).toHaveProperty('rrfRank');
    expect(traceEntry).toHaveProperty('rerankerRank');
  });

  it('кандидат, отсутствующий в lexical-результатах, всё равно несёт запись в trace (lexicalRank: null)', async () => {
    const embedded = await embedCandidates(CANDIDATES, new FakeEmbeddingProvider());
    const result = await retrieveUnits('апостиль', embedded, {
      embeddingProvider: new FakeEmbeddingProvider(),
      rerankerProvider: new FakeRerankerProvider({}),
    });
    const unrelated = result.trace.find((t) => t.unitId === 'unrelated-1');
    expect(unrelated?.lexicalRank).toBeNull();
  });

  it('артефакт хранит embedding/reranker modelInfo и RRF k — воспроизводимость (acceptance criterion)', async () => {
    const embedded = await embedCandidates(CANDIDATES, new FakeEmbeddingProvider());
    const result = await retrieveUnits('апостиль', embedded, {
      embeddingProvider: new FakeEmbeddingProvider(),
      rerankerProvider: new FakeRerankerProvider({}),
    });
    expect(result.artifact.embeddingModel).toEqual({ provider: 'fake', model: 'fake-embed-v1', dimensions: 3 });
    expect(result.artifact.rerankerModel).toEqual({ provider: 'fake', model: 'fake-rerank-v1' });
    expect(result.artifact.rrfK).toBeGreaterThan(0);
  });

  it('recallCandidates (до reranking) отдаётся отдельно от topK (после reranking) — видно, что чинить', async () => {
    const embedded = await embedCandidates(CANDIDATES, new FakeEmbeddingProvider());
    const result = await retrieveUnits('апостиль', embedded, {
      embeddingProvider: new FakeEmbeddingProvider(),
      // Реранкер намеренно переставляет порядок — сравниваем с candidatesBeforeRerank.
      rerankerProvider: new FakeRerankerProvider({ 'translation-1': 1.0 }),
    });
    expect(result.candidatesBeforeRerank.length).toBeGreaterThan(0);
    expect(result.topK[0]).toBe('translation-1'); // после reranking порядок другой
  });

  it('пустой candidate pool — не падает, пустой результат', async () => {
    const result = await retrieveUnits('апостиль', [], {
      embeddingProvider: new FakeEmbeddingProvider(),
      rerankerProvider: new FakeRerankerProvider({}),
    });
    expect(result.topK).toEqual([]);
  });

  it('провайдер эмбеддингов вернул пустой/короткий батч для запроса — явная ошибка, не тихая порча ранжирования (находка ревью этого PR)', async () => {
    const embedded = await embedCandidates(CANDIDATES, new FakeEmbeddingProvider());
    const brokenProvider: EmbeddingProvider = {
      async embed() {
        return []; // должен был вернуть 1 вектор на 1 текст запроса
      },
      modelInfo: () => ({ provider: 'fake', model: 'fake-broken' }),
    };

    await expect(
      retrieveUnits('апостиль', embedded, {
        embeddingProvider: brokenProvider,
        rerankerProvider: new FakeRerankerProvider({}),
      })
    ).rejects.toThrow(/embed/i);
  });

  it.each([
    ['rerankPoolSize', -1],
    ['rerankPoolSize', NaN],
    ['finalLimit', -5],
    ['finalLimit', NaN],
    ['rrfK', -60],
  ])('невалидная числовая опция %s=%j отвергается явно, не тихим неверным срезом (находка ревью: JS slice-коэрсия)', async (key, value) => {
    const embedded = await embedCandidates(CANDIDATES, new FakeEmbeddingProvider());
    await expect(
      retrieveUnits('апостиль', embedded, {
        embeddingProvider: new FakeEmbeddingProvider(),
        rerankerProvider: new FakeRerankerProvider({}),
        [key]: value,
      })
    ).rejects.toThrow();
  });
});
