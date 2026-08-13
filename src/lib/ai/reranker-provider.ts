import { z } from 'zod';
import type { ChatMessage, CompletionAttempt } from './chat-provider';
import type { ModelInfo } from './embedding-provider';
import { structured, type StructuredRunConfig } from './structured-output';

/** Snapshot of the most recent `rerank()` call for the call-trace log
 *  (2026-08-10) — same pairing as `CallTraceEntry`: the exact prompt next
 *  to the exact raw response, so a bad rerank can be debugged directly. */
export interface RerankTrace {
  readonly requestMessages: readonly ChatMessage[];
  readonly responseText: string | null;
}

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

export const rerankResponseSchema = z.strictObject({
  scores: z
    .array(z.strictObject({ id: z.string(), score: z.number().min(0).max(1) }))
    .readonly(),
});

export function buildRerankPromptMessages(query: string, candidates: readonly RerankCandidate[]): ChatMessage[] {
  const candidateList = candidates.map((c) => `[${c.id}] ${c.text}`).join('\n\n');
  return [{ role: 'system', content: 'Ты оцениваешь, насколько каждый кандидат нужен для ПОЛНОГО и безопасного ответа на вопрос — по смыслу, не по совпадению слов. score от 0 (совсем не по теме) до 1 (отвечает на вопрос ИЛИ содержит обязательное условие, ограничение, предостережение или действие, без которого ответ был бы неполным). Не занижай фрагмент только потому, что соседний кандидат лучше формулирует общий вывод: несколько кандидатов могут одновременно заслуживать высокий score как разные обязательные клаузы одного ответа. Оцени КАЖДОГО кандидата из списка. Ответ СТРОГО JSON: {"scores": [{"id": "...", "score": число}]}' }, { role: 'user', content: `Вопрос: "${query}"\n\nКандидаты:\n${candidateList}` }];
}

/**
 * Кандидат из ответа модели, отсутствующий среди `candidates`, молча
 * игнорируется (модель не имеет права придумать id); кандидат, о котором
 * модель промолчала, получает `score: 0` явно — не выпадает из результата,
 * просто ранжируется последним.
 */
export class LlmRerankerProvider implements RerankerProvider {
  /** Attempts from the most recent `rerank()` call — source for the cost
   *  ledger (Task 37). Not on the `RerankerProvider` interface: it's an
   *  observability detail of THIS implementation, not a contract other
   *  providers (e.g. test doubles) need to honor. */
  private pendingAttempts: CompletionAttempt[] = [];
  /** Same side-channel discipline as `pendingAttempts`, for the call-trace
   *  log (2026-08-10) — parallel, independently drainable state, not a
   *  replacement for `pendingAttempts`/`drainAttempts()`. */
  private pendingRequestMessages: readonly ChatMessage[] = [];
  private pendingResponseText: string | null = null;

  constructor(private readonly runConfig: StructuredRunConfig) {}

  async rerank(
    query: string,
    candidates: readonly RerankCandidate[]
  ): Promise<RankedCandidate[]> {
    if (candidates.length === 0) {
      this.pendingAttempts = [];
      this.pendingRequestMessages = [];
      this.pendingResponseText = null;
      return [];
    }

    const result = await structured({
      schema: rerankResponseSchema,
      messages: buildRerankPromptMessages(query, candidates),
      runConfig: this.runConfig,
    });
    this.pendingAttempts = result.attempts;
    this.pendingRequestMessages = result.requestMessages ?? [];
    this.pendingResponseText = result.rawText ?? null;

    const scoreById = new Map(result.data.scores.map((s) => [s.id, s.score]));
    return candidates
      .map((c) => ({ id: c.id, score: scoreById.get(c.id) ?? 0 }))
      .sort((a, b) => b.score - a.score);
  }

  modelInfo(): ModelInfo {
    return { provider: this.runConfig.provider, model: this.runConfig.model };
  }

  /** Returns and clears attempts from the most recent `rerank()` call. */
  drainAttempts(): readonly CompletionAttempt[] {
    const attempts = this.pendingAttempts;
    this.pendingAttempts = [];
    return attempts;
  }

  /** Returns and clears the request/response trace from the most recent
   *  `rerank()` call — source for the call-trace log (2026-08-10).
   *  Independent of `drainAttempts()`: draining one does not affect the
   *  other. */
  drainTrace(): RerankTrace {
    const trace: RerankTrace = {
      requestMessages: this.pendingRequestMessages,
      responseText: this.pendingResponseText,
    };
    this.pendingRequestMessages = [];
    this.pendingResponseText = null;
    return trace;
  }
}
