import { z } from 'zod';
import type { ModelInfo } from './embedding-provider';
import { structured, type StructuredRunConfig } from './structured-output';

/**
 * Реранкер (PR G, [R4a], план §3) — **новый компонент**: в репозитории его
 * не было (`grep -rln "rerank" src/lib` пуст на момент написания), не
 * переиспользование существующего. Применяется к небольшому candidate pool
 * (десятки units, не тысячи), поэтому LLM-реранкер здесь дёшев.
 */
export interface RerankCandidate {
  readonly id: string;
  readonly text: string;
}

export interface RankedCandidate {
  readonly id: string;
  readonly score: number;
}

export interface RerankerProvider {
  rerank(query: string, candidates: readonly RerankCandidate[]): Promise<RankedCandidate[]>;
  modelInfo(): ModelInfo;
}

const rerankResponseSchema = z.strictObject({
  scores: z
    .array(z.strictObject({ id: z.string(), score: z.number().min(0).max(1) }))
    .readonly(),
});

/**
 * Кандидат из ответа модели, отсутствующий среди `candidates`, молча
 * игнорируется (модель не имеет права придумать id); кандидат, о котором
 * модель промолчала, получает `score: 0` явно — не выпадает из результата,
 * просто ранжируется последним.
 */
export class LlmRerankerProvider implements RerankerProvider {
  constructor(private readonly runConfig: StructuredRunConfig) {}

  async rerank(
    query: string,
    candidates: readonly RerankCandidate[]
  ): Promise<RankedCandidate[]> {
    if (candidates.length === 0) return [];

    const candidateList = candidates
      .map((c) => `[${c.id}] ${c.text}`)
      .join('\n\n');

    const result = await structured({
      schema: rerankResponseSchema,
      messages: [
        {
          role: 'system',
          content:
            'Ты оцениваешь, насколько каждый кандидат релевантен вопросу — по смыслу, не по совпадению слов. score от 0 (совсем не по теме) до 1 (отвечает точно на вопрос). Оцени КАЖДОГО кандидата из списка. Ответ СТРОГО JSON: {"scores": [{"id": "...", "score": число}]}',
        },
        {
          role: 'user',
          content: `Вопрос: "${query}"\n\nКандидаты:\n${candidateList}`,
        },
      ],
      runConfig: this.runConfig,
    });

    const scoreById = new Map(result.data.scores.map((s) => [s.id, s.score]));
    return candidates
      .map((c) => ({ id: c.id, score: scoreById.get(c.id) ?? 0 }))
      .sort((a, b) => b.score - a.score);
  }

  modelInfo(): ModelInfo {
    return { provider: this.runConfig.provider, model: this.runConfig.model };
  }
}
