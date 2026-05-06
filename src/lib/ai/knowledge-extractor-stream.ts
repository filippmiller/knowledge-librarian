import { streamChatCompletionTokens, type ChatMessage } from '@/lib/ai/chat-provider';
import prisma from '@/lib/db';
import { buildExtractionBatches, dedupeAndRenumberRules } from '@/lib/ai/extraction-batches';

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

export async function* streamKnowledgeExtraction(
  documentText: string,
  existingRuleCodes: string[] = []
): AsyncGenerator<{ type: 'token' | 'result' | 'batch_progress'; data: string | KnowledgeExtractionStreamResult | { current: number; total: number } }> {
  const startCode =
    existingRuleCodes.length > 0
      ? Math.max(...existingRuleCodes.map((c) => parseInt(c.replace('R-', '')))) + 1
      : 1;

  const batches = buildExtractionBatches(documentText);

  console.log(`[Knowledge Extraction] Processing in ${batches.length} structured batch(es)`);

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
      data: { current: batch.index, total: batch.total }
    };

    console.log(`[Knowledge Extraction] Processing batch ${batch.index}/${batch.total} (lines ${batch.startLine}-${batch.endLine}, ${batch.text.length} chars)`);

    const messages: ChatMessage[] = [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT_RU },
      {
        role: 'user',
        content: `Извлеки ВСЕ правила из этой части документа. Нумерация начинается с R-${currentRuleCode}.
${batches.length > 1 ? `Часть ${batch.index} из ${batch.total}. Строки ${batch.startLine}-${batch.endLine}.` : ''}

ТЕКСТ ДОКУМЕНТА С НОМЕРАМИ СТРОК:
${batch.numberedText}

ВАЖНО:
1. Пройди строки сверху вниз. Каждая атомарная строка с ценой, сроком, адресом, телефоном, требованием, исключением, шагом процедуры, вариантом подачи, способом оплаты, ответственным или аббревиатурой = отдельное правило.
2. Не объединяй несколько разных фактов в одно правило. Лучше 3 коротких правила, чем 1 длинное.
3. Для списков создай отдельное правило на каждый пункт списка.
4. Если строка является заголовком раздела, используй её как locationHint для следующих правил.
5. В sourceSpan.locationHint указывай номер строки или диапазон строк, например "L0012-L0014".
6. Цель плотности: из 20 содержательных строк обычно должно получиться 12-25 правил. Не экономь правила.

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
      maxTokens: 16000,
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

      if (!batchResult || !Array.isArray(batchResult.rules)) {
        throw new Error('Knowledge Extractor returned invalid JSON');
      }

      // Default optional fields the AI sometimes omits
      const rules = batchResult.rules;
      const qaPairs = Array.isArray(batchResult.qaPairs) ? batchResult.qaPairs : [];
      const uncertainties = Array.isArray(batchResult.uncertainties) ? batchResult.uncertainties : [];

      // Accumulate results
      allRules.push(...rules);
      allQAPairs.push(...qaPairs);
      allUncertainties.push(...uncertainties);

      // Update rule code for next batch
      if (rules.length > 0) {
        const maxCode = Math.max(
          ...rules.map(r => parseInt(r.ruleCode.replace('R-', '')))
        );
        currentRuleCode = maxCode + 1;
      }

      // Force garbage collection if available (helps on Railway)
      if (global.gc) {
        global.gc();
      }

      console.log(`[Knowledge Extraction] Batch ${batch.index} complete: ${rules.length} rules, ${qaPairs.length} QAs`);
    } catch (error) {
      console.error(`[Knowledge Extraction] Failed to parse batch ${batchIndex + 1}:`, error);
      throw new Error(`Не удалось распарсить ответ батча ${batchIndex + 1}: ${fullContent.slice(0, 200)}... Ошибка: ${error instanceof Error ? error.message : String(error)}`);
    }

  }

  const deduped = dedupeAndRenumberRules(allRules, allQAPairs, startCode);

  // Return combined results
  yield {
    type: 'result',
    data: {
      rules: deduped.rules,
      qaPairs: deduped.qaPairs,
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
