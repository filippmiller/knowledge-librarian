import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from '../reciprocal-rank-fusion';

/**
 * PR G [R4a]: чистая функция, извлечённая из `hybridSearch` (vector-search.ts)
 * — та же формула, без Prisma и без знания об источнике списков, чтобы её
 * мог звать и старый DocChunk-путь, и новый in-memory JSONL-путь.
 */

describe('reciprocalRankFusion — базовая формула', () => {
  it('единственный список — score = 1/(k+rank) для каждого элемента, порядок сохранён', () => {
    const result = reciprocalRankFusion([[{ id: 'a' }, { id: 'b' }]], { k: 60 });
    expect(result).toEqual([
      { id: 'a', score: 1 / 61, ranks: [1] },
      { id: 'b', score: 1 / 62, ranks: [2] },
    ]);
  });

  it('два списка без весов — суммирует 1/(k+rank) по каждому списку', () => {
    const result = reciprocalRankFusion(
      [
        [{ id: 'a' }, { id: 'b' }],
        [{ id: 'b' }, { id: 'a' }],
      ],
      { k: 60 }
    );
    const byId = Object.fromEntries(result.map((r) => [r.id, r.score]));
    expect(byId.a).toBeCloseTo(1 / 61 + 1 / 62, 10);
    expect(byId.b).toBeCloseTo(1 / 62 + 1 / 61, 10);
  });

  it('элемент только в ОДНОМ списке — вклад второго списка = 0, ranks несёт null на его месте', () => {
    const result = reciprocalRankFusion(
      [[{ id: 'a' }], [{ id: 'b' }]],
      { k: 60 }
    );
    const a = result.find((r) => r.id === 'a')!;
    expect(a.score).toBeCloseTo(1 / 61, 10);
    expect(a.ranks).toEqual([1, null]);
  });

  it('взвешенная комбинация — воспроизводит формулу hybridSearch (semanticWeight * semanticRRF + (1-semanticWeight) * keywordRRF)', () => {
    const semanticWeight = 0.7;
    const result = reciprocalRankFusion(
      [
        [{ id: 'a' }, { id: 'b' }], // semantic: a rank1, b rank2
        [{ id: 'b' }, { id: 'a' }], // keyword: b rank1, a rank2
      ],
      { k: 60, weights: [semanticWeight, 1 - semanticWeight] }
    );
    const byId = Object.fromEntries(result.map((r) => [r.id, r.score]));
    expect(byId.a).toBeCloseTo(0.7 * (1 / 61) + 0.3 * (1 / 62), 10);
    expect(byId.b).toBeCloseTo(0.7 * (1 / 62) + 0.3 * (1 / 61), 10);
  });

  it('результат отсортирован по убыванию score', () => {
    const result = reciprocalRankFusion(
      [[{ id: 'low' }, { id: 'high' }]],
      { k: 60, weights: [1] }
    );
    // 'low' ранг 1 (выше score), 'high' ранг 2 (ниже score) — имена
    // намеренно не совпадают с их итоговым порядком, чтобы тест не прошёл
    // случайно на уже-отсортированном входе.
    expect(result[0].id).toBe('low');
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });

  it('пустые списки — пустой результат', () => {
    expect(reciprocalRankFusion([[], []], { k: 60 })).toEqual([]);
  });

  it('элемент, встречающийся в списке дважды, — считается по ПЕРВОМУ вхождению (детерминированно)', () => {
    const result = reciprocalRankFusion([[{ id: 'a' }, { id: 'b' }, { id: 'a' }]], { k: 60 });
    const a = result.find((r) => r.id === 'a')!;
    expect(a.ranks).toEqual([1]);
  });
});
