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
import { expandAbbreviations, selectKeyTerms } from '@/lib/knowledge/glossary';
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
    rules?: { ruleCode: string; documentTitle: string | null }[];
    qaPairs?: { id: string; question: string }[];
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
  answerSource?: 'knowledge_base' | 'general_ai' | 'deterministic_guardrail';
  requiresHumanReview?: boolean;
  consistency?: {
    allSupported: boolean;
    unsupportedCount: number;
    verificationFailed: boolean;
    regenerated: boolean;
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

2а. **ПРОВЕРЯЙ ГЛАВНОЕ БИЗНЕС-УТВЕРЖДЕНИЕ**: прежде чем писать "мы делаем", "можно заказать" или "услуга доступна", найди прямое подтверждение именно этой возможности в цитатах. Похожая услуга, общая редактура или общий регламент не являются подтверждением.

2б. **НЕ ДОБАВЛЯЙ ЦЕНЫ И СРОКИ, ЕСЛИ ПОЛЬЗОВАТЕЛЬ ИХ НЕ СПРАШИВАЛ**. Даже если они случайно присутствуют в найденном фрагменте, они не относятся к ответу и могут быть динамическими.

3. **НЕ ОБОБЩАЙ И НЕ ЭКСТРАПОЛИРУЙ**: если в источнике написано "2500₽ за документ" — не добавляй "значит 5000₽ за два"; если написано "нотариус СПб" — не расширяй до "нотариус СПб или ЛО".

4. **НЕ СМЕШИВАЙ** факты из разных цитат в один: если цитата 1 говорит "Вторник 10-12", а цитата 2 "Четверг 14-16", пиши их раздельно с указанием источника, не склеивай в "Вторник-четверг 10-16".

5. **НЕ РЕДАКТИРУЙ ПРАВИЛА**: не предупреждай "цена может быть устаревшей", не добавляй юридических оговорок, которых нет в источнике.

6. **Цитируй точно**: если факт важен — приведи дословно из цитаты в кавычках "...".

═══ ФОРМАТ ОТВЕТА ═══

- Язык ответа: русский, кратко и по делу.
- Пиши обычным текстом без Markdown-заголовков и символов **, ##, ---.
- Ссылайся на правила формата [R-123] если они есть в цитатах.
- Если в цитатах есть **адрес/телефон/график/цена** — процитируй их дословно, не пересказывай.
- Структурируй длинные ответы подзаголовками, но не раздувай пустыми секциями.

═══ КАК ПОНИМАТЬ ЦИТАТЫ ═══

Все три типа источника (правила, Q&A, фрагменты документов) — равнозначные цитаты из базы знаний. Фрагменты документов — наиболее полный и точный источник; правила — извлечённые ключевые факты; Q&A — уже сформулированные готовые ответы.

Если по конкретному аспекту вопроса НЕТ ни одной цитаты — скажи это прямо ("в базе знаний не указано, уточните у …"), НЕ ВЫДУМЫВАЙ.`;

const GENERAL_KNOWLEDGE_FALLBACK_PROMPT = `Ты — экспертный помощник бюро переводов.

База знаний не дала прямого уверенного ответа. Используй ОБЩЕЕ профессиональное знание только для вопросов по услугам бюро: апостиль, легализация, нотариальные документы, ЗАГС, МВД, переводы.

Правила:
- Не выдумывай адреса, телефоны, цены, сроки и графики.
- Если вопрос юридически или операционно зависит от типа документа, прямо назови условие.
- Если уверенности нет, скажи, что нужен ручной разбор.
- Отвечай кратко и практически.
- Не представляй ответ как факт из базы знаний.

Ответ СТРОГО JSON:
{
  "canAnswer": true | false,
  "answer": "краткий ответ пользователю",
  "confidence": 0.0,
  "requiresHumanReview": true | false,
  "reasoning": "коротко почему"
}`;

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

  // RRF is a rank-fusion score, not an absolute relevance measurement. First
  // require real semantic support or a strong keyword match; otherwise "the
  // best five bad results" would still be sent to the synthesizer.
  const eligible = chunks.filter(
    (chunk) => chunk.semanticScore >= 0.4 || chunk.keywordScore >= 0.65
  );
  if (eligible.length === 0) return [];

  // Find the "elbow" in similarity scores
  const scores = eligible.map(c => c.combinedScore);
  const maxScore = scores[0];

  // Include chunks with score >= 60% of max score, up to maxChunks
  const threshold = maxScore * 0.6;

  return eligible
    .filter(c => c.combinedScore >= threshold)
    .slice(0, maxChunks);
}

export function extractSearchTerms(value: string): string[] {
  const normalized = value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s()-]/gu, ' ');

  const words = normalized
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 3);

  const expanded = words.flatMap((word) => {
    const variants = [word];
    if (word.length >= 6) variants.push(word.slice(0, -1));
    if (word.length >= 8) variants.push(word.slice(0, -2));
    return variants;
  });

  return [...new Set(expanded)];
}

export function scoreText(value: string, terms: string[]): number {
  const text = value.toLowerCase().replace(/ё/g, 'е');
  let score = 0;
  for (const term of terms) {
    if (!text.includes(term)) continue;
    score += term.length >= 6 ? 3 : 1;
    if (/загс|свидетельств|справк|документ|брак|рожд|смерт/.test(term)) {
      score += 2;
    }
  }
  return score;
}

function rankByQuestion<T>(
  items: T[],
  question: string,
  getText: (item: T) => string,
  getBoost: (item: T) => number = () => 0,
  // Optional "summary field" (a rule's title, a QAPair's question) scored AGAIN
  // with the same terms — i.e. field boosting (title^2). The summary is the
  // human-curated statement of what the unit is ABOUT, so matching it is a far
  // stronger relevance signal than matching the verbose body. Without this, a
  // concise on-point rule ("Апостиль на документы МВД в городе выдачи") loses to
  // verbose rules that merely echo more query vocabulary.
  getSummary: (item: T) => string = () => ''
): T[] {
  const terms = extractSearchTerms(question);
  if (terms.length === 0) return items;

  return items
    .map((item) => ({
      item,
      score: scoreText(getText(item), terms) + scoreText(getSummary(item), terms) + getBoost(item),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ item }) => item);
}

/**
 * Search-term overlap between a question and a candidate, as the fraction of the
 * SHORTER side's terms that are shared (1.0 = the salient terms all match). Used
 * to recognise that a closely-matching approved QAPair IS the knowledge-base
 * answer even when no document chunks were retrieved — without this a QA-only
 * answer scores confidence 0 from chunks alone and wrongly falls through to
 * general_ai, defeating the self-improving loop.
 */
function questionTermOverlap(question: string, candidate: string): number {
  const qTerms = new Set(extractSearchTerms(question));
  const cTerms = new Set(extractSearchTerms(candidate));
  if (qTerms.size === 0 || cTerms.size === 0) return 0;
  let shared = 0;
  for (const t of qTerms) if (cTerms.has(t)) shared++;
  return shared / Math.min(qTerms.size, cTerms.size);
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
    const guardrail = buildDeterministicGuardrailResult(question);
    if (guardrail) return guardrail;
    return buildClarificationResult(question, scenarioDecision);
  }

  // out_of_scope handling. The classifier marks a question out_of_scope when
  // it doesn't map to a concrete apostille scenario — but the scenario tree
  // only covers apostille (ЗАГС/нотариалка/опека). Lots of legitimate bureau
  // questions (education apostille, criminal-record certs, prices, translation)
  // land here even though the KB DOES hold the answer. So:
  //   1) deterministic region guardrail still wins (Moscow↔СПб);
  //   2) if the question is about a bureau topic at all → reclassify to an
  //      OPEN knowledge lookup over the whole KB (general_ai stays a last
  //      resort, only if open retrieval finds nothing — handled downstream);
  //   3) only genuinely off-topic questions (no bureau keyword: weather,
  //      crypto, …) get the honest "no data" short-circuit, never general_ai.
  if (scenarioDecision.kind === 'out_of_scope') {
    const guardrail = buildDeterministicGuardrailResult(question);
    if (guardrail) return guardrail;

    if (!isBureauTopic(question)) {
      return buildOutOfScopeResult(question, scenarioDecision);
    }

    console.log('[enhanced-answering] out_of_scope but bureau topic → open knowledge lookup');
    scenarioDecision = {
      kind: 'knowledge_lookup',
      label: 'Открытый поиск по базе знаний',
      reasoning: `out_of_scope reclassified to open lookup (bureau topic): ${scenarioDecision.reasoning}`,
    };
  }

  const openKnowledgeLookup = scenarioDecision.kind === 'knowledge_lookup';
  const scenarioAncestors = scenarioDecision.kind === 'scenario_clear'
    ? ancestorsOf(scenarioDecision.scenarioKey)
    : [];
  const scenarioLabelForAnswer = scenarioDecision.kind === 'scenario_clear'
    ? scenarioDecision.scenarioLabel
    : scenarioDecision.label;
  const scenarioKeyForAnswer = scenarioDecision.kind === 'scenario_clear'
    ? scenarioDecision.scenarioKey
    : undefined;
  console.log(
    '[enhanced-answering] Retrieval scope:',
    openKnowledgeLookup ? 'open knowledge lookup' : scenarioAncestors.join(' > ')
  );

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
  const relevanceText = [question, ...expandedQueries.variants, ...entities.documentTypes, ...entities.services].join(' ');

  // Step 2: Build query list for multi-query retrieval.
  // Include the abbreviation-expanded question so keyword search also matches
  // the canonical term (e.g. user typed "СОР" → also search "свидетельство о
  // рождении"). Deduped below via the Set.
  const allQueries = [...new Set([
    question,
    expandAbbreviations(question),
    ...expandedQueries.variants,
    ...getDeterministicQueryVariants(question),
  ])];
  console.log('[enhanced-answering] Step 2: Built', allQueries.length, 'query variants');

  // Step 3: Run hybrid multi-query search (scenario-filtered, no domain
  // filter — see Step 5 comment for why domains are now ignored at retrieval).
  console.log('[enhanced-answering] Step 3: Running hybrid search...');
  let chunks;
  try {
    chunks = await multiQuerySearch(
      allQueries,
      [], // domains disabled — scenario filter does the narrowing
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
  // Rank documents by SEMANTIC similarity, not the RRF combinedScore. RRF
  // scores are tiny and nearly flat (~0.015 across all results), so picking
  // the "primary" doc by combinedScore was effectively random — it routinely
  // surfaced an off-topic doc (e.g. the МВД instruction under a КЗАГС answer).
  // semanticScore has real spread (0.4–0.6) and tracks topical relevance.
  // Pick the primary document by AGGREGATE semantic relevance (sum of its
  // retrieved chunks' semantic scores), not a single best chunk. A document
  // that contributed several relevant chunks is far more likely the one the
  // answer is actually built from than one with a single high-but-isolated
  // chunk (the old max-chunk rule sometimes surfaced an off-topic doc whose
  // one chunk happened to score high). `bestDocScore` stays the chosen doc's
  // MAX semantic score (0..1) so the displayed relevanceScore stays sane.
  let primaryDocId = '';
  let bestAggregate = 0;
  let bestDocScore = 0;
  for (const [docId, docChunks] of chunksByDoc) {
    const aggregate = docChunks.reduce((sum, c) => sum + c.semanticScore, 0);
    if (aggregate > bestAggregate) {
      bestAggregate = aggregate;
      primaryDocId = docId;
      bestDocScore = Math.max(...docChunks.map(c => c.semanticScore));
    }
  }

  // Step 5: Get relevant active rules (scenario-filtered).
  //
  // NB: we deliberately DO NOT filter by intentResult.domains anymore. Audit
  // on 2026-04-23 showed the existing Domain assignments are over-broad —
  // notary/legal_compliance/pricing/general_ops each cover 161 of 163 rules
  // (every rule gets ~4 domains tagged at extraction time), making the
  // domain filter equivalent to no filter. Scenario filtering does the
  // meaningful narrowing; domains were adding zero signal and creating a
  // false sense of precision. Intent classification still returns domains
  // for logging/debugging purposes, but they no longer gate retrieval.
  console.log('[enhanced-answering] Step 5: Fetching rules and QA pairs...');
  const scenarioWhere = scenarioAncestors.length > 0
    ? { OR: [{ scenarioKey: null }, { scenarioKey: { in: scenarioAncestors } }] }
    : {};
  let rules;
  try {
    // Two candidate pools, merged: (a) keyword-prefiltered — rules whose body
    // contains the question's significant terms, so a rare entity (e.g. a
    // specific country buried in a 51-rule "не нужен апостиль" list) becomes a
    // candidate instead of being dropped by the confidence cap; (b) top by
    // confidence — the high-quality general rules. Without (a), a country-list
    // rule competed against ALL ~600 active rules and lost.
    // selectKeyTerms keeps long terms AND domain-critical short acronyms
    // (МВД/ЗАГС/СОР/МЮ/...). The old `length >= 5` filter silently dropped those
    // acronyms — the MOST discriminating tokens — so an acronym-keyed rule never
    // entered this pool (e.g. R-963 "Апостиль на документы МВД в городе выдачи").
    const keyTerms = selectKeyTerms(extractSearchTerms(relevanceText));
    // Fetch PER TERM (not one big OR with a confidence cap). A single OR fetch
    // capped at N gets flooded by generic terms ("документ", "апостиль") that
    // match hundreds of rules, so a rare entity ("Казахстан", matched by only a
    // few rules) is cut by the cap. Per-term, each rare term's handful of rules
    // is always included.
    const perTerm = await Promise.all(
      keyTerms.map((t) =>
        prisma.rule.findMany({
          where: { status: 'ACTIVE', ...scenarioWhere, body: { contains: t, mode: 'insensitive' as const } },
          include: { document: { select: { title: true } } },
          take: 25,
          orderBy: { confidence: 'desc' },
        })
      )
    );
    const keywordMatched = perTerm.flat();
    const byConfidence = await prisma.rule.findMany({
      where: { status: 'ACTIVE', ...scenarioWhere },
      include: { document: { select: { title: true } } },
      take: 100,
      orderBy: { confidence: 'desc' },
    });
    const seenRule = new Set<string>();
    const ruleCandidates = [...keywordMatched, ...byConfidence].filter((r) => {
      if (seenRule.has(r.id)) return false;
      seenRule.add(r.id);
      return true;
    });
    rules = rankByQuestion(
      ruleCandidates,
      relevanceText,
      (rule) => `${rule.ruleCode} ${rule.title} ${rule.body} ${rule.document?.title ?? ''}`,
      (rule) => rule.confidence >= 1 ? 2 : 0,
      (rule) => rule.title // title^2 field boost — curated summary of the rule
    ).slice(0, 10);
    console.log('[enhanced-answering] Found', rules.length, 'rules from', ruleCandidates.length, 'candidates');
  } catch (error) {
    console.error('[enhanced-answering] Step 5 (rules fetch) failed:', error);
    throw error;
  }

  // Step 6: Get relevant Q&A pairs (scenario-filtered, no domain filter).
  // Same keyword-prefilter as rules: without it, a freshly approved QAPair (or
  // any specific one) can be dropped by the `take` cap when there are many
  // active pairs — which would break the self-improving loop (approve a draft,
  // ask again, still not answered from base).
  let qaPairs;
  try {
    const qaKeyTerms = selectKeyTerms(extractSearchTerms(relevanceText));
    const qaPerTerm = await Promise.all(
      qaKeyTerms.map((t) =>
        prisma.qAPair.findMany({
          where: {
            status: 'ACTIVE',
            ...scenarioWhere,
            OR: [
              { question: { contains: t, mode: 'insensitive' as const } },
              { answer: { contains: t, mode: 'insensitive' as const } },
            ],
          },
          take: 25,
        })
      )
    );
    const qaRecent = await prisma.qAPair.findMany({
      where: { status: 'ACTIVE', ...scenarioWhere },
      take: 100,
      orderBy: { createdAt: 'desc' },
    });
    const seenQa = new Set<string>();
    const qaCandidates = [...qaPerTerm.flat(), ...qaRecent].filter((q) => {
      if (seenQa.has(q.id)) return false;
      seenQa.add(q.id);
      return true;
    });
    qaPairs = rankByQuestion(
      qaCandidates,
      relevanceText,
      (qa) => `${qa.question} ${qa.answer}`,
      () => 0,
      (qa) => qa.question // question^2 field boost — the QAPair's curated summary
    ).slice(0, 5);
    console.log('[enhanced-answering] Found', qaPairs.length, 'QA pairs from', qaCandidates.length, 'candidates');
  } catch (error) {
    console.error('[enhanced-answering] Step 6 (QA pairs fetch) failed:', error);
    throw error;
  }

  // Strong QA support: how closely does the best retrieved QAPair's QUESTION
  // match the user's question? A high overlap means an admin-approved pair
  // already answers this — treat it as authoritative KB evidence so the answer
  // is given confidently from the base and never bounced to general_ai. This is
  // what actually closes the self-improving loop for QA-only answers (no chunks).
  const bestQaMatch = qaPairs.length > 0
    ? Math.max(...qaPairs.map((qa) => questionTermOverlap(question, qa.question)))
    : 0;
  const hasStrongQaMatch = bestQaMatch >= 0.7;

  // Step 7: Calculate overall confidence.
  // Primary signal: best SEMANTIC similarity of the retrieved chunks (RRF rank
  // scores are tiny/flat ~0.01-0.02 by design, so they're useless here).
  // We deliberately DROPPED the old `intentResult.confidence`
  // term: it was the intent classifier's self-assessment, which does not track
  // whether the ANSWER is correct (pure noise). Calibrated to stay close to the
  // Confidence is intentionally not increased just because several chunks were
  // returned: correlated or off-topic chunks are not independent evidence.
  const bestSemanticScore = contextChunks.length > 0
    ? Math.max(...contextChunks.map(c => c.semanticScore))
    : 0;
  const overallConfidence = Math.min(
    // A strong QA match contributes its own confidence floor so the reported
    // number stays honest when the answer rests on a QAPair, not doc chunks.
    Math.max(bestSemanticScore, hasStrongQaMatch ? bestQaMatch : 0),
    1.0
  );

  // Step 8: Determine confidence level and whether clarification is needed
  let confidenceLevel: 'high' | 'medium' | 'low' | 'insufficient';
  let needsClarification = false;
  let suggestedClarification: string | undefined;

  if (hasStrongQaMatch) {
    // An admin-approved, closely-matching QAPair is authoritative KB content —
    // answer confidently from it. With corroborating chunks it's 'high', on the
    // QA pair alone it's 'medium' (enough to skip clarification and the general
    // fallback, so the loop closes).
    confidenceLevel = contextChunks.length >= 2 ? 'high' : 'medium';
  } else if (overallConfidence >= CONFIDENCE_THRESHOLD_HIGH && contextChunks.length >= 2) {
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
  const context = buildEnhancedContext(contextChunks, rules, qaPairs);

  if (confidenceLevel === 'insufficient' && !hasStrongQaMatch && shouldUseGeneralKnowledgeFallback(question)) {
    const guardrail = buildDeterministicGuardrailResult(question);
    if (guardrail) return guardrail;

    return answerFromGeneralKnowledgeFallback(
      question,
      `retrieval insufficient; scenario=${scenarioLabelForAnswer}; chunks=${contextChunks.length}; rules=${rules.length}; qa=${qaPairs.length}`,
      sessionId
    );
  }

  // Declare the chosen scenario explicitly so the synthesizer knows the
  // frame. This amplifies the evidence-only contract: "all your citations
  // belong to {{scenarioLabel}} — don't mention any other scenario".
  const scenarioPreamble = openKnowledgeLookup
    ? `СЦЕНАРИЙ: ${scenarioLabelForAnswer}\nВсе цитаты ниже найдены открытым поиском по базе знаний. Отвечай только по приведенным цитатам.\n`
    : `СЦЕНАРИЙ: ${scenarioLabelForAnswer}  (ключ: ${scenarioKeyForAnswer})\n` +
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
  // that isn't actually in the retrieved chunks. Every finding is persisted
  // to HallucinationLog for post-hoc analysis (which scenarios are worst,
  // does regeneration actually fix them, etc.).
  let consistency: ConsistencyReport | undefined;
  const initialAnswerForLog = answer;
  let regenerated = false;
  if (contextChunks.length > 0 && confidenceLevel !== 'insufficient') {
    try {
      // Verify against the FULL synthesis context — chunks AND rules AND Q&A —
      // not just chunks. The synthesizer legitimately uses rules and Q&A as
      // sources (see buildEnhancedContext), so checking against chunks alone
      // falsely flags rule-sourced facts (e.g. the "5 рабочих дней" срок from a
      // rule, or МЮ prices from R-352/R-353) as hallucinations — and the
      // regeneration step can then strip a CORRECT fact, making the answer wrong
      // ("срок не указан" when it IS specified in a rule).
      const verificationSources = [
        ...contextChunks.map((c) => c.content),
        ...rules.map((r) => `[${r.ruleCode}] ${r.title}: ${r.body}`),
        ...qaPairs.map((q) => `${q.question} ${q.answer}`),
      ];
      consistency = await verifyAnswer(answer, verificationSources);
      console.log(`[enhanced-answering] Consistency: ${consistency.claims.length} claims, ${consistency.unsupported.length} unsupported`);
      const detectedUnsupported = consistency.unsupported;
      if (detectedUnsupported.length > 0) {
        console.warn('[enhanced-answering] Unsupported claims:',
          detectedUnsupported.map((c) => `"${c.claim}" (${c.reasoning ?? '?'})`).join(' | '));
        const fixList = detectedUnsupported
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
            regenerated = true;
            // The revised answer is a new artifact. It must pass the same gate;
            // otherwise one regeneration could silently replace a detected
            // hallucination with a different unsupported claim.
            consistency = await verifyAnswer(answer, verificationSources);
          }
        } catch (e) {
          console.warn('[enhanced-answering] Regeneration failed, keeping original answer:', e);
        }

        // Persist telemetry — fire-and-forget, never block the response.
        prisma.hallucinationLog.create({
          data: {
            sessionId: sessionId ?? null,
            question,
            scenarioKey: scenarioKeyForAnswer ?? null,
            initialAnswer: initialAnswerForLog,
            regeneratedAnswer: regenerated ? answer : null,
            unsupportedClaims: detectedUnsupported as unknown as object,
            unsupportedCount: detectedUnsupported.length,
            regenerated,
          },
        }).catch((e) => console.warn('[enhanced-answering] HallucinationLog write failed:', e));
      }
    } catch (e) {
      console.warn('[enhanced-answering] Consistency gate failed; requiring human review:', e);
      consistency = {
        allSupported: false,
        claims: [],
        unsupported: [],
        verificationFailed: true,
        raw: String(e),
      };
    }
  }

  // Clarification is handled by the scenario decision gate upstream.
  const clarificationQuestion: { question: string; options: string[] } | undefined = undefined;
  const requiresHumanReview = Boolean(
    consistency?.verificationFailed || consistency?.unsupported.length
  );

  // Build source references from context chunks
  const primarySource = primaryDocId ? {
    documentId: primaryDocId,
    documentTitle: docTitleMap.get(primaryDocId) ?? 'Документ',
    chunkContent: [...(chunksByDoc.get(primaryDocId) ?? [])]
      .sort((a, b) => b.semanticScore - a.semanticScore)[0]?.content?.slice(0, 400) ?? '',
    relevanceScore: bestDocScore,
  } : undefined;

  const supplementarySources = [...chunksByDoc.entries()]
    .filter(([docId]) => docId !== primaryDocId)
    .map(([docId, docChunks]) => {
      const bestChunk = [...docChunks].sort((a, b) => b.semanticScore - a.semanticScore)[0];
      return {
        documentId: docId,
        documentTitle: docTitleMap.get(docId) ?? 'Документ',
        chunkContent: bestChunk?.content?.slice(0, 400) ?? '',
        relevanceScore: bestChunk?.semanticScore ?? 0,
      };
    })
    .sort((a, b) => b.relevanceScore - a.relevanceScore);

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
    docScoreByDocId.set(docId, Math.max(...docChunks.map((c) => c.semanticScore)));
  }
  // PROVENANCE: cite only rules whose source document actually contributed a
  // chunk to the synthesis context, ordered by that document's relevance. This
  // makes "📚 Источники" match the answer instead of surfacing a high-ranked-
  // but-unused rule from another topic (the education-rule-under-a-КЗАГС-answer
  // bug). If no rule maps to a context document (rare), fall back to the top
  // ranked rules so the source list is never empty.
  const contextDocIds = new Set(chunksByDoc.keys());
  const provenanceRules = rules
    .filter((r) => r.documentId != null && contextDocIds.has(r.documentId))
    .sort((a, b) => (docScoreByDocId.get(b.documentId ?? '') ?? 0) - (docScoreByDocId.get(a.documentId ?? '') ?? 0));
  const citationRules = (provenanceRules.length > 0 ? provenanceRules : rules).slice(0, 5);
  const citations = citationRules.map((r) => ({
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
    scenarioKey: scenarioKeyForAnswer,
    scenarioLabel: scenarioLabelForAnswer,
    answerSource: 'knowledge_base',
    requiresHumanReview,
    consistency: consistency ? {
      allSupported: consistency.allSupported,
      unsupportedCount: consistency.unsupported.length,
      verificationFailed: consistency.verificationFailed === true,
      regenerated,
    } : undefined,
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
      // Retrieved rules/QA (codes + source doc) — lets diagnostics confirm WHICH
      // knowledge units reached the synthesizer, independent of what the LLM
      // chose to quote in citations.
      rules: rules.map((r) => ({ ruleCode: r.ruleCode, documentTitle: r.document?.title ?? null })),
      qaPairs: qaPairs.map((qa) => ({ id: qa.id, question: qa.question.slice(0, 80) })),
      searchStats: {
        totalChunksSearched: chunks.length,
        avgSimilarity,
        maxSimilarity: chunks[0]?.combinedScore || 0,
      },
    };
  }

  return result;
}

function buildDeterministicGuardrailResult(question: string): EnhancedAnswerResult | null {
  // All regexes use /iu flags and test the ORIGINAL question directly.
  // Never call normalizeRussianText() here — its toLowerCase() silently corrupts
  // Cyrillic to U+FFFD on some Alpine Linux / Node 20 (small-icu) deployments.
  const mentionsApostille = /апостил/iu.test(question);
  const mentionsSpb = /санкт\s*петербург|петербург|(?:^|[^а-яё])спб(?:[^а-яё]|$)/iu.test(question);
  const mentionsMoscow = /москв/iu.test(question);
  const asksHowOrCan =
    /как|можн|нельзя|получится|сдела|постав|простав|подат|оформ/iu.test(question);
  const mentionsEducation =
    /образован|диплом|аттестат|вуз|университет|колледж|школ/iu.test(question);

  // "Другой регион" path: a ЗАГС document issued OUTSIDE СПб/ЛО (the user picked
  // the "Другой регион" option or named a non-local city). The bureau apostilles
  // ЗАГС ORIGINALS only at the place of issue it serves (СПб/ЛО); an original
  // from another region must be apostilled THERE. Explain that + offer the
  // notarized-copy alternative. Fires only when it's NOT the mirror case (which
  // mentions both СПб and Москва and has its own directional answer below).
  const mentionsOtherRegion = /друг[а-яё]*\s+регион|друг[а-яё]*\s+город/iu.test(question);
  const mentionsOtherCity =
    /москв|перм|нижн|новосиб|екатеринбург|казан|самар|ростов|краснодар|воронеж|челябинск|волгоград|саратов|тюмен|иркутск|омск/iu.test(question);
  const zagsContext =
    /загс|свидетельств|(?:^|[^а-яё])со[рбс](?:[^а-яё]|$)|рожден|брак|растор|смерт|перемен.{0,4}имен|отцовств/iu.test(question);
  const isLocalIssue = mentionsSpb || /ленинградск|лен\.?\s*обл/iu.test(question);
  if (mentionsApostille && zagsContext && (mentionsOtherRegion || (mentionsOtherCity && !isLocalIssue))) {
    const answer = [
      'Апостиль на оригинал свидетельства ЗАГС ставится по месту выдачи документа — в том регионе, где он выдан. Наше бюро ставит апостиль на оригиналы ЗАГС только для документов, выданных в Санкт-Петербурге и Ленинградской области.',
      '',
      'Если документ выдан в другом регионе (например, в Москве), апостиль на оригинал нужно ставить там, по месту выдачи — мы этого сделать не можем.',
      '',
      'Что мы можем предложить: апостиль на НОТАРИАЛЬНУЮ КОПИЮ документа (если принимающая сторона за рубежом допускает апостиль на копию, а не на оригинал) — это отдельная процедура. Уточните требования принимающей страны/органа.',
    ].join('\n');
    return {
      answer,
      confidence: 0.9,
      confidenceLevel: 'medium',
      needsClarification: false,
      citations: [
        {
          documentTitle: 'Операционный guardrail',
          quote: 'Апостиль на оригинал ЗАГС ставится по месту выдачи; для документов из других регионов — только апостиль на нотариальную копию.',
          relevanceScore: 0.9,
        },
      ],
      domainsUsed: ['legal_compliance'],
      queryAnalysis: {
        originalQuery: question,
        expandedQueries: [],
        extractedEntities: { dates: [], prices: [], documentTypes: ['свидетельство'], services: ['апостиль'] },
        isAmbiguous: false,
      },
      answerSource: 'deterministic_guardrail',
      requiresHumanReview: false,
    };
  }

  if (!mentionsApostille || !mentionsSpb || !mentionsMoscow || !asksHowOrCan || mentionsEducation) {
    return null;
  }

  // Direction matters: an original is apostilled by its PLACE OF ISSUE. The old
  // canned answer always assumed a Moscow-issued document, so for the mirror
  // case ("выдан в СПб, апостилировать в Москве") it confidently described the
  // wrong scenario. Detect the issue place from the first city that follows an
  // issue verb (выдан/составлен/…); the other city is the requested target.
  // NB: \w does NOT match Cyrillic in JS, so use [а-я]* for word tails
  // (text is already lowercased + ё→е by normalizeRussianText).
  const issueMatch = question.match(
    /(?:выдан[а-яё]*|составлен[а-яё]*|получен[а-яё]*|оформлен[а-яё]*|выписан[а-яё]*|выдал[а-яё]*)\s+(?:в\s+|во\s+)?(москв[а-яё]*|санкт[-\s]?петербург[а-яё]*|петербург[а-яё]*|спб)/iu
  );
  const issuePlace: 'Москве' | 'Санкт-Петербурге' | null = issueMatch
    ? (/москв/i.test(issueMatch[1]) ? 'Москве' : 'Санкт-Петербурге')
    : null;
  const targetPlace = issuePlace === 'Москве' ? 'Санкт-Петербурге' : 'Москве';

  const answer = issuePlace
    ? [
        `Апостиль на оригинал ставится по месту выдачи документа. Документ выдан в ${issuePlace} — значит, апостиль на него ставится в ${issuePlace}, а в ${targetPlace} поставить апостиль на этот оригинал нельзя.`,
        '',
        'Ориентир: обычные документы ЗАГС, МВД и документы для Минюста подаются по месту выдачи/составления документа.',
        '',
        `В ${targetPlace} можно разбирать только альтернативный вариант, если принимающая сторона согласна на апостиль не на оригинал, а на нотариальную копию/нотариальный документ. Это уже другая процедура, её нужно проверять по требованиям страны/органа.`,
      ].join('\n')
    : [
        // Direction not stated → give the correct principle without asserting
        // which city is which (never invent a direction).
        'Апостиль на оригинал ставится по месту выдачи/составления документа: где документ выдан — там и апостилируется. Поставить апостиль на оригинал в другом регионе (Москва ↔ Санкт-Петербург) нельзя.',
        '',
        'Ориентир: обычные документы ЗАГС, МВД и документы для Минюста подаются по месту выдачи. Уточните, в каком городе выдан документ — апостиль ставится именно там.',
        '',
        'Перенести процедуру в другой город можно только через альтернативу: апостиль на нотариальную копию/нотариальный документ (если принимающая сторона это допускает) — это отдельная процедура.',
      ].join('\n');

  return {
    answer,
    confidence: 0.9,
    confidenceLevel: 'medium',
    needsClarification: false,
    citations: [
      {
        documentTitle: 'Операционный guardrail',
        quote: 'Документы апостилируются по месту выдачи/составления; московский оригинал нельзя апостилировать в Санкт-Петербурге.',
        relevanceScore: 0.9,
      },
    ],
    domainsUsed: ['legal_compliance'],
    queryAnalysis: {
      originalQuery: question,
      expandedQueries: [],
      extractedEntities: {
        dates: [],
        prices: [],
        documentTypes: ['документ'],
        services: ['апостиль'],
      },
      isAmbiguous: false,
    },
    answerSource: 'deterministic_guardrail',
    requiresHumanReview: false,
  };
}

// Does the question concern a service/document the bureau actually deals with?
// Used to decide whether an out_of_scope verdict should fall through to an
// OPEN knowledge-base lookup (bureau topic) or be honestly refused (off-topic).
//
// IMPORTANT: the trigger is a SERVICE or DOCUMENT word — NOT a generic
// price/time word. "сколько стоит биткоин" must stay off-topic, so "стоит"
// alone must never qualify; it only counts when paired with a service below.
//
// Domain owner: extend this list as the bureau's services grow. Each entry is
// a stem. /iu flags are used so uppercase ВНЖ/РВП/etc. match without calling
// toLowerCase(), which silently corrupts Cyrillic on some Alpine/Node environments.
const BUREAU_TOPIC_PATTERN_CI = new RegExp(
  'апостил|легализац|нотари|загс|кзагс|минюст|' +
  'мвд|мю|' +  // мвд | мю  (Unicode escapes — immune to source encoding)
  'перевод|доверенност|свидетельств|справк|диплом|аттестат|образован|судим|паспорт|' +
  'истреб|консульск|заверен|печат|штамп|загранпаспорт|гражданств|виз|опек|документ|' +
  'миграц|' +
  'внж|' +                    // внж  (ВНЖ lowercase)
  'вид[уаео]? на жительств|' + // вид[уаео]? на жительств
  'рвп|' +                    // рвп  (РВП lowercase)
  'вид на временн|' + // вид на временн
  'содействи',                       // содействи
  'iu'
);

function isBureauTopic(question: string): boolean {
  return BUREAU_TOPIC_PATTERN_CI.test(question);
}

function shouldUseGeneralKnowledgeFallback(question: string): boolean {
  // /iu flags on original question — same reason as buildDeterministicGuardrailResult.
  const mentionsKnownService =
    /апостил|легализац|нотари|загс|мвд|минюст|перевод|доверенност|свидетельств|справк|документ/iu.test(question);
  const asksPracticalQuestion =
    /как|где|можн|нужн|нельзя|надо|что\s+делать|подат|оформ|постав|простав|апостилир|легализ/iu.test(question);

  return mentionsKnownService && asksPracticalQuestion;
}

async function answerFromGeneralKnowledgeFallback(
  question: string,
  reason: string,
  sessionId?: string
): Promise<EnhancedAnswerResult> {
  let parsed: {
    canAnswer?: unknown;
    answer?: unknown;
    confidence?: unknown;
    requiresHumanReview?: unknown;
    reasoning?: unknown;
  } = {};

  // general_ai has NO knowledge-base grounding, so the conversation so far is
  // its only anchor for resolving abbreviations/references (e.g. "СОР" →
  // свидетельство о рождении from an earlier turn). Without it the model guesses
  // — that's how an earlier СОР question got misread as "справка о судимости".
  // Best-effort: a failed history fetch must not break the answer.
  let conversationContext = '';
  if (sessionId) {
    try {
      const recent = await prisma.chatMessage.findMany({
        where: { sessionId },
        orderBy: { createdAt: 'desc' },
        take: 6,
        select: { role: true, content: true },
      });
      if (recent.length > 1) {
        conversationContext = recent
          .reverse()
          .map((m) => `${m.role}: ${m.content}`)
          .join('\n');
      }
    } catch (e) {
      console.warn('[enhanced-answering] general_ai context fetch failed:', e);
    }
  }

  try {
    const raw = await createChatCompletion({
      messages: [
        { role: 'system', content: GENERAL_KNOWLEDGE_FALLBACK_PROMPT },
        {
          role: 'user',
          content: `${conversationContext ? `Контекст диалога:\n${conversationContext}\n\n` : ''}Вопрос пользователя: ${question}\n\nПочему база знаний не ответила уверенно: ${reason}`,
        },
      ],
      responseFormat: 'json_object',
      temperature: 0,
      maxTokens: 900,
    });
    if (raw) {
      const { normalizeJsonResponse } = await import('@/lib/ai/chat-provider');
      parsed = JSON.parse(normalizeJsonResponse(raw));
    }
  } catch (error) {
    console.warn('[enhanced-answering] General knowledge fallback failed:', error);
  }

  const canAnswer = parsed.canAnswer === true;
  const answer = typeof parsed.answer === 'string' ? parsed.answer.trim() : '';
  const confidence = typeof parsed.confidence === 'number'
    ? Math.max(0, Math.min(parsed.confidence, 0.65))
    : 0.35;
  // Policy (2026-05-29): an answer drawn from the model's general knowledge
  // (no KB grounding) ALWAYS requires human review and escalates — regardless
  // of the model's own self-assessment. Never let the model clear its own flag.
  const requiresHumanReview = true;

  if (!canAnswer || answer.length < 10) {
    return {
      answer:
        'В базе знаний нет прямого ответа, а общего знания ИИ недостаточно для уверенной консультации. Передайте вопрос на ручную проверку.',
      confidence: 0.2,
      confidenceLevel: 'low',
      needsClarification: true,
      suggestedClarification: 'Нужна ручная проверка специалистом.',
      citations: [],
      domainsUsed: ['legal_compliance'],
      queryAnalysis: {
        originalQuery: question,
        expandedQueries: [],
        extractedEntities: { dates: [], prices: [], documentTypes: [], services: [] },
        isAmbiguous: false,
      },
      answerSource: 'general_ai',
      requiresHumanReview: true,
    };
  }

  return {
    answer: [
      answer,
      '',
      'Источник: общее знание ИИ, не подтверждено прямой цитатой из базы знаний. Рекомендуется проверить и добавить правило в базу.',
    ].join('\n'),
    confidence,
    confidenceLevel: confidence >= 0.5 ? 'medium' : 'low',
    needsClarification: requiresHumanReview,
    suggestedClarification: requiresHumanReview ? 'Проверьте ответ и добавьте подтверждённое правило в базу знаний.' : undefined,
    citations: [],
    domainsUsed: ['legal_compliance'],
    queryAnalysis: {
      originalQuery: question,
      expandedQueries: [],
      extractedEntities: { dates: [], prices: [], documentTypes: [], services: [] },
      isAmbiguous: false,
    },
    answerSource: 'general_ai',
    requiresHumanReview,
  };
}

function getDeterministicQueryVariants(question: string): string[] {
  const variants: string[] = [];

  if (
    /консульск[а-яёa-z]*\s+легализац|легализац[а-яёa-z]*\s+.*консульск|(?:^|[^а-яё])кл(?:[^а-яё]|$)/iu.test(question) &&
    /для\s+каких\s+стран|какие\s+страны|список\s+стран/iu.test(question)
  ) {
    variants.push(
      'СПИСОК СТРАН, ДЛЯ КОТОРЫХ НУЖНА КОНСУЛЬСКАЯ ЛЕГАЛИЗАЦИЯ ДОКУМЕНТОВ'
    );
  }

  return variants;
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
  qaPairs: { question: string; answer: string }[]
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
