import { streamChatCompletion, CHAT_MODEL } from '@/lib/openai';
import prisma from '@/lib/db';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

export interface ExtractedRuleStream {
  ruleCode: string;
  title: string;
  body: string;
  confidence: number;
  sourceSpan: {
    quote: string;
    locationHint: string;
  };
}

export interface ExtractedQAStream {
  question: string;
  answer: string;
  linkedRuleCode: string | null;
}

export interface UncertaintyStream {
  type: string;
  description: string;
  suggestedQuestion: string;
}

export interface KnowledgeExtractionStreamResult {
  rules: ExtractedRuleStream[];
  qaPairs: ExtractedQAStream[];
  uncertainties: UncertaintyStream[];
}

// Системный промпт на русском языке
const EXTRACTION_SYSTEM_PROMPT_RU = `Ты - Экстрактор знаний для бюро переводов.

ВАЖНО: ВСЕ извлечённые данные должны быть на РУССКОМ языке!

Твоя задача - извлечь структурированные знания из документов:

1. БИЗНЕС-ПРАВИЛА: Явные утверждения о порядке работы
   - Цены, тарифы, сроки
   - Процедуры и рабочие процессы
   - Требования и условия

2. ВОПРОСЫ И ОТВЕТЫ: Пары вопрос-ответ для помощи сотрудникам
   - На основе извлечённых правил
   - Типичные вопросы по теме

3. НЕЯСНОСТИ: Отметь всё, что:
   - Неоднозначно ("примерно", "обычно", "около")
   - Возможно устарело
   - Противоречит общим знаниям
   - Требует уточнения

КРИТИЧЕСКИ ВАЖНО:
- Извлекай ТОЛЬКО явно указанное
- НЕ делай выводов и предположений
- Если указана цена - извлекай точно
- Если описана процедура - извлекай шаги
- Всегда цитируй источник с точной цитатой
- ВСЕ тексты (title, body, question, answer, description) на РУССКОМ языке

Коды правил должны быть последовательными: R-1, R-2, R-3...`;

// Человекочитаемый промпт для отображения в UI
export function getHumanReadablePrompt(documentTitle: string): string {
  return `Извлекаю знания из документа "${documentTitle}".

Ищу:
1. Бизнес-правила (цены, сроки, процедуры)
2. Вопросы и ответы для сотрудников
3. Неясности, требующие уточнения`;
}

// Технический промпт для отображения в UI
export function getTechnicalPrompt(documentText: string, startCode: number): string {
  return `Извлеки знания из этого документа.
Начинай нумерацию правил с R-${startCode}.

Содержимое документа:
${documentText.slice(0, 500)}${documentText.length > 500 ? '...' : ''}

Ответь в формате JSON:
{
  "rules": [...],
  "qaPairs": [...],
  "uncertainties": [...]
}`;
}

export async function* streamKnowledgeExtraction(
  documentText: string,
  existingRuleCodes: string[] = []
): AsyncGenerator<{ type: 'token' | 'result'; data: string | KnowledgeExtractionStreamResult }> {
  const startCode =
    existingRuleCodes.length > 0
      ? Math.max(...existingRuleCodes.map((c) => parseInt(c.replace('R-', '')))) + 1
      : 1;

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: EXTRACTION_SYSTEM_PROMPT_RU },
    {
      role: 'user',
      content: `Извлеки знания из этого документа.
Начинай нумерацию правил с R-${startCode}.

Содержимое документа:
${documentText.slice(0, 12000)}

Ответь в формате JSON:
{
  "rules": [
    {
      "ruleCode": "R-${startCode}",
      "title": "Краткое название на русском",
      "body": "Полное описание правила на русском",
      "confidence": 0.0-1.0,
      "sourceSpan": {
        "quote": "Точная цитата из документа",
        "locationHint": "Раздел или контекст"
      }
    }
  ],
  "qaPairs": [
    {
      "question": "Вопрос на русском",
      "answer": "Ответ на русском на основе извлечённых правил",
      "linkedRuleCode": "R-X или null"
    }
  ],
  "uncertainties": [
    {
      "type": "ambiguous|outdated|conflicting|missing_context",
      "description": "Описание неясности на русском",
      "suggestedQuestion": "Вопрос для администратора на русском"
    }
  ]
}`,
    },
  ];

  const stream = await streamChatCompletion({
    model: CHAT_MODEL,
    messages,
    temperature: 0.2,
    responseFormat: 'json_object',
  });

  let fullContent = '';

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || '';
    if (content) {
      fullContent += content;
      yield { type: 'token', data: content };
    }
  }

  // Parse the final result
  try {
    const result = JSON.parse(fullContent) as KnowledgeExtractionStreamResult;
    yield { type: 'result', data: result };
  } catch (error) {
    throw new Error(`Не удалось распарсить ответ: ${fullContent.slice(0, 200)}`);
  }
}

export async function getExistingRuleCodesForStream(): Promise<string[]> {
  const rules = await prisma.rule.findMany({
    select: { ruleCode: true },
    where: { status: 'ACTIVE' },
  });
  return rules.map((r) => r.ruleCode);
}
