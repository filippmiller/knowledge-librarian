/**
 * Enhanced Answering Engine
 *
 * Improvements over the basic answering engine:
 * 1. Hybrid search (semantic + keyword)
 * 2. Multi-query retrieval for better recall
 * 3. Confidence thresholds with clarifying questions
 * 4. Dynamic context sizing based on similarity distribution
 * 5. Conversation context tracking
 */

import { createChatCompletion } from '@/lib/ai/chat-provider';
import prisma from '@/lib/db';
import { hybridSearch, HybridSearchResult } from './vector-search';
import { expandQuery, ExtractedEntities, extractEntities } from './query-expansion';

// Confidence thresholds
const CONFIDENCE_THRESHOLD_HIGH = 0.7;    // Answer confidently
const CONFIDENCE_THRESHOLD_MEDIUM = 0.5;  // Answer with caveat
const CONFIDENCE_THRESHOLD_LOW = 0.3;     // Ask for clarification

export interface EnhancedAnswerResult {
  answer: string;
  confidence: number;
  confidenceLevel: 'high' | 'medium' | 'low' | 'insufficient';
  needsClarification: boolean;
  suggestedClarification?: string;
  citations: {
    ruleCode?: string;
    documentTitle?: string;
    quote: string;
    relevanceScore: number;
  }[];
  domainsUsed: string[];
  queryAnalysis: {
    originalQuery: string;
    expandedQueries: string[];
    extractedEntities: ExtractedEntities;
    isAmbiguous: boolean;
  };
  debug?: {
    chunks: { content: string; semanticScore: number; keywordScore: number; combinedScore: number }[];
    intentClassification: IntentClassification;
    searchStats: {
      totalChunksSearched: number;
      avgSimilarity: number;
      maxSimilarity: number;
    };
  };
}

interface IntentClassification {
  intent: string;
  domains: string[];
  confidence: number;
  reasoning?: string;
}

const INTENT_CLASSIFIER_PROMPT = `Ты - классификатор намерений для системы знаний бюро переводов.

Классифицируй вопрос пользователя:
1. Определи намерение:
   - price_query: вопросы о ценах, стоимости, тарифах
   - procedure_query: вопросы о процедурах, порядке действий
   - requirements_query: вопросы о требованиях к документам
   - timeline_query: вопросы о сроках выполнения
   - contact_query: вопросы о контактах, адресах
   - general_info: общие вопросы

2. Определи релевантные домены из списка:
   - general_ops: общие операции
   - notary: нотариальные услуги
   - pricing: ценообразование
   - translation_ops: переводческие операции
   - formatting_delivery: форматирование и доставка
   - it_tools: IT инструменты
   - hr_internal: внутренние HR процессы
   - sales_clients: продажи и клиенты
   - legal_compliance: юридическое соответствие

3. Оцени свою уверенность (0.0-1.0)
4. Кратко объясни свой выбор

Ответь в формате JSON:
{
  "intent": "строка",
  "domains": ["строка"],
  "confidence": 0.0-1.0,
  "reasoning": "краткое объяснение"
}`;

const ENHANCED_ANSWERING_PROMPT = `Ты - ИИ-библиотекарь знаний для бюро переводов.

КРИТИЧЕСКИЕ ПРАВИЛА:
1. Отвечай ТОЛЬКО на основе предоставленных знаний
2. Если информации недостаточно - честно скажи об этом
3. Всегда указывай источники (коды правил)
4. Будь краток и точен
5. Отвечай на русском языке

УРОВНИ УВЕРЕННОСТИ:
- Высокий: найдена точная информация → отвечай уверенно
- Средний: информация частичная → отвечай с оговоркой "насколько мне известно"
- Низкий: информация косвенная → предложи уточнить вопрос
- Недостаточный: ничего не найдено → честно скажи "Я не нашёл информации"

ДЛЯ ЦЕН И СРОКОВ:
- Цитируй точные значения из базы знаний
- Если цена может быть устаревшей (более 6 месяцев) - предупреди
- Если есть несколько вариантов - перечисли все

ДЛЯ ПРОЦЕДУР:
- Опиши шаги последовательно
- Укажи необходимые документы
- Упомяни исключения, если есть`;

