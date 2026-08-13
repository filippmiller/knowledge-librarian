import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, generateEmbeddings } from '@/lib/openai';
import type { CompletionAttempt } from './chat-provider';

/**
 * Провайдер эмбеддингов (PR G, [R4a], план §3). Интерфейс фиксируется здесь;
 * выбор конкретной модели — решение тестового пакета, не спор в плане.
 * Артефакт прогона обязан хранить `modelInfo()` целиком (provider/model/
 * dimensions) — иначе результат невоспроизводим и не сравним между прогонами.
 */
export interface ModelInfo {
  readonly provider: string;
  readonly model: string;
  readonly dimensions?: number;
}

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  modelInfo(): ModelInfo;
}

/** Оборачивает уже существующий `generateEmbeddings` (`@/lib/openai`) — не
 *  второй способ звать OpenAI, тот же клиент/модель, что и остальная система. */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly beforeRequest?: (texts: readonly string[]) => void,
    private readonly onAttempt?: (attempt: CompletionAttempt, texts: readonly string[]) => void,
    private readonly maxAttempts = beforeRequest ? 3 : 1
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    for (let attemptIndex = 1; attemptIndex <= this.maxAttempts; attemptIndex++) {
      this.beforeRequest?.(texts);
      const startedAt = new Date().toISOString();
      const startedMs = Date.now();
      let usage: CompletionAttempt['usage'];
      let embeddings: number[][];
      try {
        embeddings = await generateEmbeddings(
          texts,
          this.beforeRequest ? { maxRetries: 0 } : undefined,
          (reportedUsage) => { usage = reportedUsage ?? undefined; }
        );
      } catch (error) {
        const statusCode = embeddingErrorStatus(error);
        const errorCode = embeddingErrorCode(error);
        this.onAttempt?.({
          provider: 'openai', model: EMBEDDING_MODEL, startedAt,
          latencyMs: Date.now() - startedMs, outcome: 'ERROR',
          ...(statusCode !== undefined && { statusCode }), ...(errorCode && { errorCode }),
        }, texts);
        if (!isRetryableEmbeddingError(error) || attemptIndex === this.maxAttempts) throw error;
        continue;
      }
      // Keep accounting callbacks outside the provider-error catch. A hard
      // cost ceiling may deliberately throw here after recording the paid
      // success; that must not be misreported (or recorded again) as a
      // transport failure.
      this.onAttempt?.({
        provider: 'openai', model: EMBEDDING_MODEL, startedAt,
        latencyMs: Date.now() - startedMs, outcome: 'SUCCESS', ...(usage && { usage }),
      }, texts);
      return embeddings;
    }
    throw new Error('OpenAIEmbeddingProvider.embed: unreachable');
  }

  modelInfo(): ModelInfo {
    return { provider: 'openai', model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS };
  }
}

function embeddingErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  for (const key of ['status', 'statusCode'] as const) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

function embeddingErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = (error as Record<string, unknown>).code;
  return typeof value === 'string' ? value : undefined;
}

export function isRetryableEmbeddingError(error: unknown): boolean {
  const status = embeddingErrorStatus(error);
  if (status !== undefined) {
    if (status >= 400 && status < 500) return status === 408 || status === 409 || status === 429;
    return status >= 500;
  }
  const text = `${error instanceof Error ? `${error.name} ${error.message}` : String(error)} ${embeddingErrorCode(error) ?? ''}`.toLowerCase();
  return /terminated|fetch failed|timeout|timedout|connection|econnreset|econnrefused|etimedout|socket/.test(text);
}
