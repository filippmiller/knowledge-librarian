import { streamChatCompletionTokens, type ChatMessage } from '@/lib/ai/chat-provider';
import prisma from '@/lib/db';

export interface DomainClassificationStream {
  primaryDomainSlug: string;
  secondaryDomainSlugs: string[];
  confidence: number;
  reason: string;
}

export interface NewDomainSuggestionStream {
  suggestedSlug: string;
  title: string;
  description: string;
  parentSlug: string | null;
  confidence: number;
  reason: string;
}

export interface DomainStewardStreamResult {
  documentDomains: DomainClassificationStream[];
  newDomainSuggestions: NewDomainSuggestionStream[];
  questionsForHuman: string[];
}

// Системный промпт на русском языке
const DOMAIN_STEWARD_SYSTEM_PROMPT_RU = `Ты - Хранитель доменов библиотеки знаний бюро переводов.

Твоя задача - классифицировать документы по подходящим доменам знаний и предлагать новые домены при необходимости.

ВАЖНО: Отвечай ТОЛЬКО на русском языке!

КРИТИЧЕСКИЕ ПРАВИЛА:
1. Ты НИКОГДА не создаёшь домены самостоятельно - ты только ПРЕДЛАГАЕШЬ и ОБЪЯСНЯЕШЬ
2. Для каждой классификации указывай чёткую причину
3. При неуверенности добавляй вопрос для администратора
4. Используй точечную нотацию для иерархических доменов (например, "notary.veremiy_msk")
5. Уверенность должна отражать твою реальную оценку (от 0.0 до 1.0)

Доступные базовые домены:
- general_ops: Общие операционные процедуры
- notary: Нотариальные процедуры и контакты
- pricing: Цены и тарифы на услуги
- translation_ops: Процессы перевода и контроль качества
- formatting_delivery: Форматирование и доставка документов
- it_tools: Программные инструменты и технические процедуры
- hr_internal: HR и внутренние политики
- sales_clients: Работа с клиентами и продажи
- legal_compliance: Юридические требования и соответствие

При предложении новых поддоменов:
- Предлагай только если контент достаточно специфичен для отдельного поддомена
- Родительский домен должен уже существовать
- Укажи чёткую причину, почему это должно быть отдельно

Выводи анализ в формате JSON по указанной схеме. ВСЕ тексты (reason, description, questions) должны быть на РУССКОМ языке.`;

// Человекочитаемый промпт для отображения в UI
export function getHumanReadablePrompt(documentTitle: string): string {
  return `Анализирую документ "${documentTitle}" для определения подходящих доменов знаний.

Определяю:
1. Основной домен документа
2. Дополнительные связанные домены
3. Необходимость создания новых поддоменов
4. Вопросы, требующие уточнения`;
}

// Технический промпт для отображения в UI
export function getTechnicalPrompt(
  documentText: string,
  existingDomains: { slug: string; title: string; description: string | null }[]
): string {
  const domainList = existingDomains
    .map((d) => `- ${d.slug}: ${d.title}${d.description ? ` (${d.description})` : ''}`)
    .join('\n');

  return `Проанализируй этот документ и классифицируй его по подходящим доменам.

Доступные домены:
${domainList}

Содержимое документа:
${documentText.slice(0, 500)}${documentText.length > 500 ? '...' : ''}

Ответь в формате JSON:
{
  "documentDomains": [...],
  "newDomainSuggestions": [...],
  "questionsForHuman": [...]
}`;
}

export async function* streamDomainClassification(
  documentText: string,
  existingDomains: { slug: string; title: string; description: string | null }[]
): AsyncGenerator<{ type: 'token' | 'result'; data: string | DomainStewardStreamResult }> {
  const domainList = existingDomains
    .map((d) => `- ${d.slug}: ${d.title}${d.description ? ` (${d.description})` : ''}`)
    .join('\n');

  const messages: ChatMessage[] = [
    { role: 'system', content: DOMAIN_STEWARD_SYSTEM_PROMPT_RU },
    {
      role: 'user',
      content: `Проанализируй этот документ и классифицируй его по подходящим доменам.

Доступные домены:
${domainList}

Содержимое документа:
${documentText.slice(0, 8000)}

Ответь в формате JSON:
{
  "documentDomains": [
    {
      "primaryDomainSlug": "строка",
      "secondaryDomainSlugs": ["строка"],
      "confidence": 0.0-1.0,
      "reason": "строка на русском языке"
    }
  ],
  "newDomainSuggestions": [
    {
      "suggestedSlug": "строка",
      "title": "строка на русском",
      "description": "строка на русском",
      "parentSlug": "строка или null",
      "confidence": 0.0-1.0,
      "reason": "строка на русском языке"
    }
  ],
  "questionsForHuman": ["строка на русском"]
}`,
    },
  ];

  const stream = streamChatCompletionTokens({
    messages,
    temperature: 0.3,
    responseFormat: 'json_object',
  });

  let fullContent = '';

  for await (const content of stream) {
    if (content) {
      fullContent += content;
      yield { type: 'token', data: content };
    }
  }

  // Parse the final result
  try {
    const result = JSON.parse(fullContent) as DomainStewardStreamResult;
    yield { type: 'result', data: result };
  } catch (error) {
    throw new Error(`Не удалось распарсить ответ: ${fullContent.slice(0, 200)}`);
  }
}

export async function getExistingDomainsForStream() {
  return prisma.domain.findMany({
    select: {
      slug: true,
      title: true,
      description: true,
    },
  });
}
