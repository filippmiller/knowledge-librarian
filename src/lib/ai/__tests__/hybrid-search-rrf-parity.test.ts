import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from '../reciprocal-rank-fusion';

/**
 * Parity-тест PR G [R4a]: `hybridSearch` (vector-search.ts) до рефакторинга
 * держал RRF-формулу ВНУТРИ себя; здесь эта формула воспроизведена ДОСЛОВНО
 * (скопирована из git-истории до рефакторинга) и сравнивается с результатом
 * извлечённой чистой `reciprocalRankFusion`, вызванной ровно так, как её
 * теперь вызывает `hybridSearch`. Совпадение по каждому кандидату для
 * набора реалистичных сценариев (полное совпадение множеств, частичное
 * пересечение, полностью непересекающиеся списки, дубликаты, разные
 * `semanticWeight`) — гарантия того, что рефакторинг не изменил поведение
 * живого v1-пути.
 */

interface OriginalResult {
  id: string;
  similarity: number;
}

/** ДОСЛОВНАЯ копия формулы до рефакторинга (commit до PR G) — эталон. */
function originalHybridCombine(
  semanticResults: OriginalResult[],
  keywordResults: OriginalResult[],
  semanticWeight: number
): Map<string, number> {
  const k = 60;
  const combinedScores = new Map<
    string,
    { semanticScore: number; keywordScore: number; semanticRank: number; keywordRank: number }
  >();

  semanticResults.forEach((result, index) => {
    combinedScores.set(result.id, {
      semanticScore: result.similarity,
      keywordScore: 0,
      semanticRank: index + 1,
      keywordRank: Infinity,
    });
  });

  keywordResults.forEach((result, index) => {
    const existing = combinedScores.get(result.id);
    if (existing) {
      existing.keywordScore = result.similarity;
      existing.keywordRank = index + 1;
    } else {
      combinedScores.set(result.id, {
        semanticScore: 0,
        keywordScore: result.similarity,
        semanticRank: Infinity,
        keywordRank: index + 1,
      });
    }
  });

  const scores = new Map<string, number>();
  for (const [id, entry] of combinedScores) {
    const semanticRRF = entry.semanticRank !== Infinity ? 1 / (k + entry.semanticRank) : 0;
    const keywordRRF = entry.keywordRank !== Infinity ? 1 / (k + entry.keywordRank) : 0;
    scores.set(id, semanticWeight * semanticRRF + (1 - semanticWeight) * keywordRRF);
  }
  return scores;
}

/** Вызов ровно так, как теперь делает refактореный hybridSearch. */
function refactoredHybridCombine(
  semanticResults: OriginalResult[],
  keywordResults: OriginalResult[],
  semanticWeight: number
): Map<string, number> {
  const fused = reciprocalRankFusion(
    [semanticResults.map((r) => ({ id: r.id })), keywordResults.map((r) => ({ id: r.id }))],
    { k: 60, weights: [semanticWeight, 1 - semanticWeight] }
  );
  return new Map(fused.map((f) => [f.id, f.score]));
}

function expectSameScores(
  semanticResults: OriginalResult[],
  keywordResults: OriginalResult[],
  semanticWeight = 0.7
): void {
  const original = originalHybridCombine(semanticResults, keywordResults, semanticWeight);
  const refactored = refactoredHybridCombine(semanticResults, keywordResults, semanticWeight);

  expect(refactored.size).toBe(original.size);
  for (const [id, score] of original) {
    expect(refactored.get(id)).toBeCloseTo(score, 12);
  }
}

describe('hybridSearch RRF parity — рефакторинг не меняет ранжирование', () => {
  it('полностью пересекающиеся списки, тот же порядок', () => {
    const semantic = [{ id: 'a', similarity: 0.9 }, { id: 'b', similarity: 0.8 }, { id: 'c', similarity: 0.7 }];
    const keyword = [{ id: 'a', similarity: 0.5 }, { id: 'b', similarity: 0.4 }, { id: 'c', similarity: 0.3 }];
    expectSameScores(semantic, keyword);
  });

  it('пересекающиеся списки, разный порядок', () => {
    const semantic = [{ id: 'a', similarity: 0.9 }, { id: 'b', similarity: 0.8 }, { id: 'c', similarity: 0.7 }];
    const keyword = [{ id: 'c', similarity: 0.6 }, { id: 'a', similarity: 0.5 }, { id: 'b', similarity: 0.4 }];
    expectSameScores(semantic, keyword);
  });

  it('частичное пересечение — часть кандидатов только в одном списке', () => {
    const semantic = [{ id: 'a', similarity: 0.9 }, { id: 'only-semantic', similarity: 0.6 }];
    const keyword = [{ id: 'a', similarity: 0.5 }, { id: 'only-keyword', similarity: 0.4 }];
    expectSameScores(semantic, keyword);
  });

  it('полностью непересекающиеся списки', () => {
    const semantic = [{ id: 's1', similarity: 0.9 }, { id: 's2', similarity: 0.8 }];
    const keyword = [{ id: 'k1', similarity: 0.5 }, { id: 'k2', similarity: 0.4 }];
    expectSameScores(semantic, keyword);
  });

  it('пустой keyword-список (только semantic сработал)', () => {
    const semantic = [{ id: 'a', similarity: 0.9 }, { id: 'b', similarity: 0.8 }];
    expectSameScores(semantic, []);
  });

  it('пустой semantic-список (только keyword сработал)', () => {
    const keyword = [{ id: 'a', similarity: 0.5 }, { id: 'b', similarity: 0.4 }];
    expectSameScores([], keyword);
  });

  it('другой semanticWeight (не дефолтный 0.7)', () => {
    const semantic = [{ id: 'a', similarity: 0.9 }, { id: 'b', similarity: 0.8 }];
    const keyword = [{ id: 'b', similarity: 0.5 }, { id: 'a', similarity: 0.4 }];
    expectSameScores(semantic, keyword, 0.3);
    expectSameScores(semantic, keyword, 1.0);
    expectSameScores(semantic, keyword, 0.0);
  });

  it('большие реалистичные списки (limit*2 = 10 типично)', () => {
    const semantic = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, similarity: 1 - i * 0.05 }));
    const keyword = Array.from({ length: 10 }, (_, i) => ({
      id: i % 2 === 0 ? `s${i}` : `k${i}`, // половина пересекается с semantic
      similarity: 1 - i * 0.05,
    }));
    expectSameScores(semantic, keyword);
  });
});
