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

/** Вторая модель эмбеддингов — тот же провайдер, ДРУГАЯ модель/размерность.
 *  Нужна, чтобы доказать, что identity считается по provider:model, а не по
 *  dimensions (translation-kis: "same-dimension но другая модель — тоже reject"). */
class OtherFakeEmbeddingProvider implements EmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1, 1, 1, 1]);
  }
  modelInfo(): ModelInfo {
    return { provider: 'fake', model: 'fake-embed-v2', dimensions: 4 };
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

describe('embedCandidates — cardinality и provenance (translation-kis)', () => {
  it('provider вернул МЕНЬШЕ векторов, чем кандидатов — явная ошибка, не тихий undefined в embedding', async () => {
    const shortProvider: EmbeddingProvider = {
      async embed(texts) {
        return texts.slice(0, -1).map(() => [0, 0, 0]);
      },
      modelInfo: () => ({ provider: 'fake', model: 'fake-short' }),
    };
    await expect(embedCandidates(CANDIDATES, shortProvider)).rejects.toThrow(/векторов/i);
  });

  it('provider вернул БОЛЬШЕ векторов, чем кандидатов — тоже явная ошибка', async () => {
    const longProvider: EmbeddingProvider = {
      async embed(texts) {
        return [...texts, 'extra'].map(() => [0, 0, 0]);
      },
      modelInfo: () => ({ provider: 'fake', model: 'fake-long' }),
    };
    await expect(embedCandidates(CANDIDATES, longProvider)).rejects.toThrow(/векторов/i);
  });

  it('каждый EmbeddedCandidate несёт embeddingModel провайдера, который его посчитал', async () => {
    const embedded = await embedCandidates(CANDIDATES, new FakeEmbeddingProvider());
    expect(embedded[0].embeddingModel).toEqual({ provider: 'fake', model: 'fake-embed-v1', dimensions: 3 });
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

  it('артефакт хранит corpus/query embedding modelInfo и reranker modelInfo и RRF k — воспроизводимость (acceptance criterion)', async () => {
    const embedded = await embedCandidates(CANDIDATES, new FakeEmbeddingProvider());
    const result = await retrieveUnits('апостиль', embedded, {
      embeddingProvider: new FakeEmbeddingProvider(),
      rerankerProvider: new FakeRerankerProvider({}),
    });
    expect(result.artifact.corpusEmbeddingModel).toEqual({ provider: 'fake', model: 'fake-embed-v1', dimensions: 3 });
    expect(result.artifact.queryEmbeddingModel).toEqual({ provider: 'fake', model: 'fake-embed-v1', dimensions: 3 });
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

  it('score band сохраняет Q09-подобную обязательную клаузу rank 8 со score .40 при best .90', async () => {
    const candidates = Array.from({ length: 9 }, (_, index) => ({
      unitId: `u${index + 1}`,
      retrievalText: `кандидат ${index + 1}`,
    }));
    const embedded = await embedCandidates(candidates, new FakeEmbeddingProvider());
    const result = await retrieveUnits('вопрос', embedded, {
      embeddingProvider: new FakeEmbeddingProvider(),
      rerankerProvider: new FakeRerankerProvider({
        u1: 0.9, u2: 0.85, u3: 0.75, u4: 0.6, u5: 0.55,
        u6: 0.55, u7: 0.5, u8: 0.4, u9: 0.2,
      }),
      finalLimit: 5,
      rerankPoolSize: 9,
    });

    expect(result.topK).toEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8']);
  });

  it('score band отсекает Q06-подобный шум .10 при best 1.0, включая низкий tie', async () => {
    const candidates = Array.from({ length: 6 }, (_, index) => ({
      unitId: `noise-${index + 1}`,
      retrievalText: `кандидат ${index + 1}`,
    }));
    const embedded = await embedCandidates(candidates, new FakeEmbeddingProvider());
    const result = await retrieveUnits('вопрос', embedded, {
      embeddingProvider: new FakeEmbeddingProvider(),
      rerankerProvider: new FakeRerankerProvider({
        'noise-1': 1, 'noise-2': 0.2, 'noise-3': 0.1,
        'noise-4': 0.1, 'noise-5': 0.1, 'noise-6': 0.1,
      }),
    });

    expect(result.topK).toEqual(['noise-1']);
  });

  it('score band сохраняет Q05-N1-подобный rule score .60 при best 1.0', async () => {
    const embedded = await embedCandidates(CANDIDATES, new FakeEmbeddingProvider());
    const result = await retrieveUnits('вопрос', embedded, {
      embeddingProvider: new FakeEmbeddingProvider(),
      rerankerProvider: new FakeRerankerProvider({
        'apostille-1': 1,
        'translation-1': 0.6,
        'unrelated-1': 0.2,
      }),
    });

    expect(result.topK).toEqual(['apostille-1', 'translation-1']);
  });

  it('all-low pool ниже абсолютного floor возвращает пустой результат', async () => {
    const embedded = await embedCandidates(CANDIDATES, new FakeEmbeddingProvider());
    const result = await retrieveUnits('вопрос', embedded, {
      embeddingProvider: new FakeEmbeddingProvider(),
      rerankerProvider: new FakeRerankerProvider({
        'apostille-1': 0.2,
        'translation-1': 0.15,
        'unrelated-1': 0.1,
      }),
    });

    expect(result.topK).toEqual([]);
  });

  it('score-band expansion ограничен rerank pool даже когда все кандидаты проходят floor', async () => {
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      unitId: `tie-${index + 1}`,
      retrievalText: `равный кандидат ${index + 1}`,
    }));
    const scores = Object.fromEntries(candidates.map((candidate) => [candidate.unitId, 0.5]));
    const embedded = await embedCandidates(candidates, new FakeEmbeddingProvider());
    const result = await retrieveUnits('вопрос', embedded, {
      embeddingProvider: new FakeEmbeddingProvider(),
      rerankerProvider: new FakeRerankerProvider(scores),
      finalLimit: 5,
      rerankPoolSize: 7,
    });

    expect(result.candidatesBeforeRerank).toHaveLength(7);
    expect(result.topK).toHaveLength(7);
    expect(result.topK.every((id) => result.candidatesBeforeRerank.includes(id))).toBe(true);
  });

  it('пустой candidate pool — не падает, пустой результат, corpusEmbeddingModel=null (нечего сравнивать)', async () => {
    const result = await retrieveUnits('апостиль', [], {
      embeddingProvider: new FakeEmbeddingProvider(),
      rerankerProvider: new FakeRerankerProvider({}),
    });
    expect(result.topK).toEqual([]);
    expect(result.artifact.corpusEmbeddingModel).toBeNull();
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

  describe('embedding model identity — corpus и query обязаны совпадать (translation-kis)', () => {
    it('кандидаты пришли от ДВУХ разных моделей — явная ошибка перед ранжированием', async () => {
      const embeddedA = await embedCandidates([CANDIDATES[0]], new FakeEmbeddingProvider());
      const embeddedB = await embedCandidates([CANDIDATES[1]], new OtherFakeEmbeddingProvider());
      await expect(
        retrieveUnits('апостиль', [...embeddedA, ...embeddedB], {
          embeddingProvider: new FakeEmbeddingProvider(),
          rerankerProvider: new FakeRerankerProvider({}),
        })
      ).rejects.toThrow(/модел/i);
    });

    it('query embedded моделью B, corpus — моделью A -> явное несовпадение отвергается', async () => {
      const embedded = await embedCandidates(CANDIDATES, new FakeEmbeddingProvider());
      await expect(
        retrieveUnits('апостиль', embedded, {
          embeddingProvider: new OtherFakeEmbeddingProvider(),
          rerankerProvider: new FakeRerankerProvider({}),
        })
      ).rejects.toThrow(/модел/i);
    });

    it('тот же provider, РАЗНАЯ модель/размерность в ModelInfo — identity ключ provider:model, dimensions не заменяет его', async () => {
      // OtherFakeEmbeddingProvider несёт provider:'fake' (тот же), но model:'fake-embed-v2' —
      // доказывает, что сравнение идёт по паре provider+model, а не по одному provider.
      const embedded = await embedCandidates(CANDIDATES, new OtherFakeEmbeddingProvider());
      await expect(
        retrieveUnits('апостиль', embedded, {
          embeddingProvider: new FakeEmbeddingProvider(),
          rerankerProvider: new FakeRerankerProvider({}),
        })
      ).rejects.toThrow(/модел/i);
    });

    it('идентичная модель corpus/query -> работает как раньше, без ошибки', async () => {
      const embedded = await embedCandidates(CANDIDATES, new FakeEmbeddingProvider());
      const result = await retrieveUnits('апостиль', embedded, {
        embeddingProvider: new FakeEmbeddingProvider(),
        rerankerProvider: new FakeRerankerProvider({ 'apostille-1': 0.5 }),
      });
      expect(result.topK.length).toBeGreaterThan(0);
    });
  });
});