async function classifyIntent(question: string): Promise<IntentClassification> {
  const { createChatCompletion, normalizeJsonResponse } = await import('@/lib/ai/chat-provider');
  const content = await createChatCompletion({
    messages: [
      { role: 'system', content: INTENT_CLASSIFIER_PROMPT },
      { role: 'user', content: question },
    ],
    responseFormat: 'json_object',
    temperature: 0.1,
    maxTokens: 1024,
  });
  if (!content) {
    return { intent: 'general_info', domains: [], confidence: 0.5 };
  }

  try {
    const cleaned = normalizeJsonResponse(content);
    const parsed = JSON.parse(cleaned) as Partial<IntentClassification>;
    const intent = typeof parsed.intent === 'string' ? parsed.intent : 'general_info';
    const domains = Array.isArray(parsed.domains)
      ? parsed.domains.filter((domain) => typeof domain === 'string')
      : [];
    const confidence =
      typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;
    const reasoning =
      typeof parsed.reasoning === 'string' ? parsed.reasoning : undefined;

    return reasoning ? { intent, domains, confidence, reasoning } : { intent, domains, confidence };
  } catch (error) {
    console.error('Intent classification parse failed:', error);
    return { intent: 'general_info', domains: [], confidence: 0.5 };
  }
}

/**
 * Multi-query retrieval: run search with multiple query variants
 */
async function multiQuerySearch(
  queries: string[],
  domainSlugs: string[],
  limit: number
): Promise<HybridSearchResult[]> {
  // Run searches in parallel
  const allResults = await Promise.all(
    queries.map(q => hybridSearch(q, domainSlugs, limit))
  );

  // Merge and deduplicate results using max score
  const mergedResults = new Map<string, HybridSearchResult>();

  for (const results of allResults) {
    for (const result of results) {
      const existing = mergedResults.get(result.id);
      if (!existing || result.combinedScore > existing.combinedScore) {
        mergedResults.set(result.id, result);
      }
    }
  }

  return Array.from(mergedResults.values())
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit);
}

/**
 * Dynamic context sizing based on similarity distribution
 */
function selectContextChunks(
  chunks: HybridSearchResult[],
  maxChunks: number = 5
): HybridSearchResult[] {
  if (chunks.length === 0) return [];

  // Find the "elbow" in similarity scores
  const scores = chunks.map(c => c.combinedScore);
  const maxScore = scores[0];

  // Include chunks with score >= 60% of max score, up to maxChunks
  const threshold = maxScore * 0.6;

  return chunks
    .filter(c => c.combinedScore >= threshold)
    .slice(0, maxChunks);
}

/**
 * Main enhanced answering function
 */
