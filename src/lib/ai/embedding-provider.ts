import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, generateEmbeddings } from '@/lib/openai';

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
  constructor(private readonly beforeRequest?: (texts: readonly string[]) => void) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.beforeRequest?.(texts);
    // A budget hook means the caller owns retry accounting. Disable hidden
    // SDK retries only for that explicitly budgeted request; ordinary
    // production callers retain the shared client's default retry policy.
    return generateEmbeddings(texts, this.beforeRequest ? { maxRetries: 0 } : undefined);
  }

  modelInfo(): ModelInfo {
    return { provider: 'openai', model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS };
  }
}
