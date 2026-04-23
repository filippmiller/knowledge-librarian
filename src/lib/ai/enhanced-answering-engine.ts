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
import { expandQuery, ExpandedQueries, ExtractedEntities, extractEntities } from './query-expansion';
import { classifyScenario, type ScenarioDecision } from '@/lib/knowledge/scenario-classifier';
import { ancestorsOf } from '@/lib/knowledge/scenarios';
import { verifyAnswer, type ConsistencyReport } from '@/lib/ai/consistency-gate';

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
  clarificationQuestion?: {
    question: string;
    options: string[];
  };
  primarySource?: {
    documentId: string;
    documentTitle: string;
    chunkContent: string;
    relevanceScore: number;
  };
  supplementarySources?: Array<{
    documentId: string;
    documentTitle: string;
    chunkContent: string;
    relevanceScore: number;
  }>;
  // Scenario decision gate output — present after Пачка A lands.
  // scenarioKey/scenarioLabel set when the gate picked a concrete scenario;
  // scenarioClarification set when the gate needs a user choice (and no
  // retrieval/synthesis was run — answer field will hold the prompt text).
  scenarioKey?: string;
  scenarioLabel?: string;
  scenarioClarification?: {
    atNodeKey: string;
    prompt: string;
    options: Array<{ id: string; label: string; targetScenarioKey: string }>;
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

const ENHANCED_ANSWERING_PROMPT = `Ты — ИИ-библиотекарь знаний для бюро переводов.

СЦЕНАРИЙ ПРОИЗВОДСТВА ОТВЕТА УЖЕ ЗАФИКСИРОВАН. Все приведённые ниже цитаты (правила, Q&A, фрагменты документов) принадлежат ЭТОМУ сценарию. Отвечай ТОЛЬКО на его основе.

═══ ЖЕЛЕЗНЫЕ ПРАВИЛА (нарушение недопустимо) ═══

1. **НЕ ВЫДУМЫВАЙ КОНКРЕТИКУ**, которой нет в цитатах:
   — адреса и телефоны копируй СИМВОЛ-В-СИМВОЛ из цитат
   — цены и числа — строго по источнику (не "примерно 5000", а "2500₽" как в цитате)
   — дни недели и часы работы — только если явно указаны в цитате
   — URL, фамилии, названия учреждений — ТОЛЬКО из цитат

2. **ПРИ ОТСУТСТВИИ ДАННЫХ** — не придумывай, а напиши "в источнике не указано" или просто не упоминай.

3. **НЕ ОБОБЩАЙ И НЕ ЭКСТРАПОЛИРУЙ**: если в источнике написано "2500₽ за документ" — не добавляй "значит 5000₽ за два"; если написано "нотариус СПб" — не расширяй до "нотариус СПб или ЛО".

4. **НЕ СМЕШИВАЙ** факты из разных цитат в один: если цитата 1 говорит "Вторник 10-12", а цитата 2 "Четверг 14-16", пиши их раздельно с указанием источника, не склеивай в "Вторник-четверг 10-16".

5. **НЕ РЕДАКТИРУЙ ПРАВИЛА**: не предупреждай "цена может быть устаревшей", не добавляй юридических оговорок, которых нет в источнике.

6. **Цитируй точно**: если факт важен — приведи дословно из цитаты в кавычках "...".

═══ ФОРМАТ ОТВЕТА ═══

- Язык ответа: русский, кратко и по делу.
- Ссылайся на правила формата [R-123] если они есть в цитатах.
- Если в цитатах есть **адрес/телефон/график/цена** — процитируй их дословно, не пересказывай.
- Структурируй длинные ответы подзаголовками, но не раздувай пустыми секциями.

═══ КАК ПОНИМАТЬ ЦИТАТЫ ═══

Все три типа источника (правила, Q&A, фрагменты документов) — равнозначные цитаты из базы знаний. Фрагменты документов — наиболее полный и точный источник; правила — извлечённые ключевые факты; Q&A — уже сформулированные готовые ответы.

Если по конкретному аспекту вопроса НЕТ ни одной цитаты — скажи это прямо ("в базе знаний не указано, уточните у …"), НЕ ВЫДУМЫВАЙ.`;

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
  limit: number,
  scenarioAncestors: string[] = []
): Promise<HybridSearchResult[]> {
  // Run searches in parallel
  const allResults = await Promise.all(
    queries.map(q => hybridSearch(q, domainSlugs, limit, 0.7, scenarioAncestors))
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
  console.log('[enhanced-answering] Starting for question:', question.substring(0, 100));

  // Step 0: Scenario decision gate — decides whether we have enough info to
  // pick a single procedure, need to ask the user, or should say "out of
  // scope". Runs BEFORE retrieval so ambiguous queries never trigger a
  // cross-scenario blended synthesis.
  console.log('[enhanced-answering] Step 0: Scenario decision gate...');
  let scenarioDecision: ScenarioDecision;
  try {
    scenarioDecision = await classifyScenario(question);
    console.log('[enhanced-answering] Scenario decision:', scenarioDecision.kind,
      'kind' in scenarioDecision && scenarioDecision.kind === 'scenario_clear' ? `→ ${scenarioDecision.scenarioKey}` :
      'kind' in scenarioDecision && scenarioDecision.kind === 'needs_clarification' ? `at ${scenarioDecision.atNodeKey}` : '');
  } catch (e) {
    console.warn('[enhanced-answering] Scenario gate failed, proceeding without filter:', e);
    scenarioDecision = { kind: 'out_of_scope', reasoning: 'gate error; fell through to open retrieval' };
  }

  // Short-circuit: if the gate needs clarification, skip retrieval entirely
  // and return a structured clarification response. The mini-app renders this
  // as buttons (Пачка B); legacy clients see the prompt text in `answer`.
  if (scenarioDecision.kind === 'needs_clarification') {
    return buildClarificationResult(question, scenarioDecision);
  }

  // Short-circuit: out of scope → honest "no data" result, no LLM synthesis.
  if (scenarioDecision.kind === 'out_of_scope') {
    return buildOutOfScopeResult(question, scenarioDecision);
  }

  // From here on we have a concrete leaf scenario. Threading its ancestor
  // chain into retrieval makes cross-scenario contamination impossible.
  const scenarioAncestors = ancestorsOf(scenarioDecision.scenarioKey);
  console.log('[enhanced-answering] Scenario-filtered retrieval:', scenarioAncestors.join(' > '));

  // Step 1: Expand query and extract entities in parallel (resilient - each can fail independently)
  console.log('[enhanced-answering] Step 1: Query expansion and intent classification...');
  const [expandedResult, entitiesResult, intentSettled] = await Promise.allSettled([
    expandQuery(question),
    extractEntities(question),
    classifyIntent(question),
  ]);

  const expandedQueries: ExpandedQueries = expandedResult.status === 'fulfilled'
    ? expandedResult.value
    : { original: question, variants: [], isAmbiguous: false };
  const entities: ExtractedEntities = entitiesResult.status === 'fulfilled'
    ? entitiesResult.value
    : { dates: [], prices: [], documentTypes: [], services: [] };
  const intentResult: IntentClassification = intentSettled.status === 'fulfilled'
    ? intentSettled.value
    : { intent: 'general_info', domains: [], confidence: 0.5 };

  if (expandedResult.status === 'rejected') console.warn('[enhanced-answering] Query expansion failed, using original query');
  if (entitiesResult.status === 'rejected') console.warn('[enhanced-answering] Entity extraction failed, using empty entities');
  if (intentSettled.status === 'rejected') console.warn('[enhanced-answering] Intent classification failed, using defaults');
  console.log('[enhanced-answering] Step 1 completed. Intent:', intentResult.intent, 'Domains:', intentResult.domains);

  // Step 2: Build query list for multi-query retrieval
  const allQueries = [question, ...expandedQueries.variants];
  console.log('[enhanced-answering] Step 2: Built', allQueries.length, 'query variants');

  // Step 3: Run hybrid multi-query search (scenario-filtered)
  console.log('[enhanced-answering] Step 3: Running hybrid search...');
  let chunks;
  try {
    chunks = await multiQuerySearch(
      allQueries,
      intentResult.domains,
      10,
      scenarioAncestors
    );
    console.log('[enhanced-answering] Step 3 completed. Found', chunks.length, 'chunks');
  } catch (error) {
    console.error('[enhanced-answering] Step 3 (hybrid search) failed:', error);
    throw error;
  }

  // Fetch document titles for source attribution
  const uniqueDocIds = [...new Set(chunks.map(c => c.documentId).filter(Boolean))];
  const docTitleMap = new Map<string, string>();
  if (uniqueDocIds.length > 0) {
    try {
      const docs = await prisma.document.findMany({
        where: { id: { in: uniqueDocIds } },
        select: { id: true, title: true },
      });
      for (const d of docs) docTitleMap.set(d.id, d.title);
    } catch (e) {
      console.warn('[enhanced-answering] Failed to fetch doc titles:', e);
    }
  }

  // Step 4: Select context chunks dynamically
  const contextChunks = selectContextChunks(chunks, 5);
  console.log('[enhanced-answering] Step 4: Selected', contextChunks.length, 'context chunks');

  // Group context chunks by document for source attribution
  const chunksByDoc = new Map<string, HybridSearchResult[]>();
  for (const chunk of contextChunks) {
    if (!chunk.documentId) continue;
    const existing = chunksByDoc.get(chunk.documentId) ?? [];
    existing.push(chunk);
    chunksByDoc.set(chunk.documentId, existing);
  }
  let primaryDocId = '';
  let bestDocScore = 0;
  for (const [docId, docChunks] of chunksByDoc) {
    const maxScore = Math.max(...docChunks.map(c => c.combinedScore));
    if (maxScore > bestDocScore) { bestDocScore = maxScore; primaryDocId = docId; }
  }

  // Step 5: Get relevant active rules (scenario-filtered when gate picked one)
  console.log('[enhanced-answering] Step 5: Fetching rules and QA pairs...');
  const scenarioWhere = scenarioAncestors.length > 0
    ? { OR: [{ scenarioKey: null }, { scenarioKey: { in: scenarioAncestors } }] }
    : {};
  let rules;
  try {
    rules = await prisma.rule.findMany({
    where: {
      status: 'ACTIVE',
      ...scenarioWhere,
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
  console.log('[enhanced-answering] Found', rules.length, 'rules');
  } catch (error) {
    console.error('[enhanced-answering] Step 5 (rules fetch) failed:', error);
    throw error;
  }

  // Step 6: Get relevant Q&A pairs (scenario-filtered)
  let qaPairs;
  try {
    qaPairs = await prisma.qAPair.findMany({
      where: {
        status: 'ACTIVE',
        ...scenarioWhere,
        domains: intentResult.domains.length > 0
          ? { some: { domain: { slug: { in: intentResult.domains } } } }
          : undefined,
      },
      take: 5,
    });
    console.log('[enhanced-answering] Found', qaPairs.length, 'QA pairs');
  } catch (error) {
    console.error('[enhanced-answering] Step 6 (QA pairs fetch) failed:', error);
    throw error;
  }

  // Step 7: Calculate overall confidence
  // Use semantic similarity (not RRF rank score) for confidence, since RRF produces tiny values (0.01-0.02) by design
  const bestSemanticScore = contextChunks.length > 0
    ? Math.max(...contextChunks.map(c => c.semanticScore))
    : 0;
  const overallConfidence = Math.min(
    (intentResult.confidence * 0.3) + (bestSemanticScore * 0.7),
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
  console.log('[enhanced-answering] Step 9: Generating answer with confidence level:', confidenceLevel);
  const context = buildEnhancedContext(contextChunks, rules, qaPairs, confidenceLevel);

  // Declare the chosen scenario explicitly so the synthesizer knows the
  // frame. This amplifies the evidence-only contract: "all your citations
  // belong to {{scenarioLabel}} — don't mention any other scenario".
  const scenarioPreamble =
    `СЦЕНАРИЙ: ${scenarioDecision.scenarioLabel}  (ключ: ${scenarioDecision.scenarioKey})\n` +
    `Все цитаты ниже относятся к этому сценарию. НЕ упоминай другие процедуры (например другие регионы или учреждения), даже если они существуют вообще.\n`;

  const systemPrompt = ENHANCED_ANSWERING_PROMPT;

  let answer: string;
  try {
    answer =
      (await createChatCompletion({
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `${scenarioPreamble}
Вопрос пользователя: ${question}

═══ ЦИТАТЫ ИЗ БАЗЫ ЗНАНИЙ ═══
${context}

═══ ЗАДАЧА ═══
${confidenceLevel === 'insufficient'
              ? 'Релевантных цитат не найдено. Ответь: "В базе знаний по этому вопросу нет данных." Ни в коем случае не выдумывай факты.'
              : 'Ответь на вопрос, СТРОГО опираясь только на приведённые цитаты. Адреса, телефоны, цены, графики работы — цитируй дословно. Если какой-то аспект не покрыт цитатами, так и скажи: "в источнике не указано". Не добавляй информацию, которой нет выше.'}`,
        },
      ],
      temperature: 0,
    })) || 'Не удалось сформировать ответ';
    console.log('[enhanced-answering] Answer generated successfully, length:', answer.length);
  } catch (error) {
    console.error('[enhanced-answering] Step 9 (answer generation) failed:', error);
    throw error;
  }

  // Step 9.5: Consistency gate — verify claims against source chunks. If any
  // claim isn't supported, regenerate ONCE with the unsupported claims flagged
  // as errors to remove. This catches the "Вторник-пятница 10-17" class of
  // hallucinations where the model invents a plausible schedule/address/price
  // that isn't actually in the retrieved chunks.
  let consistency: ConsistencyReport | undefined;
  if (contextChunks.length > 0 && confidenceLevel !== 'insufficient') {
    try {
      consistency = await verifyAnswer(
        answer,
        contextChunks.map((c) => c.content)
      );
      console.log(`[enhanced-answering] Consistency: ${consistency.claims.length} claims, ${consistency.unsupported.length} unsupported`);
      if (consistency.unsupported.length > 0) {
        // Log for telemetry — which specific phrases the model fabricated.
        console.warn('[enhanced-answering] Unsupported claims:',
          consistency.unsupported.map((c) => `"${c.claim}" (${c.reasoning ?? '?'})`).join(' | '));
        // Regenerate once with explicit instruction to remove the claims.
        const fixList = consistency.unsupported
          .map((c, i) => `${i + 1}. "${c.claim}" — ${c.reasoning ?? 'not in sources'}`)
          .join('\n');
        try {
          const revised = (await createChatCompletion({
            messages: [
              { role: 'system', content: ENHANCED_ANSWERING_PROMPT },
              {
                role: 'user',
                content: `${scenarioPreamble}
Вопрос пользователя: ${question}

═══ ЦИТАТЫ ИЗ БАЗЫ ЗНАНИЙ ═══
${context}

═══ ПРЕДЫДУЩИЙ ОТВЕТ (нужна правка) ═══
${answer}

═══ ФАКТЫ НЕ ПОДТВЕРЖДЕНЫ ЦИТАТАМИ — УДАЛИ ИЛИ ЗАМЕНИ НА "в источнике не указано" ═══
${fixList}

Перепиши ответ, убрав указанные неподтверждённые факты. Остальное сохрани максимально близко к оригиналу.`,
              },
            ],
            temperature: 0,
          })) ?? '';
          if (revised.trim().length > 0) {
            console.log('[enhanced-answering] Regenerated after consistency flag, new length:', revised.length);
            answer = revised;
          }
        } catch (e) {
          console.warn('[enhanced-answering] Regeneration failed, keeping original answer:', e);
        }
      }
    } catch (e) {
      console.warn('[enhanced-answering] Consistency gate failed (fail-open):', e);
    }
  }

  // Clarification is handled by the scenario decision gate upstream.
  const clarificationQuestion: { question: string; options: string[] } | undefined = undefined;

  // Build source references from context chunks
  const primarySource = primaryDocId ? {
    documentId: primaryDocId,
    documentTitle: docTitleMap.get(primaryDocId) ?? 'Документ',
    chunkContent: [...(chunksByDoc.get(primaryDocId) ?? [])]
      .sort((a, b) => b.combinedScore - a.combinedScore)[0]?.content?.slice(0, 400) ?? '',
    relevanceScore: bestDocScore,
  } : undefined;

  const supplementarySources = [...chunksByDoc.entries()]
    .filter(([docId]) => docId !== primaryDocId)
    .map(([docId, docChunks]) => {
      const bestChunk = [...docChunks].sort((a, b) => b.combinedScore - a.combinedScore)[0];
      return {
        documentId: docId,
        documentTitle: docTitleMap.get(docId) ?? 'Документ',
        chunkContent: bestChunk?.content?.slice(0, 400) ?? '',
        relevanceScore: bestChunk?.combinedScore ?? 0,
      };
    });

  // Build citations with REAL relevance scores.
  // Rules don't come with their own retrieval score (they're fetched by domain
  // filter, not ranked by the query). We approximate by matching each rule's
  // source document to the best chunk we retrieved for that document — so a
  // rule from the primary-source document gets its doc's score, a rule from a
  // supplementary doc gets that doc's score, and an unlinked rule gets 0.
  // This is honest even if imperfect: "scores reflect how close your question
  // was to the document this rule came from" — not an arbitrary rank decay.
  const docScoreByDocId = new Map<string, number>();
  for (const [docId, docChunks] of chunksByDoc) {
    docScoreByDocId.set(docId, Math.max(...docChunks.map((c) => c.combinedScore)));
  }
  const citations = rules.slice(0, 5).map((r) => ({
    ruleCode: r.ruleCode,
    documentTitle: r.document?.title,
    quote: r.body.slice(0, 200) + (r.body.length > 200 ? '...' : ''),
    relevanceScore: r.documentId ? (docScoreByDocId.get(r.documentId) ?? 0) : 0,
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
    clarificationQuestion,
    primarySource,
    supplementarySources,
    scenarioKey: scenarioDecision.scenarioKey,
    scenarioLabel: scenarioDecision.scenarioLabel,
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

  // Put document chunks FIRST since they're semantically matched to the question
  if (chunks.length > 0) {
    context += '## Фрагменты документов (найдены по вашему вопросу)\n';
    for (const chunk of chunks) {
      const confidence = chunk.semanticScore >= 0.6 ? '(высокая релевантность)' :
        chunk.semanticScore >= 0.4 ? '(средняя релевантность)' : '';
      context += `${chunk.content} ${confidence}\n---\n`;
    }
  }

  if (qaPairs.length > 0) {
    context += '## Вопросы и ответы\n';
    for (const qa of qaPairs) {
      context += `В: ${qa.question}\nО: ${qa.answer}\n\n`;
    }
  }

  if (rules.length > 0) {
    context += '## Правила и регламенты\n';
    for (const rule of rules) {
      context += `[${rule.ruleCode}] ${rule.title}:\n${rule.body}\n\n`;
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

// ────────────────────────────────────────────────────────────────────────────
// Decision-gate short-circuit builders — keep the shape of EnhancedAnswerResult
// so downstream consumers (API route, mini-app, Telegram bot) don't need
// special cases. The `answer` field carries the user-facing prompt; structured
// fields (scenarioClarification, scenarioKey) let UI render buttons.
// ────────────────────────────────────────────────────────────────────────────

function buildClarificationResult(
  question: string,
  decision: Extract<ScenarioDecision, { kind: 'needs_clarification' }>
): EnhancedAnswerResult {
  const { disambiguation } = decision;
  // User-facing answer = the disambiguation prompt + options, plain text so
  // legacy clients still show something useful. Buttons come from the
  // structured `scenarioClarification` field.
  const answer = [
    disambiguation.prompt,
    '',
    ...disambiguation.options.map((o, i) => `${i + 1}. ${o.label}`),
  ].join('\n');

  return {
    answer,
    confidence: 0,
    confidenceLevel: 'insufficient',
    needsClarification: true,
    suggestedClarification: disambiguation.prompt,
    citations: [],
    domainsUsed: [],
    queryAnalysis: {
      originalQuery: question,
      expandedQueries: [],
      extractedEntities: { dates: [], prices: [], documentTypes: [], services: [] },
      isAmbiguous: true,
    },
    clarificationQuestion: {
      question: disambiguation.prompt,
      options: disambiguation.options.map((o) => o.label),
    },
    scenarioClarification: {
      atNodeKey: decision.atNodeKey,
      prompt: disambiguation.prompt,
      options: disambiguation.options.map((o) => ({
        id: o.id,
        label: o.label,
        targetScenarioKey: o.targetScenarioKey,
      })),
    },
  };
}

function buildOutOfScopeResult(
  question: string,
  decision: Extract<ScenarioDecision, { kind: 'out_of_scope' }>
): EnhancedAnswerResult {
  return {
    answer:
      'В базе знаний нет данных по этому вопросу. Уточните, пожалуйста, о какой услуге идёт речь — апостиль, перевод, нотариальное заверение?',
    confidence: 0,
    confidenceLevel: 'insufficient',
    needsClarification: true,
    suggestedClarification: decision.reasoning,
    citations: [],
    domainsUsed: [],
    queryAnalysis: {
      originalQuery: question,
      expandedQueries: [],
      extractedEntities: { dates: [], prices: [], documentTypes: [], services: [] },
      isAmbiguous: false,
    },
  };
}
