/**
 * Метрики retrieval-качества (PR G, план §3). `recall@K` — обязательные
 * ворота (Q01-Q10, k=5, после reranking); `MRR`/`firstRelevantRank` —
 * диагностические (не блокирующие): на маленьком top-5 сам recall@K не
 * показывает деградацию ПОРЯДКА, а деградация порядка — ранний сигнал, что
 * retrieval поплыл, до того как это уронит recall.
 */

export interface RetrievalCase {
  readonly query: string;
  /** Любое совпадение засчитывается — вопрос может законно соответствовать
   *  нескольким unit'ам одного правила (например, фрагментам). */
  readonly expectedUnitIds: readonly string[];
  readonly actualRanking: readonly string[];
}

export interface RecallResult {
  readonly recallAtK: number;
  readonly hits: number;
  readonly total: number;
  readonly misses: readonly Pick<RetrievalCase, 'query' | 'expectedUnitIds'>[];
}

export function evaluateRecall(cases: readonly RetrievalCase[], k: number): RecallResult {
  if (cases.length === 0) {
    return { recallAtK: 1, hits: 0, total: 0, misses: [] };
  }

  const misses: Pick<RetrievalCase, 'query' | 'expectedUnitIds'>[] = [];
  let hits = 0;
  for (const c of cases) {
    const topK = c.actualRanking.slice(0, k);
    if (c.expectedUnitIds.some((id) => topK.includes(id))) {
      hits++;
    } else {
      misses.push({ query: c.query, expectedUnitIds: c.expectedUnitIds });
    }
  }

  return { recallAtK: hits / cases.length, hits, total: cases.length, misses };
}

export interface MrrResult {
  readonly mrr: number;
  readonly firstRelevantRankByQuery: ReadonlyMap<string, number | null>;
}

export function evaluateMrr(cases: readonly RetrievalCase[]): MrrResult {
  const firstRelevantRankByQuery = new Map<string, number | null>();
  let reciprocalSum = 0;

  for (const c of cases) {
    const rank = c.actualRanking.findIndex((id) => c.expectedUnitIds.includes(id));
    const firstRelevantRank = rank === -1 ? null : rank + 1;
    firstRelevantRankByQuery.set(c.query, firstRelevantRank);
    reciprocalSum += firstRelevantRank ? 1 / firstRelevantRank : 0;
  }

  return {
    mrr: cases.length === 0 ? 0 : reciprocalSum / cases.length,
    firstRelevantRankByQuery,
  };
}
