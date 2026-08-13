import { describe, expect, it } from 'vitest';
import { evaluateMrr, evaluateRecall } from '../retrieval-metrics';

/**
 * PR G acceptance criteria: recall@5 после reranking = 10/10 на Q01-Q10
 * (обязательные ворота); recall@K ДО reranking измеряется отдельно; MRR и
 * firstRelevantRank — диагностические (не блокирующие).
 */

describe('evaluateRecall', () => {
  it('все кейсы находят ожидаемый unit в топ-K — recall 1.0', () => {
    const result = evaluateRecall(
      [
        { query: 'Q1', expectedUnitIds: ['u1'], actualRanking: ['u1', 'u2'] },
        { query: 'Q2', expectedUnitIds: ['u2'], actualRanking: ['u3', 'u2'] },
      ],
      5
    );
    expect(result.recallAtK).toBe(1);
    expect(result.hits).toBe(2);
    expect(result.total).toBe(2);
    expect(result.misses).toEqual([]);
  });

  it('ожидаемый unit ЗА пределами K — считается промахом, попадает в misses', () => {
    const result = evaluateRecall(
      [{ query: 'Q1', expectedUnitIds: ['u1'], actualRanking: ['u2', 'u3', 'u4', 'u5', 'u6', 'u1'] }],
      5
    );
    expect(result.hits).toBe(0);
    expect(result.misses).toHaveLength(1);
    expect(result.misses[0].query).toBe('Q1');
  });

  it('несколько допустимых expectedUnitIds — попадание ЛЮБОГО из них засчитывается', () => {
    const result = evaluateRecall(
      [{ query: 'Q1', expectedUnitIds: ['u1', 'u2'], actualRanking: ['u9', 'u2'] }],
      5
    );
    expect(result.hits).toBe(1);
  });

  it('пустой набор кейсов — recall 0/0, не NaN', () => {
    const result = evaluateRecall([], 5);
    expect(result.total).toBe(0);
    expect(result.hits).toBe(0);
    expect(Number.isNaN(result.recallAtK)).toBe(false);
    expect(result.recallAtK).toBe(1); // вакуумная истина: нет кейсов — нет провалов
  });
});

describe('evaluateRecall — валидация k (pre-retrieval hardening, Step 7)', () => {
  const ONE_CASE = [{ query: 'Q1', expectedUnitIds: ['u1'], actualRanking: ['u1', 'u2'] }];

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['отрицательное', -1],
    ['дробное', 2.5],
  ])('k=%s отвергается явно, не тихой JS slice-коэрсией', (_label, k) => {
    expect(() => evaluateRecall(ONE_CASE, k)).toThrow(/k/i);
  });

  it('k=0 — легален (диагностический вырожденный случай, та же конвенция, что finalLimit/rerankPoolSize в semantic-retrieval.ts), не бросает', () => {
    expect(() => evaluateRecall(ONE_CASE, 0)).not.toThrow();
    expect(evaluateRecall(ONE_CASE, 0).recallAtK).toBe(0); // top-0 никогда не содержит expectedUnitIds
  });

  it('k=5 (обычный acceptance-порог) — по-прежнему работает как раньше', () => {
    expect(() => evaluateRecall(ONE_CASE, 5)).not.toThrow();
  });
});

describe('evaluateMrr — диагностика, не ворота', () => {
  it('релевантный unit на первом месте -> MRR = 1', () => {
    const result = evaluateMrr([{ query: 'Q1', expectedUnitIds: ['u1'], actualRanking: ['u1', 'u2'] }]);
    expect(result.mrr).toBe(1);
    expect(result.firstRelevantRankByQuery.get('Q1')).toBe(1);
  });

  it('релевантный unit на третьем месте -> вклад 1/3', () => {
    const result = evaluateMrr([
      { query: 'Q1', expectedUnitIds: ['u1'], actualRanking: ['u2', 'u3', 'u1'] },
    ]);
    expect(result.mrr).toBeCloseTo(1 / 3, 10);
    expect(result.firstRelevantRankByQuery.get('Q1')).toBe(3);
  });

  it('релевантный unit отсутствует в ranking вовсе -> вклад 0, firstRelevantRank null', () => {
    const result = evaluateMrr([{ query: 'Q1', expectedUnitIds: ['u1'], actualRanking: ['u2', 'u3'] }]);
    expect(result.mrr).toBe(0);
    expect(result.firstRelevantRankByQuery.get('Q1')).toBeNull();
  });

  it('усредняет по всем кейсам', () => {
    const result = evaluateMrr([
      { query: 'Q1', expectedUnitIds: ['u1'], actualRanking: ['u1'] }, // 1/1
      { query: 'Q2', expectedUnitIds: ['u2'], actualRanking: ['u9', 'u2'] }, // 1/2
    ]);
    expect(result.mrr).toBeCloseTo((1 + 0.5) / 2, 10);
  });
});
