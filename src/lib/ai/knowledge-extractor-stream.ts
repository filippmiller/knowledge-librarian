import { streamChatCompletionTokens, type ChatMessage } from '@/lib/ai/chat-provider';
import prisma from '@/lib/db';

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

// Memory-efficient batch processing constants
// EXTREME optimization for Railway free tier (512MB RAM)
const BATCH_SIZE = 1000; // Process only 1000 characters at a time
const BATCH_OVERLAP = 100; // Minimal overlap

export async function* streamKnowledgeExtraction(
  documentText: string,
  existingRuleCodes: string[] = []
): AsyncGenerator<{ type: 'token' | 'result' | 'batch_progress'; data: string | KnowledgeExtractionStreamResult | { current: number; total: number } }> {
  const startCode =
    existingRuleCodes.length > 0
      ? Math.max(...existingRuleCodes.map((c) => parseInt(c.replace('R-', '')))) + 1
      : 1;

  // Split document into batches to avoid memory issues
  const batches: string[] = [];
  let offset = 0;
  
  while (offset < documentText.length) {
    const end = Math.min(offset + BATCH_SIZE, documentText.length);
    batches.push(documentText.slice(offset, end));
    offset = end - BATCH_OVERLAP; // Overlap to catch rules at boundaries
    if (offset >= documentText.length - BATCH_OVERLAP) break;
  }

  // If document is small enough, process as single batch
  if (documentText.length <= BATCH_SIZE) {
    batches.length = 0;
    batches.push(documentText);
  }

  console.log(`[Knowledge Extraction] Processing in ${batches.length} batch(es) to conserve memory`);

  // Accumulated results across all batches
  const allRules: ExtractedRuleStream[] = [];
  const allQAPairs: ExtractedQAStream[] = [];
  const allUncertainties: UncertaintyStream[] = [];
  let currentRuleCode = startCode;

  // Process each batch
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    
    // Report progress
    yield {
      type: 'batch_progress',
      data: { current: batchIndex + 1, total: batches.length }
    };

    console.log(`[Knowledge Extraction] Processing batch ${batchIndex + 1}/${batches.length} (${batch.length} chars)`);

    const messages: ChatMessage[] = [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT_RU },
      {
        role: 'user',
        content: `Извлеки знания из этой части документа.
Начинай нумерацию правил с R-${currentRuleCode}.

${batches.length > 1 ? `\n⚠️ Это часть ${batchIndex + 1} из ${batches.length} частей документа.\n` : ''}

Содержимое:
${batch}

Ответь в формате JSON:
{
  "rules": [
    {
      "ruleCode": "R-${currentRuleCode}",
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

    const stream = streamChatCompletionTokens({
      messages,
      temperature: 0.2,
      responseFormat: 'json_object',
      maxTokens: 4096,
    });

    let fullContent = '';

    for await (const content of stream) {
      if (content) {
        fullContent += content;
        yield { type: 'token', data: content };
      }
    }

    // Parse batch result
    try {
      const { normalizeJsonResponse } = await import('@/lib/ai/chat-provider');
      const cleaned = normalizeJsonResponse(fullContent);
      const batchResult = JSON.parse(cleaned) as Partial<KnowledgeExtractionStreamResult>;
      
      if (
        !batchResult ||
        !Array.isArray(batchResult.rules) ||
        !Array.isArray(batchResult.qaPairs) ||
        !Array.isArray(batchResult.uncertainties)
      ) {
        throw new Error('Knowledge Extractor returned invalid JSON');
      }

      // Accumulate results
      allRules.push(...batchResult.rules);
      allQAPairs.push(...batchResult.qaPairs);
      allUncertainties.push(...batchResult.uncertainties);

      // Update rule code for next batch
      if (batchResult.rules.length > 0) {
        const maxCode = Math.max(
          ...batchResult.rules.map(r => parseInt(r.ruleCode.replace('R-', '')))
        );
        currentRuleCode = maxCode + 1;
      }

      // Force garbage collection if available (helps on Railway)
      if (global.gc) {
        global.gc();
      }

      console.log(`[Knowledge Extraction] Batch ${batchIndex + 1} complete: ${batchResult.rules.length} rules, ${batchResult.qaPairs.length} QAs`);
    } catch (error) {
      console.error(`[Knowledge Extraction] Failed to parse batch ${batchIndex + 1}:`, error);
      throw new Error(`Не удалось распарсить ответ батча ${batchIndex + 1}: ${fullContent.slice(0, 200)}... Ошибка: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Clear batch from memory
    batches[batchIndex] = '';
  }

  // Return combined results
  yield {
    type: 'result',
    data: {
      rules: allRules,
      qaPairs: allQAPairs,
      uncertainties: allUncertainties,
    }
  };
}

export async function getExistingRuleCodesForStream(): Promise<string[]> {
  const rules = await prisma.rule.findMany({
    select: { ruleCode: true },
    where: { status: 'ACTIVE' },
  });
  return rules.map((r) => r.ruleCode);
}