export async function answerQuestionEnhanced(
  question: string,
  sessionId?: string,
  includeDebug: boolean = false
): Promise<EnhancedAnswerResult> {
  // Step 1: Expand query and extract entities in parallel
  const [expandedQueries, entities, intentResult] = await Promise.all([
    expandQuery(question),
    extractEntities(question),
    classifyIntent(question),
  ]);

  // Step 2: Build query list for multi-query retrieval
  const allQueries = [question, ...expandedQueries.variants];

  // Step 3: Run hybrid multi-query search
  const chunks = await multiQuerySearch(
    allQueries,
    intentResult.domains,
    10
  );

  // Step 4: Select context chunks dynamically
  const contextChunks = selectContextChunks(chunks, 5);

  // Step 5: Get relevant active rules
  const rules = await prisma.rule.findMany({
    where: {
      status: 'ACTIVE',
      domains: intentResult.domains.length > 0
        ? { some: { domain: { slug: { in: intentResult.domains } } } }
        : undefined,
    },
    include: {
      document: { select: { title: true } },
    },
    take: 10,
    orderBy: { confidence: 'desc' },
  });

  // Step 6: Get relevant Q&A pairs
  const qaPairs = await prisma.qAPair.findMany({
    where: {
      status: 'ACTIVE',
      domains: intentResult.domains.length > 0
        ? { some: { domain: { slug: { in: intentResult.domains } } } }
        : undefined,
    },
    take: 5,
  });

  // Step 7: Calculate overall confidence
  const searchConfidence = contextChunks.length > 0
    ? contextChunks[0].combinedScore
    : 0;
  const overallConfidence = Math.min(
    (intentResult.confidence * 0.4) + (searchConfidence * 0.6),
    1.0
  );

  // Step 8: Determine confidence level and whether clarification is needed
  let confidenceLevel: 'high' | 'medium' | 'low' | 'insufficient';
  let needsClarification = false;
  let suggestedClarification: string | undefined;

  if (overallConfidence >= CONFIDENCE_THRESHOLD_HIGH && contextChunks.length >= 2) {
    confidenceLevel = 'high';
  } else if (overallConfidence >= CONFIDENCE_THRESHOLD_MEDIUM && contextChunks.length >= 1) {
    confidenceLevel = 'medium';
  } else if (overallConfidence >= CONFIDENCE_THRESHOLD_LOW) {
    confidenceLevel = 'low';
    needsClarification = true;
    suggestedClarification = expandedQueries.suggestedClarification ||
      generateClarificationQuestion(question, intentResult);
  } else {
    confidenceLevel = 'insufficient';
    needsClarification = true;
    suggestedClarification = expandedQueries.suggestedClarification ||
      'Не могли бы вы уточнить ваш вопрос? Например, указать конкретный тип документа или услугу.';
  }

  // Step 9: Build context and generate answer
  const context = buildEnhancedContext(contextChunks, rules, qaPairs, confidenceLevel);

  const systemPrompt = ENHANCED_ANSWERING_PROMPT + `

ТЕКУЩИЙ УРОВЕНЬ УВЕРЕННОСТИ: ${confidenceLevel}
${needsClarification ? 'РЕКОМЕНДУЕТСЯ УТОЧНЕНИЕ' : ''}`;

  const answer =
    (await createChatCompletion({
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `Вопрос: ${question}

Доступные знания:
${context}

${confidenceLevel === 'insufficient'
              ? 'Информации недостаточно. Ответь, что не нашёл релевантной информации, и предложи уточнить вопрос.'
              : 'Предоставь полезный ответ на основе ТОЛЬКО приведённых знаний.'}`,
        },
      ],
      temperature: 0.3,
    })) || 'Не удалось сформировать ответ';

  // Build citations with relevance scores
  const citations = rules.slice(0, 5).map((r, i) => ({
    ruleCode: r.ruleCode,
    documentTitle: r.document?.title,
    quote: r.body.slice(0, 200) + (r.body.length > 200 ? '...' : ''),
    relevanceScore: Math.max(0.9 - (i * 0.1), 0.5),
  }));

  const result: EnhancedAnswerResult = {
    answer,
    confidence: overallConfidence,
    confidenceLevel,
    needsClarification,
    suggestedClarification,
    citations,
    domainsUsed: intentResult.domains,
    queryAnalysis: {
      originalQuery: question,
      expandedQueries: expandedQueries.variants,
      extractedEntities: entities,
      isAmbiguous: expandedQueries.isAmbiguous,
    },
  };

  if (includeDebug) {
    const avgSimilarity = chunks.length > 0
      ? chunks.reduce((sum, c) => sum + c.combinedScore, 0) / chunks.length
      : 0;

    result.debug = {
      chunks: contextChunks.map(c => ({
        content: c.content.slice(0, 200),
        semanticScore: c.semanticScore,
        keywordScore: c.keywordScore,
        combinedScore: c.combinedScore,
      })),
      intentClassification: intentResult,
      searchStats: {
        totalChunksSearched: chunks.length,
        avgSimilarity,
        maxSimilarity: chunks[0]?.combinedScore || 0,
      },
    };
  }

  return result;
}

