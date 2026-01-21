/**
 * Query Expansion Module
 *
 * Generates multiple query variants for ambiguous questions to improve retrieval recall.
 * Implements Multi-Query Retrieval pattern for RAG systems.
 */

import { createChatCompletion } from '@/lib/ai/chat-provider';

export interface ExpandedQueries {
  original: string;
  variants: string[];
  isAmbiguous: boolean;
  suggestedClarification?: string;
}

const QUERY_EXPANSION_PROMPT = `Ты - эксперт по пониманию запросов для системы знаний бюро переводов.

Твоя задача - проанализировать вопрос пользователя и:
1. Определить, является ли вопрос неоднозначным или недостаточно конкретным
2. Сгенерировать 2-3 перефразированные версии вопроса для улучшения поиска
3. Если вопрос слишком общий - предложить уточняющий вопрос

Правила перефразирования:
- Сохраняй исходный смысл
- Используй синонимы и альтернативные формулировки
- Добавляй конкретизирующие термины, если уместно
- Учитывай русскую морфологию (падежи, склонения)

Контекст: система содержит правила и процедуры бюро переводов - цены, сроки, требования к документам, нотариальные услуги.

Ответь в формате JSON:
{
  "isAmbiguous": boolean,
  "variants": ["вариант1", "вариант2", "вариант3"],
  "suggestedClarification": "уточняющий вопрос или null"
}`;

export async function expandQuery(question: string): Promise<ExpandedQueries> {
  try {
    const content = await createChatCompletion({
      messages: [
        { role: 'system', content: QUERY_EXPANSION_PROMPT },
        { role: 'user', content: question },
      ],
      responseFormat: 'json_object',
      temperature: 0.3,
    });
    if (!content) {
      return { original: question, variants: [], isAmbiguous: false };
    }

    const parsed = JSON.parse(content);
    return {
      original: question,
      variants: parsed.variants || [],
      isAmbiguous: parsed.isAmbiguous ?? false,
      suggestedClarification: parsed.suggestedClarification || undefined,
    };
  } catch (error) {
    console.error('Query expansion failed:', error);
    return { original: question, variants: [], isAmbiguous: false };
  }
}

/**
 * Extract entities from a query (dates, prices, document types)
 */
export interface ExtractedEntities {
  dates: string[];
  prices: string[];
  documentTypes: string[];
  services: string[];
}

const ENTITY_EXTRACTION_PROMPT = `Извлеки из вопроса пользователя следующие сущности (если есть):
- dates: упоминания дат, периодов, сроков
- prices: упоминания цен, стоимости, тарифов
- documentTypes: типы документов (паспорт, диплом, справка, и т.д.)
- services: услуги (перевод, нотариальное заверение, апостиль, и т.д.)

Ответь в формате JSON:
{
  "dates": [],
  "prices": [],
  "documentTypes": [],
  "services": []
}`;

export async function extractEntities(question: string): Promise<ExtractedEntities> {
  try {
    const content = await createChatCompletion({
      messages: [
        { role: 'system', content: ENTITY_EXTRACTION_PROMPT },
        { role: 'user', content: question },
      ],
      responseFormat: 'json_object',
      temperature: 0.1,
    });
    if (!content) {
      return { dates: [], prices: [], documentTypes: [], services: [] };
    }

    return JSON.parse(content);
  } catch (error) {
    console.error('Entity extraction failed:', error);
    return { dates: [], prices: [], documentTypes: [], services: [] };
  }
}

/**
 * Normalize Russian text for better matching
 * Handles common variations and typos
 */
export function normalizeRussianText(text: string): string {
  return text
    .toLowerCase()
    // Normalize common variations
    .replace(/ё/g, 'е')
    // Remove extra whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Generate search-optimized variants of a Russian word
 * Simple stemming for common suffixes
 */
export function generateWordVariants(word: string): string[] {
  const normalized = normalizeRussianText(word);
  const variants = new Set<string>([normalized]);

  // Common Russian noun endings
  const nounEndings = ['а', 'я', 'ы', 'и', 'у', 'ю', 'е', 'о', 'ой', 'ей', 'ом', 'ем', 'ами', 'ями'];
  const adjectiveEndings = ['ый', 'ий', 'ой', 'ая', 'яя', 'ое', 'ее', 'ые', 'ие', 'ого', 'его', 'ому', 'ему'];
  const verbEndings = ['ть', 'ет', 'ит', 'ут', 'ют', 'ат', 'ят', 'ал', 'ил', 'ел', 'ла', 'ло', 'ли'];

  const allEndings = [...nounEndings, ...adjectiveEndings, ...verbEndings];

  // Try to find stem by removing endings
  for (const ending of allEndings) {
    if (normalized.endsWith(ending) && normalized.length > ending.length + 2) {
      const stem = normalized.slice(0, -ending.length);
      // Add common forms from stem
      variants.add(stem);
      variants.add(stem + 'а');
      variants.add(stem + 'ы');
      variants.add(stem + 'у');
      variants.add(stem + 'е');
      variants.add(stem + 'ов');
      break;
    }
  }

  return Array.from(variants);
}
