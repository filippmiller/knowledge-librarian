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

// Системный промпт — агрессивное максимальное извлечение правил
const EXTRACTION_SYSTEM_PROMPT_RU = `Ты - Экстрактор знаний для бюро переводов "Аврора".

ВСЕ ТЕКСТЫ ТОЛЬКО НА РУССКОМ ЯЗЫКЕ.

ГЛАВНАЯ ЗАДАЧА: извлечь МАКСИМАЛЬНОЕ количество конкретных правил из текста.
Лучше извлечь 30 правил, чем пропустить 20 из-за неуверенности.

═══ ЧТО СЧИТАЕТСЯ ПРАВИЛОМ ═══

Каждое из следующего = ОТДЕЛЬНОЕ правило:
• Любая цена, тариф, стоимость (за страницу, за слово, за услугу, за язык)
• Любой срок выполнения или действия документа
• Любое требование к документу (формат, заверение, апостиль, нотариус)
• Любая процедура или последовательность шагов
• Любое контактное лицо или ответственный
• Любая скидка, наценка, коэффициент, надбавка
• Любое ограничение, условие или исключение
• Любой тип услуги с описанием
• Любое правило работы с клиентом
• Любая аббревиатура или специальный термин с расшифровкой (СОН, ГТД, КПП и т.д.)

═══ КАК ПИСАТЬ ПРАВИЛА ═══

title (5–12 слов):
  ✓ "Цена перевода паспорта с нотариальным заверением"
  ✓ "Срок апостиля на диплом — 5 рабочих дней"
  ✗ "Правило о ценах" (слишком общо)

body (полное описание):
  - Конкретные числа, суммы, даты — без округлений
  - Если есть условия — перечисли все
  - Если это процедура — пронумеруй шаги
  - Если есть исключения — укажи явно

confidence:
  0.95–1.0 — конкретная цифра прямо в тексте
  0.80–0.94 — вывод из контекста с высокой уверенностью
  0.60–0.79 — неточно или требует уточнения

sourceSpan.quote: дословная цитата из документа (макс. 150 символов)
sourceSpan.locationHint: раздел или заголовок, где встретилось

═══ ВОПРОСЫ И ОТВЕТЫ ═══

На каждое важное правило создай 1–2 QA пары.
Вопрос — как спросил бы реальный сотрудник или клиент.
Ответ — конкретный, без воды.

═══ НЕЯСНОСТИ ═══

Отмечай только реально неоднозначное:
- "примерно", "около", "как правило" без точных цифр
- Устаревшие данные (упоминание прошлых лет)
- Противоречия между разными частями текста

Коды правил: R-1, R-2, R-3 ... (строго последовательно)`;

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

// Batch processing constants
// 8000 chars ≈ 4–5 pages of text — enough context for the LLM to understand structure
// Overlap ensures rules spanning a batch boundary are captured in full
const BATCH_SIZE = 8000;
const BATCH_OVERLAP = 600;

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
        content: `Извлеки ВСЕ правила из этой части документа. Нумерация начинается с R-${currentRuleCode}.
${batches.length > 1 ? `Часть ${batchIndex + 1} из ${batches.length}.` : ''}

ТЕКСТ ДОКУМЕНТА:
${batch}

ВАЖНО: Пройди текст построчно. Каждая строка с конкретным значением (цена, срок, требование, шаг процедуры) = отдельное правило.
Не пропускай аббревиатуры — если встречается незнакомая аббревиатура (СОН, ГТД, ДМС и т.д.), создай правило с её расшифровкой и значением.

Ответь ТОЛЬКО JSON без пояснений:
{
  "rules": [
    {
      "ruleCode": "R-${currentRuleCode}",
      "title": "Краткое название правила на русском (5-12 слов)",
      "body": "Полное описание со всеми конкретными значениями на русском",
      "confidence": 0.95,
      "sourceSpan": {
        "quote": "Дословная цитата из текста",
        "locationHint": "Раздел или заголовок"
      }
    }
  ],
  "qaPairs": [
    {
      "question": "Как спросил бы сотрудник или клиент?",
      "answer": "Конкретный ответ на основе правила",
      "linkedRuleCode": "R-X"
    }
  ],
  "uncertainties": [
    {
      "type": "ambiguous|outdated|conflicting|missing_context",
      "description": "Описание проблемы на русском",
      "suggestedQuestion": "Вопрос администратору"
    }
  ]
}`,
      },
    ];

    const stream = streamChatCompletionTokens({
      messages,
      temperature: 0.1,
      responseFormat: 'json_object',
      maxTokens: 8192,
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

