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
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return generateEmbeddings(texts);
  }

  modelInfo(): ModelInfo {
    return { provider: 'openai', model: EMBEDDING_MODEL, dimensions: EMBEDDING_DIMENSIONS };
  }
}
