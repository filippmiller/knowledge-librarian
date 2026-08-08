import { cosineSimilarity } from '@/lib/ai/vector-search';
import type { EmbeddingProvider, ModelInfo } from '@/lib/ai/embedding-provider';
import { searchLexical } from '@/lib/ai/lexical-search';
import { reciprocalRankFusion } from '@/lib/ai/reciprocal-rank-fusion';
import type { RerankerProvider } from '@/lib/ai/reranker-provider';

/**
 * Evaluation-only retrieval поверх reviewed JSONL (PR G, [R4], план §3) —
 * первое место во всём плане, где проверяется главная способность системы:
 * найти правило по смыслу при другой формулировке вопроса. Не пишет ничего
 * в production-таблицы; работает целиком in-memory над units из PR F.
 */

export type { EmbeddingProvider };

export interface RetrievalCandidate {
  readonly unitId: string;
  readonly retrievalText: string;
}

export interface EmbeddedCandidate extends RetrievalCandidate {
  readonly embedding: number[];
  /** Кто именно посчитал этот вектор — нужно retrieveUnits, чтобы не сравнивать
   *  cosine similarity между эмбеддингами от разных моделей (translation-kis). */
  readonly embeddingModel: ModelInfo;
}

export async function embedCandidates(
  candidates: readonly RetrievalCandidate[],
  provider: EmbeddingProvider
): Promise<EmbeddedCandidate[]> {
  if (candidates.length === 0) return [];
  const vectors = await provider.embed(candidates.map((c) => c.retrievalText));
  if (vectors.length !== candidates.length) {
    throw new Error(
      `embedCandidates: provider.embed() вернул ${vectors.length} векторов на ${candidates.length} кандидатов — ` +
        'батч рассинхронизирован, дальнейшее сопоставление по индексу было бы угадыванием'
    );
  }
  const embeddingModel = provider.modelInfo();
  return candidates.map((c, i) => ({ ...c, embedding: vectors[i], embeddingModel }));
}

export interface RetrievalTraceEntry {
  readonly unitId: string;
  readonly lexicalRank: number | null;
  readonly vectorRank: number | null;
  readonly rrfRank: number | null;
  readonly rrfScore: number;
  readonly rerankerRank: number | null;
  readonly rerankerScore: number | null;
}

export interface RetrievalArtifact {
  /** Модель, которой посчитан candidate pool. `null`, только когда пул пуст —
   *  сравнивать не с чем, а не потому что модель неизвестна. */
  readonly corpusEmbeddingModel: ModelInfo | null;
  /** Модель, которой ЭТОТ вызов посчитал вектор запроса. Может отличаться от
   *  corpusEmbeddingModel только если retrieveUnits уже отверг несовпадение —
   *  оба поля репортятся правдиво, а не одним общим "embeddingModel". */
  readonly queryEmbeddingModel: ModelInfo;
  readonly rerankerModel: ModelInfo;
  readonly rrfK: number;
  readonly candidatePoolSize: number;
}

function modelIdentity(info: ModelInfo): string {
  return `${info.provider}:${info.model}`;
}

export interface RetrievalResult {
  /** Финальный порядок unitId — ПОСЛЕ reranking. */
  readonly topK: readonly string[];
  /** unitId, вошедшие в reranking pool — ДО reranking. Отдельно от `topK`,
   *  чтобы было видно, что чинить при провале ворот: генерацию кандидатов
   *  (recall до reranking) или само ранжирование (acceptance criterion PR G). */
  readonly candidatesBeforeRerank: readonly string[];
  readonly trace: readonly RetrievalTraceEntry[];
  readonly artifact: RetrievalArtifact;
}

export interface RetrieveUnitsOptions {
  readonly embeddingProvider: EmbeddingProvider;
  readonly rerankerProvider: RerankerProvider;
  readonly rrfK?: number;
  /** Сколько кандидатов после RRF идёт в reranker — небольшой пул, не всё. */
  readonly rerankPoolSize?: number;
  readonly finalLimit?: number;
}

const DEFAULT_RRF_K = 60;
const DEFAULT_RERANK_POOL_SIZE = 20;
const DEFAULT_FINAL_LIMIT = 5;

