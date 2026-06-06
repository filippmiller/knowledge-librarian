import { createChatCompletion, normalizeJsonResponse, streamChatCompletionTokens, type ChatMessage } from '@/lib/ai/chat-provider';
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
• Отраслевые аббревиатуры, НЕ очевидные новому сотруднику (СОН, НЗКО, РВПО, ТПП, ПЕМТ и т.д.)
  — НЕ создавай правила для общеизвестных сокращений: РФ, МИД, МЮ, ЗАГС, МФЦ, ИНН, ДМС, СМС, ЭДО

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
  - НЕ создавай отдельное правило для числа/примера, если это число уже включено в более широкое правило
  - НЕ превращай пример в самостоятельное обязательное правило, если в тексте он явно дан как пример
  - Если фраза неоднозначна — добавь uncertainty, но НЕ формулируй её как жёсткое требование
  - НЕ добавляй цели, причины и преимущества ("повышает вероятность", "предотвращает", "обязывает"), если они не сказаны прямо в тексте
  - Если в источнике есть только действие, пиши только действие; объяснение добавляй только при прямой цитате цели/логики

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
Не создавай QA для каждого микрофакта, если один вопрос естественно покрывает группу связанных правил.

═══ ПРАЙС-ЛИСТЫ И ТАРИФНЫЕ ТАБЛИЦЫ ═══

Если документ содержит таблицу тарифов вида «услуга/язык × сроки × опции (НЗ/без НЗ)»:

• Создай ОДНО правило на каждую строку таблицы (= один язык / одна услуга).
  В теле правила перечисли ВСЕ столбцы этой строки:
  "стандарт: 440 руб / с НЗ 1540 руб; через 1 день: 530 руб / с НЗ 1630 руб; …"
• Никогда не создавай отдельное правило на каждую ячейку (срок + НЗ-вариант).
  240 ячеек → 24 правила (по языкам), НЕ 240 правил.
• sourceSpan.quote: вся строка этого языка из таблицы (максимально полный фрагмент).
• Это правило важнее общего принципа «каждая цена = отдельное правило».

═══ ДЕДУПЛИКАЦИЯ ═══

Перед финальным JSON проверь себя:
- если два правила отвечают на один и тот же вопрос сотрудника — объедини их
- если одно правило является подчастью соседнего правила — оставь более полное
- если правило начинается с "пример..." и только повторяет пример из соседнего правила — удали его
- если источник не позволяет утверждать правило уверенно — перенеси это в uncertainties

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
// Keep batches small enough that "extract every concrete rule" responses do not
// hit provider output limits and produce truncated JSON.
const BATCH_SIZE = 4500;
const BATCH_OVERLAP = 600;

function parseKnowledgeExtractionJson(raw: string): KnowledgeExtractionStreamResult {
  const cleaned = normalizeJsonResponse(raw);
  const parsed = JSON.parse(cleaned) as Partial<KnowledgeExtractionStreamResult>;
  if (!parsed || !Array.isArray(parsed.rules)) {
    throw new Error('Knowledge Extractor returned invalid JSON');
  }
  return {
    rules: parsed.rules,
    qaPairs: Array.isArray(parsed.qaPairs) ? parsed.qaPairs : [],
    uncertainties: Array.isArray(parsed.uncertainties) ? parsed.uncertainties : [],
  };
}

async function retryBatchExtraction(messages: ChatMessage[]) {
  const retryContent = await createChatCompletion({
    messages: [
      ...messages,
      {
        role: 'user',
        content:
          'Предыдущий ответ не удалось распарсить как JSON. Повтори извлечение, но верни КОМПАКТНЫЙ валидный JSON без markdown. Если правил много, сократи формулировки body, но сохрани конкретные цены, сроки, требования и шаги.',
      },
    ],
    temperature: 0,
    responseFormat: 'json_object',
    maxTokens: 16000,
  });

  return parseKnowledgeExtractionJson(retryContent);
}

