/**
 * RRF, вынесенная из `hybridSearch` (vector-search.ts) как чистая функция —
 * без Prisma, без знания об источнике списков (PR G, [R4a], план §3).
 *
 * `hybridSearch` держал ту же формулу ВНУТРИ себя, жёстко связанную с
 * `searchSimilarChunks()`/`searchByKeywords()` над `DocChunk` — из
 * in-memory JSONL-пути (PR G) вызвать её было невозможно. Обе стороны
 * (старый `DocChunk`-путь и новый JSONL-путь) зовут ОДНУ эту функцию — не
 * второй RRF, а корректное переиспользование существующего. Формула не
 * изменилась: parity-тест (`__tests__/hybrid-search-rrf-parity.test.ts`) подтверждает, что
 * `hybridSearch` после рефакторинга ранжирует так же, как до него.
 */

export interface RankedListEntry {
  readonly id: string;
}

export interface FusedResult {
  readonly id: string;
  readonly score: number;
  /** Ранг (1-based) в каждом входном списке по порядку; `null`, если
   *  элемента в этом списке не было. Для trace (PR H) — видно, какой список
   *  внёс кандидата, а какой нет. */
  readonly ranks: readonly (number | null)[];
}

export interface ReciprocalRankFusionOptions {
  readonly k: number;
  /** По списку. Без весов — равный вклад (1 на каждый список), как
   *  классический RRF. `hybridSearch` использует `[semanticWeight,
   *  1-semanticWeight]`, чтобы точно воспроизвести свою прежнюю формулу. */
  readonly weights?: readonly number[];
}

export function reciprocalRankFusion(
  rankedLists: readonly (readonly RankedListEntry[])[],
  options: ReciprocalRankFusionOptions
): FusedResult[] {
  const weights = options.weights ?? rankedLists.map(() => 1);
  const scores = new Map<string, number>();
  const ranks = new Map<string, (number | null)[]>();

  rankedLists.forEach((list, listIndex) => {
    // Первое вхождение побеждает — детерминированно, а не "последнее
    // затирает предыдущее": список кандидатов не обязан быть без дублей на
    // входе, но ранг элемента должен быть один и стабильный.
    const seenInThisList = new Set<string>();
    list.forEach((entry, i) => {
      if (seenInThisList.has(entry.id)) return;
      seenInThisList.add(entry.id);

      const rank = i + 1;
      const contribution = weights[listIndex] * (1 / (options.k + rank));
      scores.set(entry.id, (scores.get(entry.id) ?? 0) + contribution);

      const entryRanks = ranks.get(entry.id) ?? new Array(rankedLists.length).fill(null);
      entryRanks[listIndex] = rank;
      ranks.set(entry.id, entryRanks);
    });
  });

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score, ranks: ranks.get(id)! }))
    .sort((a, b) => b.score - a.score);
}