function generateClarificationQuestion(
  question: string,
  intent: IntentClassification
): string {
  const clarifications: Record<string, string> = {
    price_query: 'Уточните, пожалуйста, какой именно документ или услугу вы имеете в виду?',
    procedure_query: 'Уточните, какую именно процедуру вы хотите узнать?',
    requirements_query: 'Какой тип документа вас интересует?',
    timeline_query: 'Для какой услуги вам нужны сроки?',
    general_info: 'Не могли бы вы уточнить ваш вопрос более конкретно?',
  };

  return clarifications[intent.intent] || clarifications.general_info;
}

function buildEnhancedContext(
  chunks: HybridSearchResult[],
  rules: { ruleCode: string; title: string; body: string }[],
  qaPairs: { question: string; answer: string }[],
  confidenceLevel: string
): string {
  let context = '';

  if (rules.length > 0) {
    context += '## Правила и регламенты\n';
    for (const rule of rules) {
      context += `[${rule.ruleCode}] ${rule.title}:\n${rule.body}\n\n`;
    }
  }

  if (qaPairs.length > 0) {
    context += '## Вопросы и ответы\n';
    for (const qa of qaPairs) {
      context += `В: ${qa.question}\nО: ${qa.answer}\n\n`;
    }
  }

  if (chunks.length > 0) {
    context += '## Фрагменты документов\n';
    for (const chunk of chunks) {
      const confidence = chunk.combinedScore >= 0.7 ? '(высокая релевантность)' :
        chunk.combinedScore >= 0.5 ? '(средняя релевантность)' : '';
      context += `${chunk.content} ${confidence}\n---\n`;
    }
  }

  if (!context) {
    return 'Релевантная информация не найдена в базе знаний.';
  }

  return context;
}

/**
 * Answer with conversation context
 */
export async function answerWithContext(
  question: string,
  sessionId: string,
  includeDebug: boolean = false
): Promise<EnhancedAnswerResult> {
  // Get recent conversation history
  const recentMessages = await prisma.chatMessage.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    take: 6,
  });

  // If there's conversation context, enhance the question
  if (recentMessages.length > 0) {
    const conversationContext = recentMessages
      .reverse()
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');

    // Check if current question is a follow-up
    const isFollowUp = await checkIfFollowUp(question, conversationContext);

    if (isFollowUp.isFollowUp && isFollowUp.expandedQuestion) {
      // Use the expanded question that includes context
      return answerQuestionEnhanced(isFollowUp.expandedQuestion, sessionId, includeDebug);
    }
  }

  return answerQuestionEnhanced(question, sessionId, includeDebug);
}

async function checkIfFollowUp(
  question: string,
  context: string
): Promise<{ isFollowUp: boolean; expandedQuestion?: string }> {
  const { createChatCompletion, normalizeJsonResponse } = await import('@/lib/ai/chat-provider');
  const content = await createChatCompletion({
    messages: [
      {
        role: 'system',
        content: `Определи, является ли вопрос продолжением диалога.
Если да - расширь вопрос, включив контекст из предыдущих сообщений.

Ответь в формате JSON:
{
  "isFollowUp": boolean,
  "expandedQuestion": "расширенный вопрос или null"
}`,
      },
      {
        role: 'user',
        content: `Контекст диалога:
${context}

Текущий вопрос: ${question}`,
      },
    ],
    responseFormat: 'json_object',
    temperature: 0.1,
    maxTokens: 1024,
  });
  if (!content) return { isFollowUp: false };

  try {
    const cleaned = normalizeJsonResponse(content);
    const parsed = JSON.parse(cleaned) as {
      isFollowUp?: boolean;
      expandedQuestion?: string | null;
    };
    const isFollowUp = parsed?.isFollowUp === true;
    const expandedQuestion =
      typeof parsed?.expandedQuestion === 'string' ? parsed.expandedQuestion : undefined;
    return expandedQuestion
      ? { isFollowUp, expandedQuestion }
      : { isFollowUp };
  } catch (error) {
    console.error('Follow-up detection parse failed:', error);
    return { isFollowUp: false };
  }
}