export async function* streamKnowledgeExtraction(
  documentText: string,
  existingRuleCodes: string[] = []
): AsyncGenerator<{ type: 'token' | 'result' | 'batch_progress' | 'batch_skipped'; data: string | KnowledgeExtractionStreamResult | { current: number; total: number } | { batchIndex: number; total: number; reason: string } }> {
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
      let batchResult: KnowledgeExtractionStreamResult;
      try {
        batchResult = parseKnowledgeExtractionJson(fullContent);
      } catch (parseError) {
        console.warn(
          `[Knowledge Extraction] Batch ${batchIndex + 1} returned invalid streamed JSON, retrying compact non-stream parse:`,
          parseError
        );
        batchResult = await retryBatchExtraction(messages);
      }

      // Default optional fields the AI sometimes omits
      const rules = pruneExtractedRules(batchResult.rules);
      const removedRuleCodes = new Set(
        batchResult.rules
          .filter((rule) => !rules.some((kept) => kept.ruleCode === rule.ruleCode))
          .map((rule) => rule.ruleCode)
      );
      const qaPairs = batchResult.qaPairs.filter((qa) => !qa.linkedRuleCode || !removedRuleCodes.has(qa.linkedRuleCode));
      const uncertainties = batchResult.uncertainties;

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

      console.log(`[Knowledge Extraction] Batch ${batchIndex + 1} complete: ${rules.length} rules, ${qaPairs.length} QAs`);
    } catch (error) {
      // Both the streaming parse and the non-streaming retry failed for this batch.
      // Log a warning and skip the batch rather than aborting the entire document —
      // a single unparseable batch is much less damaging than a FAILED document.
      const preview = typeof fullContent === 'string' ? fullContent.slice(0, 200) : '(no content)';
      console.warn(
        `[Knowledge Extraction] Batch ${batchIndex + 1}/${batches.length} failed to parse after retry — skipping batch. Preview: ${preview}`,
        error
      );
      yield {
        type: 'batch_skipped',
        data: {
          batchIndex: batchIndex + 1,
          total: batches.length,
          reason: error instanceof Error ? error.message : String(error),
        }
      };
      // Continue with remaining batches rather than failing the document
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

function pruneExtractedRules(rules: ExtractedRuleStream[]): ExtractedRuleStream[] {
  const kept: ExtractedRuleStream[] = [];
  const seenQuotes = new Set<string>();
  const seenBodies = new Set<string>();

  for (const rule of rules) {
    const quoteKey = normalizeForRuleCompare(rule.sourceSpan?.quote ?? '');
    const bodyKey = normalizeForRuleCompare(`${rule.title} ${rule.body}`).slice(0, 320);

    if (!rule.ruleCode || !rule.title?.trim() || !rule.body?.trim()) continue;
    if (quoteKey && seenQuotes.has(quoteKey)) continue;
    if (bodyKey && seenBodies.has(bodyKey)) continue;

    if (isExampleOnlyDuplicate(rule, kept)) {
      continue;
    }

    if (quoteKey) seenQuotes.add(quoteKey);
    if (bodyKey) seenBodies.add(bodyKey);
    kept.push(rule);
  }

  return kept;
}

function isExampleOnlyDuplicate(
  rule: ExtractedRuleStream,
  kept: ExtractedRuleStream[]
): boolean {
  const text = normalizeForRuleCompare(`${rule.title} ${rule.body}`);
  if (!/(^| )пример( |:)|например/.test(text)) return false;

  const quote = normalizeForRuleCompare(rule.sourceSpan?.quote ?? '');
  if (quote.length === 0 || quote.length > 80) return false;

  return kept.some((existing) => {
    const existingText = normalizeForRuleCompare(
      `${existing.title} ${existing.body} ${existing.sourceSpan?.quote ?? ''}`
    );
    return existingText.includes(quote);
  });
}

function normalizeForRuleCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function getExistingRuleCodesForStream(): Promise<string[]> {
  const rules = await prisma.rule.findMany({
    select: { ruleCode: true },
    where: { status: 'ACTIVE' },
  });
  return rules.map((r) => r.ruleCode);
}