export async function retrieveUnits(
  query: string,
  candidates: readonly EmbeddedCandidate[],
  options: RetrieveUnitsOptions
): Promise<RetrievalResult> {
  const rrfK = options.rrfK ?? DEFAULT_RRF_K;
  const rerankPoolSize = options.rerankPoolSize ?? DEFAULT_RERANK_POOL_SIZE;
  const finalLimit = options.finalLimit ?? DEFAULT_FINAL_LIMIT;

  // Отрицательные/NaN значения здесь не "естественно пустой результат" (как
  // 0 — легальный запрос "верни ничего"), а коэрсия `Array.slice` в
  // неожиданное поведение (отрицательный индекс режет С КОНЦА, NaN трактуется
  // как 0) — тихая потеря лучшего кандидата вместо явной ошибки конфигурации
  // (находка независимого ревью этого PR).
  for (const [name, value] of [
    ['rerankPoolSize', rerankPoolSize],
    ['finalLimit', finalLimit],
    ['rrfK', rrfK],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`retrieveUnits: "${name}" обязан быть неотрицательным конечным числом, получено ${value}`);
    }
  }

  const queryEmbeddingModel = options.embeddingProvider.modelInfo();
  let corpusEmbeddingModel: ModelInfo | null = null;

  if (candidates.length > 0) {
    // Прогнать это ДО эмбеддинга запроса — рассинхронизация моделей не
    // повод тратить сетевой вызов на заведомо непригодный результат.
    const corpusIdentities = new Set(candidates.map((c) => modelIdentity(c.embeddingModel)));
    if (corpusIdentities.size > 1) {
      throw new Error(
        `retrieveUnits: candidate pool содержит эмбеддинги от нескольких разных моделей ` +
          `(${[...corpusIdentities].join(', ')}) — cosine similarity между ними не сопоставим`
      );
    }
    corpusEmbeddingModel = candidates[0].embeddingModel;
    if (modelIdentity(corpusEmbeddingModel) !== modelIdentity(queryEmbeddingModel)) {
      throw new Error(
        `retrieveUnits: запрос эмбеднут моделью "${modelIdentity(queryEmbeddingModel)}", ` +
          `candidate pool — моделью "${modelIdentity(corpusEmbeddingModel)}" — векторы из разных ` +
          'пространств, cosine similarity между ними бессмысленен'
      );
    }
  }

  const artifact: RetrievalArtifact = {
    corpusEmbeddingModel,
    queryEmbeddingModel,
    rerankerModel: options.rerankerProvider.modelInfo(),
    rrfK,
    candidatePoolSize: candidates.length,
  };

  if (candidates.length === 0) {
    return { topK: [], candidatesBeforeRerank: [], trace: [], artifact };
  }

  const [queryEmbedding] = await options.embeddingProvider.embed([query]);
  if (!queryEmbedding) {
    throw new Error(
      'retrieveUnits: embeddingProvider.embed([query]) вернул пустой батч — ожидался ровно один вектор для запроса'
    );
  }

  const vectorRanked = [...candidates]
    .map((c) => ({ id: c.unitId, similarity: cosineSimilarity(queryEmbedding, c.embedding) }))
    .sort((a, b) => b.similarity - a.similarity);

  const lexicalRanked = searchLexical(
    query,
    candidates.map((c) => ({ id: c.unitId, text: c.retrievalText }))
  );

  const fused = reciprocalRankFusion(
    [
      vectorRanked.map((r) => ({ id: r.id })),
      lexicalRanked.map((r) => ({ id: r.id })),
    ],
    { k: rrfK }
  );

  const candidatesBeforeRerank = fused.slice(0, rerankPoolSize).map((f) => f.id);
  const textById = new Map(candidates.map((c) => [c.unitId, c.retrievalText]));

  const reranked = await options.rerankerProvider.rerank(
    query,
    candidatesBeforeRerank.map((id) => ({ id, text: textById.get(id) ?? '' }))
  );

  const rerankRankById = new Map(reranked.map((r, i) => [r.id, i + 1]));
  const rerankScoreById = new Map(reranked.map((r) => [r.id, r.score]));
  const rrfRankById = new Map(fused.map((f, i) => [f.id, i + 1]));
  const rrfScoreById = new Map(fused.map((f) => [f.id, f.score]));
  const vectorRankById = new Map(vectorRanked.map((r, i) => [r.id, i + 1]));
  const lexicalRankById = new Map(lexicalRanked.map((r, i) => [r.id, i + 1]));

  const trace: RetrievalTraceEntry[] = candidates.map((c) => ({
    unitId: c.unitId,
    lexicalRank: lexicalRankById.get(c.unitId) ?? null,
    vectorRank: vectorRankById.get(c.unitId) ?? null,
    rrfRank: rrfRankById.get(c.unitId) ?? null,
    rrfScore: rrfScoreById.get(c.unitId) ?? 0,
    rerankerRank: rerankRankById.get(c.unitId) ?? null,
    rerankerScore: rerankScoreById.get(c.unitId) ?? null,
  }));

  const topK = reranked.slice(0, finalLimit).map((r) => r.id);

  return { topK, candidatesBeforeRerank, trace, artifact };
}
