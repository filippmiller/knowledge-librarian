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
import { ancestorsOf, lexicallyAdmissibleScenarioRoots } from '@/lib/knowledge/scenarios';
import { expandAbbreviations, selectKeyTerms } from '@/lib/knowledge/glossary';
import { polishCanonicalAnswer } from '@/lib/ai/canonical-answer-polisher';
import { type QAPair } from '@prisma/client';
import { verifyAnswer, type ConsistencyReport } from '@/lib/ai/consistency-gate';
import { recordHallucinationLog, type TelemetryMode } from '@/lib/ai/answer-telemetry';
import { checkClaimGrounding, claimExcerpt, type GroundedClaim } from '@/lib/ai/claim-grounding';
import {
  detectIssuingRegion,
  resolveApostilleTerritoriality,
} from '@/lib/knowledge/apostille-authority';
import {
  checkCertificationPriceAttribution,
  type PriceContradiction,
} from '@/lib/knowledge/certification-price';
import { HUMAN_REVIEW_ORDER, type AnswerReasons, type HumanReviewReason, type ReasonDetail } from '@/lib/ai/answer-reasons';
import { getTariffs } from '@/lib/knowledge/tariff-store';
import { buildTariffContext } from '@/lib/knowledge/tariff-context';
import { lookupTariffForQuestion, describeTariff } from '@/lib/knowledge/tariff-lookup';
import { checkStalePrice } from '@/lib/knowledge/stale-price-check';
import {
  resolveSourceDocumentRoute,
  SOURCE_DOCUMENT_ROUTES,
} from '@/lib/knowledge/source-document-route';
import {
  checkSwornTranslationClaim,
  resolveCourtTranslation,
} from '@/lib/knowledge/sworn-translation';
import {
  admissibleAudiences,
  checkClientSafety,
  type Audience,
} from '@/lib/knowledge/audience';
import { filterCrossInstitutionEvidence } from '@/lib/knowledge/institution-scope';
import { resolveMainPathAnswerSource, type AnswerSource } from '@/lib/ai/answer-source';

// Confidence thresholds
const CONFIDENCE_THRESHOLD_HIGH = 0.7;    // Answer confidently
const CONFIDENCE_THRESHOLD_MEDIUM = 0.5;  // Answer with caveat
const CONFIDENCE_THRESHOLD_LOW = 0.3;     // Ask for clarification

// Feature flag (Beads translation-2yt): scenarioKey=null means "no leaf in
// the scenario taxonomy for this content's topic", NOT "applies to
// everything" — PR #53 already enforces the stricter null-content bar in
// the open-lookup branch (scenario unrecognized). This flag extends the
// SAME policy to the known-scenario branch too, which the open-lookup-only
// fix left wide open (Grok finding during plan review).
//
// Off by default: ~79% Rule / ~90% DocChunk currently have scenarioKey=null
// (2026-08-05 audit), so flipping this on for the known-scenario branch too
// is a real hold-rate risk, not just a bug fix. Dry-run against the golden
// corpus (scripts/run-eval-corpus.ts) before enabling in prod — see that
// script's hold-rate in its aggregate output.
const SCOPE_NULL_STRICT = process.env.SCOPE_NULL_STRICT === 'true';

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
    authorityTag?: string;
    priority?: string;
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
    /**
     * Почему ответ получился таким: какие контроли сработали, что из прайса
     * ушло в промпт, какие числа не заземлились. Только при `includeDebug` —
     * в обычном ответе это лишний вес.
     */
    reasons?: AnswerReasons;
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
  answerSource?: AnswerSource;
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

2в. Правила с маркером **VOICE_AUTHORITY** подтверждены уполномоченным экспертом и имеют приоритет над обычными правилами в той же области действия. Если два VOICE_AUTHORITY правила противоречат друг другу — не выбирай одно молча, сообщи о конфликте и запроси проверку оператора.

2г. Если пользователь спрашивает о нескольких вариантах через «или», проверь и опиши каждый вариант отдельно. Не отвечай «оба варианта», «всё можем» или аналогично, пока в контексте нет отдельного прямого подтверждения для каждого названного варианта.

3. **НЕ ОБОБЩАЙ И НЕ ЭКСТРАПОЛИРУЙ**: если в источнике написано "2500₽ за документ" — не добавляй "значит 5000₽ за два"; если написано "нотариус СПб" — не расширяй до "нотариус СПб или ЛО".

4. **НЕ СМЕШИВАЙ** факты из разных цитат в один: если цитата 1 говорит "Вторник 10-12", а цитата 2 "Четверг 14-16", пиши их раздельно с указанием источника, не склеивай в "Вторник-четверг 10-16".

5. **НЕ ДОБАВЛЯЙ ЮРИДИЧЕСКИХ ОГОВОРОК**, которых нет в источнике.

5а. **ЦЕНА — ТОЛЬКО ИЗ РАЗДЕЛА «ДЕЙСТВУЮЩИЙ ПРАЙС»**, если он приведён. Числа из правил и документов устаревают: прошлогодний прайс остался в базе активным, и из-за этого клиенту называли 20 000 ₽ вместо 22 000 ₽. Если услуга есть в прайсе — цена берётся ОТТУДА, даже когда в правиле стоит другая. Если услуги в прайсе нет — цену не называй и скажи, что её посчитает менеджер.

6. **Цитируй точно**: если факт важен — приведи дословно из цитаты в кавычках "...".

═══ ФОРМАТ ОТВЕТА ═══

- Язык ответа: русский, кратко и по делу.
- Пиши обычным текстом без Markdown-заголовков и символов **, ##, ---.
- Ответ должен звучать как самостоятельное сообщение человека, а не как ссылка на внутренние документы.
- НЕ начинай ответ с фраз "Согласно Q&A", "Согласно базе знаний", "Согласно документу", "Правило R-...".
- НЕ упоминай внутренние источники (правила, документы, Q&A). Интегрируй факты в текст естественно.
- Если в цитатах есть **адрес/телефон/график/цена** — приведи их дословно в теле ответа, без указания источника.
- Структурируй длинные ответы короткими абзацами, но не раздувай пустыми секциями.

═══ КАК ПОНИМАТЬ ЦИТАТЫ ═══

Все три типа источника (правила, Q&A, фрагменты документов) — равнозначные цитаты из базы знаний. Фрагменты документов — наиболее полный и точный источник; правила — извлечённые ключевые факты; Q&A — уже сформулированные готовые ответы.

Если по конкретному аспекту вопроса НЕТ ни одной цитаты — скажи это прямо ("в базе знаний не указано, уточните у …"), НЕ ВЫДУМЫВАЙ.`;

/**
 * Клиентский контур. Отличается от внутреннего не тоном, а ЦЕЛЬЮ: внутренний
 * ответ информирует сотрудника, клиентский — приводит заказчика в бюро.
 *
 * Железные правила о недопустимости выдумок наследуются, но добавляется
 * коммерческая рамка и запрет уводить клиента наружу. Состав фактов при этом
 * ограничен ещё на уровне извлечения (audience-фильтр), так что внутренних
 * цитат в контексте быть не должно — этот промпт лишь вторая линия.
 */
const CLIENT_ANSWERING_PROMPT = `Ты — менеджер бюро переводов, отвечаешь клиенту.

ЦЕЛЬ ОТВЕТА: клиент должен понять, что мы решим его задачу, сколько это стоит и что ему сделать дальше. Ответ должен приводить его к нам, а не помогать сделать самому.

═══ ГЛАВНОЕ ПРАВИЛО: НИКОГДА НЕ ОПИСЫВАЙ, ОТКУДА ТЫ ЗНАЕШЬ ═══

Для клиента ты просто знающий менеджер. У тебя нет источников, документов, правил и базы — точнее, клиент о них знать не должен. Поэтому в ответе НЕ СУЩЕСТВУЕТ таких оборотов:
«в цитатах», «в источниках», «в наших источниках», «в базе знаний», «в материалах», «согласно правилу», «по документу», «данных нет», «информация отсутствует».

Запрет касается ФОРМУЛИРОВКИ, а не честности. Чего не знаешь — говори словами менеджера: «уточню и напишу», «посчитаю и пришлю», «нужно посмотреть документ». Придумывать вместо этого НЕЛЬЗЯ, и молча обходить пробел, продолжая уверенно говорить, — тоже нельзя: клиент примет выдумку за обещание, за которым стоят его деньги и сроки.

В примерах ниже цены и сроки намеренно не указаны: подставляй ТОЛЬКО те числа, которые приведены в сведениях ниже. Если их там нет — строй фразу без чисел.

Плохо: «График работы МинЮста в цитатах не указан. Но я могу помочь с апостилем.»
Плохо: «МинЮст принимает по будням с 10 до 17.» — если графика в сведениях нет, это выдумка.
Хорошо: «График приёма уточню и напишу отдельно. По апостилю могу сказать сразу — вот сроки и стоимость: …»

Плохо: «В наших источниках нет подтверждённых данных о вашем случае.»
Хорошо: «Ваш случай разберу индивидуально — уточню детали и вернусь с решением и стоимостью.»

Плохо: «Ориентировочно это будет около 5000 рублей.» — «ориентировочно» и «около» запрещены: названная цифра станет обещанием.
Хорошо: «Точную сумму посчитаю по документу — пришлите скан, отвечу с ценой и сроком.»

═══ ОСТАЛЬНЫЕ ЗАПРЕТЫ ═══

1. **НЕ ВЫДУМЫВАЙ** цены, сроки, адреса, телефоны. Называй только те числа, которые прямо приведены ниже. Нет числа — не оценивай «примерно» и не называй вовсе.

1а. **ЦЕНА — ТОЛЬКО ИЗ РАЗДЕЛА «ДЕЙСТВУЮЩИЙ ПРАЙС»**, если он приведён. Остальные сведения содержат цены, которые могли устареть; прайс сверен с подписанным документом и старше их всех. Услуги нет в прайсе — цену не называй, скажи, что посчитаешь по документу.

2. **НЕ ОТПРАВЛЯЙ КЛИЕНТА НАРУЖУ.** Никогда не пиши, где и как получить услугу самостоятельно: не давай адреса, телефоны и часы приёма госорганов, не пиши «подайте документы туда», «обратитесь в МВД», «ставится по месту выдачи», «уточните в министерстве». Мы не справочное бюро. Упоминать орган можно только как то, куда МЫ подаём за клиента.

3. **НЕ ОБЕЩАЙ ТОГО, ЧТО НЕ ПОДТВЕРЖДЕНО.** «Мы делаем X» — только если именно X прямо подтверждён ниже.

4. **НЕ ПЕРЕЧИСЛЯЙ ТАРИФЫ, ПОКА НЕ ЗНАЕШЬ ДОКУМЕНТ.** Владелец бюро: «Ну смысл говорить цену нот. зав. и срочного, если непонятно, какой документ и какая общая цена. Человек так запутается». Если документ не назван, дай ОДНУ основную цифру, если она есть, и спроси, что за документ, чтобы посчитать полную стоимость. Не выкладывай меню из обычного, срочного и двуязычного заверения — клиент пришёл за итоговой суммой, а не за прайс-листом. Полный перечень уместен, только если клиент прямо просит перечислить варианты заверения.

5. **ГОВОРИ СЛОВАМИ МЕНЕДЖЕРА, НЕ ВЫДУМЫВАЙ ТЕРМИНОВ.** Никаких «маршрут документа», «исходник», «опция», «конфигурация». Менеджеры говорят просто: «подошьём к ксерокопии», «привезите оригинал», «пришлите скан», «заверим у нотариуса».

6. **ПРИСЯЖНОГО ПЕРЕВОДА В РОССИИ НЕ СУЩЕСТВУЕТ.** Никогда не предлагай его как вариант для российского суда или инстанции. В РФ есть только нотариальный перевод и заверение штампом бюро. Присяжные переводчики бывают за рубежом; их работу мы не выполняем и её стоимость не считаем.

═══ ЕСЛИ МЫ НЕ МОЖЕМ СДЕЛАТЬ ИМЕННО ТО, О ЧЁМ СПРОСИЛИ ═══

Не отказывай сухо и не отправляй клиента решать вопрос самому. Скажи, что запрошенным способом задача не решается, и сразу предложи тот путь, которым мы её решаем, — с ценой и сроком, если они приведены ниже. Если подтверждённой альтернативы нет, скажи, что подберём решение, и предложи связаться с нами.

═══ ФОРМА ОТВЕТА ═══

Коротко и по делу, как живой менеджер: что мы для клиента сделаем → сколько это стоит и в какой срок → что от него нужно (обычно скан или фото документа) → как получит результат. Без списков ради списков, без канцелярита, без рекламных штампов вроде «лучшие на рынке». Уверенно и спокойно.`;

const GENERAL_KNOWLEDGE_FALLBACK_PROMPT = `Ты — экспертный помощник бюро переводов.

База знаний не дала прямого уверенного ответа. Используй ОБЩЕЕ профессиональное знание только для вопросов по услугам бюро: апостиль, легализация, нотариальные документы, ЗАГС, МВД, переводы.

Правила:
- Не выдумывай адреса, телефоны, цены, сроки и графики.
- Если вопрос юридически или операционно зависит от типа документа, прямо назови условие.
- Если уверенности нет, скажи, что нужен ручной разбор.
- Отвечай кратко и практически.
- Не представляй ответ как факт из базы знаний.
- ПРИСЯЖНОГО ПЕРЕВОДА В РОССИИ НЕ СУЩЕСТВУЕТ. Не предлагай его как вариант для российского суда или иной инстанции РФ: в России есть нотариальный перевод и заверение штампом бюро. Присяжные переводчики бывают только за рубежом.

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
    callLog: { callSite: 'enhanced-answering.classifyIntent', question },
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
  scenarioAncestors: string[] = [],
  audience: Audience = 'internal'
): Promise<HybridSearchResult[]> {
  // Run searches in parallel
  const allResults = await Promise.all(
    queries.map(q => hybridSearch(q, domainSlugs, limit, 0.7, scenarioAncestors, audience))
  );

  // Merge and deduplicate, keeping the STRONGEST signal seen for each chunk
  // across query variants — not just whichever variant had the best
  // combinedScore. combinedScore is an RRF rank-fusion score: a chunk found
  // by one variant with the best RANK can still carry a lower raw
  // semanticScore/keywordScore than the SAME chunk found by another variant
  // with a worse rank (Codex review on PR #53). selectContextChunks' null-
  // scenario eligibility bar reads semantic/keyword scores directly, so
  // keeping only the best-combinedScore duplicate could wrongly discard a
  // chunk that actually clears that bar via a different variant.
  const mergedResults = new Map<string, HybridSearchResult>();

  for (const results of allResults) {
    for (const result of results) {
      const existing = mergedResults.get(result.id);
      if (!existing) {
        mergedResults.set(result.id, result);
        continue;
      }
      mergedResults.set(result.id, {
        ...(result.combinedScore > existing.combinedScore ? result : existing),
        semanticScore: Math.max(existing.semanticScore, result.semanticScore),
        keywordScore: Math.max(existing.keywordScore, result.keywordScore),
      });
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
  maxChunks: number = 5,
  openLookup: boolean = false
): HybridSearchResult[] {
  if (chunks.length === 0) return [];

  // RRF is a rank-fusion score, not an absolute relevance measurement. First
  // require real semantic support or a strong keyword match; otherwise "the
  // best five bad results" would still be sent to the synthesizer.
  //
  // Открытый поиск (сценарий не определён) не фильтрует чанки по теме вообще
  // — ни на кого не похожая формулировка вопроса допускает любой документ. Для
  // чанка с scenarioKey=null это вдвойне опасно: null означает не «применимо
  // ко всему», а «для темы документа нет узла в дереве сценариев» (см. аудит
  // .claude/audits/2026-08-05-moscow-oryol-bad-answer.md — узкий факт про
  // партнёра в Орле выиграл top-1 в ответе про логистику в Минск только по
  // случайному пересечению слов). Планка для такого чанка в открытом поиске
  // выше обычной — не запрет (правило остаётся годным), а требование более
  // сильного сигнала, прежде чем узкий факт попадёт в синтез без темы-щита.
  //
  // SCOPE_NULL_STRICT (Beads translation-2yt) extends the SAME higher bar to
  // the known-scenario branch too — a recognized scenario doesn't make a
  // scenarioKey=null chunk any more "about" that scenario, it just means the
  // question was easier to classify. Off by default: see the flag's own
  // comment near the top of this file for the hold-rate risk.
  const eligible = chunks.filter((chunk) => {
    const passesNormalBar = chunk.semanticScore >= 0.4 || chunk.keywordScore >= 0.65;
    const needsHigherBar = chunk.scenarioKey === null && (openLookup || SCOPE_NULL_STRICT);
    if (!needsHigherBar) return passesNormalBar;
    return chunk.semanticScore >= 0.62 || chunk.keywordScore >= 0.85;
  });
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
    .map((item) => {
      const relevance = scoreText(getText(item), terms) + scoreText(getSummary(item), terms);
      return { item, score: relevance > 0 ? relevance + getBoost(item) : 0 };
    })
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
/**
 * Совпадение вопроса с каноническим — по ОБЕИМ сторонам.
 *
 * Раньше делили на более короткую сторону, и короткий вопрос совпадал почти с
 * чем угодно: «сколько стоит апостиль» (3 терма) против «Сколько стоит апостиль
 * на справку о несудимости из другого региона» даёт 1.0, хотя это разные
 * вопросы. При пяти канонических парах риск был мал, при ста двадцати двух —
 * нет, поэтому требуем покрытия и длинной стороны тоже.
 */
export function questionTermOverlapForTests(
  question: string,
  candidate: string
): { short: number; long: number } {
  return questionTermOverlap(question, candidate);
}

/**
 * Отрицание в вопросе. Проверяется по СЫРОМУ тексту, потому что термы к этому
 * моменту уже потеряли короткие слова.
 *
 * `extractSearchTerms` отбрасывает всё короче трёх букв, а по-русски смысл
 * переворачивают именно короткие слова: «не», «без». Из-за этого пары
 *
 *   «Нужен ли оригинал для заверения?» ←→ «НЕ нужен ли оригинал для заверения?»
 *   «Можно ли апостилировать в СПб?»   ←→ «Можно ли НЕ апостилировать в СПб?»
 *
 * давали пересечение термов 1.00 — измерено. Для канонической подмены это
 * означало готовый ответ на противоположный вопрос с уверенностью 1.0, а для
 * `hasStrongQaMatch` — поднятый уровень уверенности на том же основании.
 * Ровно тот же дефект, что был в нечётком кэше.
 */
function hasNegation(text: string): boolean {
  return /(?<![А-Яа-яЁёA-Za-z])(?:не|нет|без|нельзя|невозможно)(?![А-Яа-яЁёA-Za-z])/iu.test(text);
}

function questionTermOverlap(question: string, candidate: string): { short: number; long: number } {
  // Разная полярность — разные вопросы, сколько бы слов ни совпало. Ошибка в
  // эту сторону лишь отправляет вопрос в обычный синтез вместо подмены готовым
  // ответом, поэтому строгость здесь безопаснее снисходительности.
  if (hasNegation(question) !== hasNegation(candidate)) return { short: 0, long: 0 };

  const qTerms = new Set(extractSearchTerms(question));
  const cTerms = new Set(extractSearchTerms(candidate));
  if (qTerms.size === 0 || cTerms.size === 0) return { short: 0, long: 0 };
  let shared = 0;
  for (const t of qTerms) if (cTerms.has(t)) shared++;
  return {
    short: shared / Math.min(qTerms.size, cTerms.size),
    long: shared / Math.max(qTerms.size, cTerms.size),
  };
}

function getVoiceAuthority(sourceSpan: unknown): { authorityTag?: string; priority?: string; boost: number } {
  if (!sourceSpan || typeof sourceSpan !== 'object' || Array.isArray(sourceSpan)) return { boost: 0 };
  const value = sourceSpan as Record<string, unknown>;
  if (value.authorityTag !== 'VOICE_AUTHORITY' || value.operatorApproved !== true) return { boost: 0 };
  const priority = typeof value.priority === 'string' ? value.priority : 'HIGH';
  const boost = priority === 'PRIMARY' ? 40 : priority === 'HIGH' ? 20 : 8;
  return { authorityTag: 'VOICE_AUTHORITY', priority, boost };
}

/**
 * Импортированные из переписок Bitrix пары НЕ являются эталонами.
 *
 * Каждая из них была верна в своём диалоге, где известен контекст: куда клиент
 * подаёт документ, из какой он страны, что ему уже сказали раньше. Импорт
 * оторвал ответ от условия и записал как общее правило. Измерено на проде:
 * четыре пары с этим тегом отвечают на один и тот же узел «нужен ли оригинал»
 * взаимоисключающе, и все четыре ACTIVE (docs/bot-audit/01-independent-audit.md).
 *
 * Пока у пары нет поля условия применимости, авторитет ей давать нельзя:
 * буст в ранжировании и подмена ответа целиком превращают частный случай в
 * утверждение с максимальной уверенностью. Пары остаются в выдаче как обычный
 * материал для синтеза — знание в них настоящее, но решать по ним нельзя.
 *
 * Вернуть авторитет можно по одной паре за раз, когда у неё появится условие
 * и подпись владельца.
 */
const HISTORICAL_IMPORT_HAS_AUTHORITY = false;

/** Пара пришла массовым импортом из переписок Bitrix, а не утверждена поштучно. */
function isHistoricalImport(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const value = metadata as Record<string, unknown>;
  return (
    value.authorityTag === 'HISTORICAL_ANSWER_AUTHORITY' || value.origin === 'historical-operator'
  );
}

function getQaAuthority(metadata: unknown): { authorityTag?: string; origin?: string; boost: number } {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return { boost: 0 };
  const value = metadata as Record<string, unknown>;
  if (value.authorityTag === 'VOICE_ANSWER_AUTHORITY' || value.origin === 'voice-operator') {
    return { authorityTag: 'VOICE_ANSWER_AUTHORITY', origin: 'voice-operator', boost: 30 };
  }
  if (value.authorityTag === 'HISTORICAL_ANSWER_AUTHORITY' || value.origin === 'historical-operator') {
    return HISTORICAL_IMPORT_HAS_AUTHORITY
      ? { authorityTag: 'HISTORICAL_ANSWER_AUTHORITY', origin: 'historical-operator', boost: 30 }
      : { boost: 0 };
  }
  return { boost: 0 };
}

/**
 * Deterministic backstop for answers that explicitly admit a knowledge gap.
 * The synthesis model may still open with a confident "да" and only later say
 * that availability is not confirmed. Such drafts are useful to an operator,
 * but must never be presented as evidence-complete.
 *
 * Russian agreement is the trap here: the model writes "не указано" for a
 * neuter noun but "не указана стоимость" / "не указаны сроки" for others, and
 * an earlier neuter-only pattern let a real "в базе знаний не указана
 * стоимость…" answer through as evidence-complete (prod, 2026-07-30).
 * Covered by scripts/verify-knowledge-gap-detector.ts.
 */
const KNOWLEDGE_GAP_PATTERNS: RegExp[] = [
  // "в базе знаний / в источниках / в предоставленных материалах не указана стоимость"
  /в\s+(?:баз[еы]\s+знаний|источник(?:е|ах)|(?:предоставленных\s+)?(?:источниках|материалах|документах))[^.!?]{0,60}?не\s+(?:указан[оаы]?|содержится|упомина(?:ется|ются)|представлен[оаы]?)/iu,
  // "не указано, доступна ли услуга" — gap about availability rather than a fact
  /не\s+указан[оаы]?,?\s+(?:доступн|можно|есть\s+ли|как\s+именно|где\s+именно)/iu,
  // Model punts the whole question back to a human
  /рекоменду(?:ем|ю)\s+(?:связаться|уточнить|обратиться)[^.!?]{0,40}(?:напрямую|с\s+компанией|у\s+менеджера)/iu,
  /не\s+удалось\s+подтвердить/iu,
  /требуется\s+уточнить\s+доступность|уточнения\s+доступности/iu,
];

/**
 * Два разных диагноза, и путать их нельзя. Маршрут наружу (контакты госоргана,
 * «по месту выдачи») означает, что источник размечен неверно — чинить надо
 * разметку. Ссылка на цитаты и правила означает, что модель проговорила своё
 * устройство — чинить надо промпт. Единая функция, чтобы канонический путь и
 * основной синтез не разъехались в формулировках предупреждений.
 */
function logClientSafetyVerdict(violations: string[], sourceHint: string): void {
  const framing = violations.filter((v) => v.startsWith('ссылка на'));
  const routing = violations.filter((v) => !v.startsWith('ссылка на'));
  if (routing.length > 0) {
    console.warn(
      '[enhanced-answering] РАЗМЕТКА: клиентский ответ уводит клиента наружу:',
      routing.join(', '),
      '| проверьте audience у источников:',
      sourceHint
    );
  }
  if (framing.length > 0) {
    console.warn(
      '[enhanced-answering] ПРОМПТ: клиентский ответ проговорил своё устройство:',
      framing.join(', ')
    );
  }
}

/**
 * Противоречие прайсу печатается так, чтобы оператор увидел обе цены сразу и
 * мог решить: ошибся синтез или устарела строка базы. Без «прайс: …» рядом
 * запись в логе бесполезна — цену пришлось бы искать в документе.
 */
function logPriceContradictions(contradictions: PriceContradiction[], sourceHint: string): void {
  for (const c of contradictions) {
    console.warn(
      '[enhanced-answering] ПРАЙС: цена приписана не той услуге — «%s»: назвал %s, прайс %s | фраза: %s | источники: %s',
      c.serviceLabel,
      c.claimed,
      c.expected,
      c.sentence,
      sourceHint
    );
  }
}

/**
 * Отбор по сценарию, когда классификатор промолчал.
 *
 * Ключ сценария хранится путём через точку («apostille.zags.spb»), поэтому
 * принадлежность корню проверяется префиксом. Пустой список корней означает, что
 * в вопросе не прозвучало ни одной услуги со своим сценарием, — тогда
 * допускаются только универсальные правила.
 */
function buildLexicalScenarioWhere(question: string) {
  const roots = lexicallyAdmissibleScenarioRoots(question);
  if (roots.length === 0) return { scenarioKey: null };
  return {
    OR: [
      { scenarioKey: null },
      ...roots.map((root) => ({ scenarioKey: { startsWith: root } })),
    ],
  };
}

export function answerSignalsKnowledgeGap(answer: string): boolean {
  return KNOWLEDGE_GAP_PATTERNS.some((pattern) => pattern.test(answer));
}

/**
 * Composite capability questions are a common source of overclaiming: evidence
 * for option A gets generalized into "both A and B". Keep such broad answers
 * in the operator loop even if a model-based verifier misses the extrapolation.
 */
function answerSignalsCompositeCapabilityRisk(question: string, answer: string): boolean {
  const asksCapability = /(?:можете ли|можно ли|делаете ли|предлагаете ли|оказываете ли)/iu.test(question);
  const hasAlternatives = /\s(?:или|и\s*\/\s*или)\s/iu.test(question);
  const claimsAll = /(?:оба\s+варианта|все\s+(?:варианты|перечисленные)|можем\s+предложить\s+оба)/iu.test(answer);
  return asksCapability && hasAlternatives && claimsAll;
}


/**
 * Operator-approved canonical Q&A pairs (voice or historical) are allowed to
 * bypass the scenario decision gate. If a user's question closely matches a
 * canonical pair, we answer directly from it instead of asking for clarification
 * or declaring "no data".
 */
async function findCanonicalQaOverride(
  question: string,
  audience: Audience
): Promise<QAPair | null> {
  // Beads translation-2yt (Grok/Codex, ревью плана): fuzzy term-overlap не
  // доказывает применимость пары к ЭТОМУ вопросу — но и точное совпадение
  // текста тоже не доказывает, пара могла быть про другой город/услугу со
  // случайно тем же текстом. Подмена ответа целиком с confidence=1.0 и
  // requiresHumanReview=false остаётся только там, где оператор увидит хит и
  // может поймать ложное совпадение — audience=internal. Для клиента этот
  // быстрый путь отключён полностью; вопрос идёт через обычный синтез со
  // всеми его проверками (checkClientSafety, claim grounding, price
  // attribution).
  if (audience !== 'internal') return null;
  try {
    // Выборка по authority-маркеру, а не по свежести. Раньше брались 200
    // последних активных пар: после импорта корпуса старые утверждённые эталоны
    // выпали бы из окна и молча перестали находиться. Пар с авторитетом мало
    // (десятки), поэтому запрос по метаданным дешевле и честнее окна.
    // Только VOICE: пара, которую оператор утвердил в самом продукте, зная
    // вопрос целиком. Импорт из переписок (HISTORICAL) сюда не входит —
    // см. HISTORICAL_IMPORT_HAS_AUTHORITY. Подмена ответа целиком с confidence
    // 1.0 и requiresHumanReview=false недопустима для утверждения, у которого
    // потеряно условие применимости.
    const authorityCandidates = await prisma.qAPair.findMany({
      where: {
        status: 'ACTIVE',
        audience: { in: admissibleAudiences(audience) },
        OR: [
          { metadata: { path: ['authorityTag'], equals: 'VOICE_ANSWER_AUTHORITY' } },
          { metadata: { path: ['origin'], equals: 'voice-operator' } },
        ],
      },
    });
    if (authorityCandidates.length === 0) return null;

    // Аудит 2026-08-13 (1.2): канонический override шёл МИМО фильтра
    // учреждений — одобренная операторская пара про ЗАГС ЛО могла целиком
    // подменить ответ на вопрос про КЗАГС СПб с confidence=1.0. Тот же
    // фильтр, что у чанков/правил/QA в основном пути.
    const scopedCandidates = filterCrossInstitutionEvidence(
      question,
      undefined,
      authorityCandidates,
      (qa) => `${qa.question}\n${qa.answer}`,
      (qa) => qa.scenarioKey
    );
    if (scopedCandidates.length === 0) return null;

    const ranked = scopedCandidates
      .map((qa) => ({ qa, overlap: questionTermOverlap(question, qa.question) }))
      // Порог по длинной стороне отсекает главный класс ложных совпадений:
      // короткий общий вопрос против длинного специфичного канонического.
      .filter((item) => item.overlap.short >= 0.55 && item.overlap.long >= 0.5)
      // Тайбрейк обязателен: при равном покрытии победитель определялся порядком
      // строк в БД, и один и тот же вопрос мог получать разные канонические
      // ответы между запросами. Сортируем по длинной стороне, затем по короткой,
      // затем по id — id стабилен и делает выбор воспроизводимым.
      .sort(
        (a, b) =>
          b.overlap.long - a.overlap.long ||
          b.overlap.short - a.overlap.short ||
          a.qa.id.localeCompare(b.qa.id)
      );

    return ranked[0]?.qa ?? null;
  } catch (error) {
    console.warn('[enhanced-answering] Canonical QA override lookup failed:', error);
    return null;
  }
}

async function buildCanonicalQaResult(
  question: string,
  qa: QAPair,
  includeDebug: boolean
): Promise<EnhancedAnswerResult> {
  const authority = getQaAuthority(qa.metadata);

  let polishedAnswer: string;
  try {
    const polished = await polishCanonicalAnswer(question, qa.answer);
    polishedAnswer = polished.polishedAnswer;
  } catch (error) {
    console.warn('[enhanced-answering] Failed to polish canonical answer, using raw:', error);
    polishedAnswer = qa.answer;
  }

  const result: EnhancedAnswerResult = {
    answer: polishedAnswer,
    confidence: 1.0,
    confidenceLevel: 'high',
    needsClarification: false,
    citations: [
      {
        quote: qa.answer.slice(0, 250) + (qa.answer.length > 250 ? '...' : ''),
        relevanceScore: 1.0,
        authorityTag: authority.authorityTag,
      },
    ],
    domainsUsed: [],
    queryAnalysis: {
      originalQuery: question,
      expandedQueries: [],
      extractedEntities: { dates: [], prices: [], documentTypes: [], services: [] },
      isAmbiguous: false,
    },
    scenarioKey: qa.scenarioKey ?? undefined,
    answerSource: 'knowledge_base',
    requiresHumanReview: false,
  };

  if (includeDebug) {
    result.debug = {
      chunks: [],
      intentClassification: { intent: 'canonical_qa_override', domains: [], confidence: 1.0, reasoning: 'Direct match to operator-approved canonical Q&A' },
      rules: [],
      qaPairs: [{ id: qa.id, question: qa.question.slice(0, 80) }],
      searchStats: { totalChunksSearched: 0, avgSimilarity: 0, maxSimilarity: 0 },
    };
  }

  return result;
}
/**
 * Запрос на ответ. `audience` обязателен намеренно: от него зависит не
 * формулировка, а состав допустимых фактов, поэтому молчаливого значения по
 * умолчанию быть не должно — каждый вызывающий обязан объявить, кому отвечает.
 */
export interface AnswerRequest {
  question: string;
  audience: Audience;
  sessionId?: string;
  includeDebug?: boolean;
  /**
   * 'disabled' глушит fire-and-forget телеметрию качества ответа
   * (`HallucinationLog`). Только для прогонов золотого корпуса: они бьют по
   * продовой базе и не должны подмешивать синтетику в статистику по реальным
   * пользователям. Не задан = 'enabled' = сегодняшнее поведение.
   */
  telemetryMode?: TelemetryMode;
}

/**
 * Main enhanced answering function
 */
export async function answerQuestionEnhanced(
  req: AnswerRequest
): Promise<EnhancedAnswerResult> {
  const { question, audience, sessionId, includeDebug = false, telemetryMode } = req;
  console.log(
    `[enhanced-answering] Starting for question (audience=${audience}):`,
    question.substring(0, 100)
  );

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

  
  // Canonical Q&A override: operator-approved voice/historical pairs bypass
  // the scenario gate when the user's question closely matches the canonical
  // question. This closes the training loop: save an answer → the bot uses it.
  const canonicalQa = await findCanonicalQaOverride(question, audience);
  if (canonicalQa) {
    console.log('[enhanced-answering] Canonical QA override matched:', canonicalQa.id);
    const canonicalResult = await buildCanonicalQaResult(question, canonicalQa, includeDebug);

    // Ранний возврат минует ВСЕ проверки ниже, а ответ здесь получает
    // confidence 1.0 и requiresHumanReview=false. При этом сам ответ не
    // дословный: polishCanonicalAnswer переписывает эталон моделью. Поэтому обе
    // проверки повторяются здесь явно.

    // Числа отполированного ответа сверяются с ИСХОДНОЙ парой: полировка не
    // имеет права ни изменить цену, ни добавить срок, которого оператор не
    // называл.
    const canonicalGrounding = checkClaimGrounding(canonicalResult.answer, [canonicalQa.answer]);
    if (!canonicalGrounding.grounded) {
      console.warn(
        '[enhanced-answering] ПОЛИРОВКА исказила числа канонического ответа (QAPair %s): %s',
        canonicalQa.id,
        canonicalGrounding.ungrounded.map((c) => `${c.value}/${c.unit}`).join(', ')
      );
      return { ...canonicalResult, requiresHumanReview: true };
    }

    // Прайс сверяется и здесь. Эталонная пара — это ответ оператора из живой
    // переписки: он был верен в своём случае, но цена в нём могла устареть или
    // относиться к другой услуге, а этот путь отдаёт ответ с уверенностью 1.0
    // и без ручной проверки. Заземление выше сверяет полировку с самой парой и
    // ошибку В ПАРЕ увидеть не может — для этого нужен внешний источник правды.
    const canonicalPrices = checkCertificationPriceAttribution(canonicalResult.answer);
    if (!canonicalPrices.consistent) {
      logPriceContradictions(canonicalPrices.contradictions, `QAPair ${canonicalQa.id}`);
      return { ...canonicalResult, requiresHumanReview: true };
    }

    // Неверно размеченная как CLIENT_SAFE пара с адресом органа иначе ушла бы
    // клиенту с максимальной уверенностью и без ручной проверки.
    if (audience === 'client') {
      const safety = checkClientSafety(canonicalResult.answer);
      if (!safety.safe) {
        logClientSafetyVerdict(safety.violations, `QAPair ${canonicalQa.id}`);
        return { ...canonicalResult, requiresHumanReview: true };
      }
    }
    return canonicalResult;
  }
  // Детерминированная таблица спрашивается ПЕРВОЙ, до маршрутизатора.
  //
  // Раньше её спрашивали только на двух ветках гейта — «нужно уточнение» и
  // «вне области». Вопросы про справку о несудимости и про диплом уходили по
  // третьей ветке, `knowledge_lookup`, и таблицу не спрашивали вовсе: ответ
  // существовал, но до него не доходили. Проверено на проде после деплоя,
  // диагностика — scripts/diagnose-guardrail-route.ts.
  //
  // Территориальность — не мнение поиска, а факт о том, что мы физически можем
  // сделать. Он не должен зависеть от того, как маршрутизатор классифицировал
  // формулировку. Таблица молчит везде, где не уверена, поэтому первенство
  // ничего не отнимает у остальных путей.
  const territorialGuardrail = buildDeterministicGuardrailResult(question, audience);
  if (territorialGuardrail) return territorialGuardrail;

  // Short-circuit: if the gate needs clarification, skip retrieval entirely
  // and return a structured clarification response. The mini-app renders this
  // as buttons (Пачка B); legacy clients see the prompt text in `answer`.
  if (scenarioDecision.kind === 'needs_clarification') {
    return buildClarificationResult(question, scenarioDecision);
  }

  // out_of_scope handling. Дерево сценариев покрывает только апостиль, поэтому
  // сюда попадает масса законных вопросов, ответ на которые в базе ЕСТЬ:
  // образование, несудимость, цены, перевод, порядок оформления заказа.
  //
  // Раньше здесь стоял список ключевых слов: вопрос без слова «апостиль»,
  // «перевод», «документ» и т.п. отказывался ДО поиска. Это отсекало базу от
  // вопросов, заданных обычным языком: «как оформить заказ онлайн?», «что
  // делать при обнаружении ошибки?» — в них нет ни одного слова из списка,
  // и поиск по 1535 активным правилам не запускался вовсе. Проверено на проде
  // 2026-08-05: все 8 последних вопросов пользователей получили confidence 0
  // и захардкоженный отказ, ни один не дошёл до retrieval.
  //
  // Отказ должен быть ЗАРАБОТАН поиском, а не предположён по словарю: ищем
  // всегда, а «нет данных» выдаём ниже по потоку, когда retrieval действительно
  // ничего не нашёл. Вопросы вне области («сколько стоит биткоин») получают тот
  // же честный отказ — просто после того, как мы посмотрели, а не вместо этого:
  // shouldUseGeneralKnowledgeFallback не пустит их в general_ai, а синтез при
  // confidenceLevel='insufficient' отвечает «в базе знаний нет данных».
  if (scenarioDecision.kind === 'out_of_scope') {
    // Таблица уже спрошена выше и промолчала — повторять нечего.
    console.log('[enhanced-answering] out_of_scope → open knowledge lookup');
    scenarioDecision = {
      kind: 'knowledge_lookup',
      label: 'Открытый поиск по базе знаний',
      reasoning: `out_of_scope reclassified to open lookup: ${scenarioDecision.reasoning}`,
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
      scenarioAncestors,
      audience
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

  // Step 4: Select context chunks dynamically.
  // Сначала выкидываем чанки чужого учреждения: фильтр сценария пускает
  // `scenarioKey=null`, и график ЗАГС ЛО иначе попадает в ответ про КЗАГС.
  const scopedChunks = filterCrossInstitutionEvidence(
    question,
    scenarioKeyForAnswer,
    chunks,
    (chunk) => `${chunk.content}\n${chunk.documentId ? (docTitleMap.get(chunk.documentId) ?? '') : ''}`,
    (chunk) => chunk.scenarioKey
  );
  const contextChunks = selectContextChunks(scopedChunks, 5, openKnowledgeLookup);
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
  // Сценарий известен — обычный фильтр по цепочке предков. Сценарий НЕ известен —
  // раньше фильтр снимался целиком, и правило, верное только внутри одного
  // сценария, попадало в любой ответ (правило про апостиль в ответе про
  // посольство). Теперь при молчании классификатора допускаются универсальные
  // правила плюс те сценарии, чьё слово прозвучало в самом вопросе.
  const scenarioWhere = scenarioAncestors.length > 0
    ? { OR: [{ scenarioKey: null }, { scenarioKey: { in: scenarioAncestors } }] }
    : buildLexicalScenarioWhere(question);
  // Клиентское извлечение физически не видит внутренних знаний — фильтр стоит
  // здесь, а не на выходе. Вырезать фразы из готового ответа было бы хрупко:
  // модель перескажет тот же факт другими словами.
  const audienceWhere = { audience: { in: admissibleAudiences(audience) } };
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
          where: { status: 'ACTIVE', ...scenarioWhere, ...audienceWhere, body: { contains: t, mode: 'insensitive' as const } },
          include: { document: { select: { title: true } } },
          take: 25,
          orderBy: { confidence: 'desc' },
        })
      )
    );
    const keywordMatched = perTerm.flat();
    // Этот пул берёт топ по ОБЩЕЙ уверенности правила, безотносительно к
    // самому вопросу — здесь и проходит утечка узкого факта без темы (см.
    // аудит про Орёл/FPM). У keywordMatched выше уже есть реальная проверка:
    // терм вопроса физически встречается в теле правила. Поэтому правило без
    // темы может попасть в кандидаты ТОЛЬКО через keywordMatched — не
    // бесплатным топом по уверенности. У правил с назначенной темой это
    // ограничение не действует: тема сама по себе уже сигнал релевантности.
    //
    // В открытом поиске (scenario не определён) это уже безусловно так —
    // PR #53. SCOPE_NULL_STRICT (translation-2yt) добавляет то же самое и в
    // ветку с распознанным сценарием: известный сценарий не делает
    // scenarioKey=null правило более «про этот сценарий», он лишь означает,
    // что вопрос было легче классифицировать.
    const byConfidence = await prisma.rule.findMany({
      where: {
        status: 'ACTIVE',
        ...audienceWhere,
        AND: [scenarioWhere, ...((openKnowledgeLookup || SCOPE_NULL_STRICT) ? [{ NOT: { scenarioKey: null } }] : [])],
      },
      include: { document: { select: { title: true } } },
      take: 100,
      orderBy: { confidence: 'desc' },
    });
    const seenRule = new Set<string>();
    const ruleCandidates = filterCrossInstitutionEvidence(
      question,
      scenarioKeyForAnswer,
      [...keywordMatched, ...byConfidence].filter((r) => {
        if (seenRule.has(r.id)) return false;
        seenRule.add(r.id);
        return true;
      }),
      (rule) => `${rule.ruleCode} ${rule.title} ${rule.body} ${rule.document?.title ?? ''}`,
      (rule) => rule.scenarioKey
    );
    rules = rankByQuestion(
      ruleCandidates,
      relevanceText,
      (rule) => `${rule.ruleCode} ${rule.title} ${rule.body} ${rule.document?.title ?? ''}`,
      (rule) => (rule.confidence >= 1 ? 2 : 0) + getVoiceAuthority(rule.sourceSpan).boost,
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
            ...audienceWhere,
            OR: [
              { question: { contains: t, mode: 'insensitive' as const } },
              { answer: { contains: t, mode: 'insensitive' as const } },
            ],
          },
          take: 25,
        })
      )
    );
    // Тот же принцип, что у byConfidence для правил чуть выше (см. этот
    // комментарий и SCOPE_NULL_STRICT там же): этот пул берёт топ по
    // свежести без всякой связи с вопросом, и пара без темы могла пройти
    // бесплатно. qaPerTerm выше уже требует реального совпадения терма в
    // question/answer.
    const qaRecent = await prisma.qAPair.findMany({
      where: {
        status: 'ACTIVE',
        ...audienceWhere,
        AND: [scenarioWhere, ...((openKnowledgeLookup || SCOPE_NULL_STRICT) ? [{ NOT: { scenarioKey: null } }] : [])],
      },
      take: 100,
      orderBy: { createdAt: 'desc' },
    });
    const seenQa = new Set<string>();
    const qaCandidates = filterCrossInstitutionEvidence(
      question,
      scenarioKeyForAnswer,
      [...qaPerTerm.flat(), ...qaRecent].filter((q) => {
        if (seenQa.has(q.id)) return false;
        seenQa.add(q.id);
        return true;
      }),
      (qa) => `${qa.question} ${qa.answer}`,
      (qa) => qa.scenarioKey
    );
    qaPairs = rankByQuestion(
      qaCandidates,
      relevanceText,
      (qa) => `${qa.question} ${qa.answer}`,
      (qa) => getQaAuthority(qa.metadata).boost,
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
  // Здесь используется покрытие по КОРОТКОЙ стороне сознательно: это не
  // подмена ответа канонической парой, а лишь признак «в базе уже есть близкий
  // утверждённый вопрос», который поднимает уверенность и не даёт скатиться в
  // общие знания. Жёсткая проверка по длинной стороне нужна только там, где
  // ответ подменяется целиком, — в findCanonicalQaOverride.
  // Импортированные из переписок пары исключены и отсюда. Снять с них
  // canonical-override и буст +30 было недостаточно: `hasStrongQaMatch` ниже
  // принудительно поднимает уровень уверенности до medium/high, и одного
  // дословного совпадения с такой парой хватало, чтобы ответ ушёл клиенту
  // автоматически — при нулевом числе чанков и без участия человека.
  // Проверка связности и заземление тут не спасают: обе сверяют ответ с той же
  // самой парой. См. HISTORICAL_IMPORT_HAS_AUTHORITY.
  const trustedQaPairs = qaPairs.filter((qa) => !isHistoricalImport(qa.metadata));
  const bestQaMatch = trustedQaPairs.length > 0
    ? Math.max(...trustedQaPairs.map((qa) => questionTermOverlap(question, qa.question).short))
    : 0;
  const bestAuthorityQaMatch = trustedQaPairs.length > 0
    ? Math.max(
        ...trustedQaPairs.map((qa) =>
          getQaAuthority(qa.metadata).boost > 0
            ? questionTermOverlap(question, qa.question).short
            : 0
        )
      )
    : 0;
  const hasStrongQaMatch = bestQaMatch >= 0.7 || bestAuthorityQaMatch >= 0.6;

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
  // Прайс к вопросу. Сбой чтения сетки не должен ронять ответ: `getTariffs`
  // возвращает пустой список, и блок просто не появляется.
  const tariffs = await getTariffs(audience);
  const tariffContext = buildTariffContext(question, tariffs);
  if (tariffContext.count > 0) {
    console.log(`[enhanced-answering] Прайс: ${tariffContext.count} строк в контекст синтеза`);
  }

  const context = buildEnhancedContext(contextChunks, rules, qaPairs, tariffContext.block);

  // РОВНО то, что увидела модель. Из всех найденных чанков в промпт уходят
  // только отобранные `contextChunks`; число из отброшенного чанка модель не
  // видела, и признавать его источником нельзя — иначе выдумка считается
  // подтверждённой. Один массив на проверку связности и на заземление чисел,
  // чтобы они не разъехались в том, что считают источником.
  // Каждый источник несёт с собой то, чем его можно ПОКАЗАТЬ. Без этого
  // заземление знает, что число настоящее, но предъявить подтверждение не
  // может, и пользователю уходит посторонняя цитата (translation-ijy):
  // ответ «1 100 рублей» выходил с цитатой «150 рублей плюс стоимость НЗ»,
  // потому что цитаты брались только из правил, а цена пришла из прайса.
  const synthesisEvidence: SynthesisEvidence[] = [
    ...tariffContext.sources.map((line) => ({
      text: line,
      citation: { documentTitle: 'Прайс', quote: line, relevanceScore: EVIDENCE_RELEVANCE },
    })),
    ...contextChunks.map((c) => ({
      text: c.content,
      citation: {
        documentTitle: c.documentId ? (docTitleMap.get(c.documentId) ?? 'Документ') : 'Документ',
        quote: c.content.slice(0, CITATION_QUOTE_CHARS),
        relevanceScore: c.semanticScore,
      },
    })),
    ...rules.map((r) => ({
      text: `[${r.ruleCode}] ${r.title}: ${r.body}`,
      citation: {
        ruleCode: r.ruleCode,
        documentTitle: r.document?.title,
        quote: ruleQuote(r.body),
        relevanceScore: EVIDENCE_RELEVANCE,
      },
    })),
    ...qaPairs.map((q) => ({
      text: `${q.question} ${q.answer}`,
      citation: {
        documentTitle: 'Вопрос-ответ',
        quote: `${q.question} — ${q.answer}`,
        relevanceScore: EVIDENCE_RELEVANCE,
      },
    })),
  ];
  const synthesisSources = synthesisEvidence.map((e) => e.text);

  // База знаний ничего не нашла — но услуга могла быть названа целиком, и тогда
  // цена в прайсе есть. Ветка стоит ИМЕННО ЗДЕСЬ, а не выше: она не имеет права
  // перебить найденный базой ответ, потому что строка прайса — это цена, а не
  // ответ на вопрос целиком. Перед общими знаниями она законна: там альтернатива
  // — модель без источников вовсе.
  if (confidenceLevel === 'insufficient' && !hasStrongQaMatch) {
    const priced = lookupTariffForQuestion(question, tariffs);
    if (priced.kind === 'single' || priced.kind === 'variants') {
      // Клиенту перечень вариантов не выкладывается. Владелец бюро: «Ну смысл
      // говорить цену нот. зав. и срочного, если непонятно, какой документ и
      // какая общая цена. Человек так запутается». Сотруднику наоборот нужен
      // весь список — он считает сам.
      const listVariants = priced.kind === 'variants' && audience === 'internal';
      const body =
        priced.kind === 'single'
          ? describeTariff(priced.tariff)
          : listVariants
            ? `${priced.service} — цена зависит от срока:\n${priced.tariffs.map(describeTariff).join('\n\n')}`
            : `${priced.service} — цена зависит от срока: от ${formatAmountRange(priced.tariffs)}. Скажите, к какому числу нужно, — назову точную сумму.`;

      console.log(
        '[enhanced-answering] Ответ из прайса:',
        priced.kind === 'single' ? priced.tariff.serviceName : priced.service
      );
      return buildGuardrailShell(
        question,
        `${body}\n\nЕсли нужен точный расчёт по вашему пакету документов — напишите, что именно нужно перевести и заверить.`,
        [priced.kind === 'single' ? describeTariff(priced.tariff) : priced.tariffs.map(describeTariff).join(' | ')]
      );
    }
  }

  if (confidenceLevel === 'insufficient' && !hasStrongQaMatch && shouldUseGeneralKnowledgeFallback(question)) {
    const guardrail = buildDeterministicGuardrailResult(question, audience);
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
  // Преамбула тоже учит модель словарю: сказав ей «отвечай только по
  // приведённым цитатам», мы получаем от неё «в цитатах не указано» в ответе
  // клиенту. Для клиентской ветки то же требование формулируется, не называя
  // источник, — иначе запрет в системном промпте спорит с этой строкой и
  // проигрывает ей по частоте.
  const scenarioPreamble =
    audience === 'client'
      ? `Тема обращения: ${scenarioLabelForAnswer}. Ниже — проверенные сведения по ней. Опирайся только на них; не называй их, не описывай, откуда они у тебя, и не сообщай, если чего-то в них не оказалось. Не упоминай процедуры и учреждения, которых там нет.\n`
      : openKnowledgeLookup
        ? `СЦЕНАРИЙ: ${scenarioLabelForAnswer}\nВсе цитаты ниже найдены открытым поиском по базе знаний. Отвечай только по приведенным цитатам. НЕ упоминай другие процедуры, регионы или учреждения, которых нет в этих цитатах.\n`
        : `СЦЕНАРИЙ: ${scenarioLabelForAnswer}  (ключ: ${scenarioKeyForAnswer})\n` +
          `Все цитаты ниже относятся к этому сценарию. НЕ упоминай другие процедуры (например другие регионы или учреждения), даже если они существуют вообще.\n`;

  const systemPrompt = audience === 'client' ? CLIENT_ANSWERING_PROMPT : ENHANCED_ANSWERING_PROMPT;

  let answer: string;
  try {
    answer =
      (await createChatCompletion({
      callLog: {
        callSite: 'enhanced-answering.synthesis',
        question,
        ...(sessionId !== undefined && { sessionId }),
      },
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `${scenarioPreamble}
Вопрос пользователя: ${question}

${audience === 'client' ? '═══ ПРОВЕРЕННЫЕ СВЕДЕНИЯ ═══' : '═══ ЦИТАТЫ ИЗ БАЗЫ ЗНАНИЙ ═══'}
${context}

═══ ЗАДАЧА ═══
${confidenceLevel === 'insufficient'
              ? audience === 'client'
                ? 'Подходящих сведений ниже нет. Ничего не выдумывай и НЕ пиши клиенту, что данных не нашлось. Ответь коротко: разберём случай индивидуально, — и предложи связаться с нами.'
                : 'Релевантных цитат не найдено. Ответь: "В базе знаний по этому вопросу нет данных." Ни в коем случае не выдумывай факты.'
              : audience === 'client'
                ? 'Опирайся только на сведения выше. Цены и сроки — дословно оттуда. Чего там нет — просто не упоминай; не сообщай клиенту, что каких-то данных у тебя не оказалось, и никак не называй свой источник.'
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
      consistency = await verifyAnswer(answer, synthesisSources);
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
              // Тот же промпт, что и при первичной генерации: иначе клиентский
              // ответ переписывается по внутренним правилам, которым разрешено
              // цитировать адреса и писать «в источнике не указано».
              { role: 'system', content: systemPrompt },
              {
                role: 'user',
                content: `${scenarioPreamble}
Вопрос пользователя: ${question}

${audience === 'client' ? '═══ ПРОВЕРЕННЫЕ СВЕДЕНИЯ ═══' : '═══ ЦИТАТЫ ИЗ БАЗЫ ЗНАНИЙ ═══'}
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
            consistency = await verifyAnswer(answer, synthesisSources);
          }
        } catch (e) {
          console.warn('[enhanced-answering] Regeneration failed, keeping original answer:', e);
        }

        // Persist telemetry — fire-and-forget, never block the response.
        // Молчит только при telemetryMode==='disabled' (прогон золотого
        // корпуса); для реального пользователя режим не задаётся и запись идёт
        // как прежде.
        recordHallucinationLog(telemetryMode, {
          sessionId: sessionId ?? null,
          question,
          scenarioKey: scenarioKeyForAnswer ?? null,
          initialAnswer: initialAnswerForLog,
          regeneratedAnswer: regenerated ? answer : null,
          unsupportedClaims: detectedUnsupported as unknown as object,
          unsupportedCount: detectedUnsupported.length,
          regenerated,
        });
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
  // Сигнализация клиентского контура. Фильтрация уже произошла на уровне
  // данных; если наружу всё равно просочился маршрут мимо бюро — значит знание
  // размечено неверно. Такой ответ идёт человеку, а метку надо починить.
  // Молча вырезать фразы нельзя: ошибка разметки останется невидимой.
  const clientSafety = audience === 'client' ? checkClientSafety(answer) : null;
  if (clientSafety && !clientSafety.safe) {
    logClientSafetyVerdict(clientSafety.violations, rules.map((r) => r.ruleCode).join(', '));
  }

  // Заземление числовых утверждений. Проверяем по `synthesisSources` — тому,
  // что реально ушло в промпт. Не по массиву citations: он обрезан до 200
  // символов на правило, и цена за обрезом дала бы ложную тревогу.
  //
  // Ловится ровно то, чего не видит ни один другой контроль: число, которого не
  // было в источниках. Модель могла его сложить (440 × 3 + 1100 = 2420),
  // перенести из соседней строки прайса или выдумать. Consistency gate этого не
  // замечает — он проверяет подкреплённость утверждений, а не происхождение цифр.
  const grounding = checkClaimGrounding(answer, synthesisSources);
  if (!grounding.grounded) {
    console.warn(
      '[enhanced-answering] ЗАЗЕМЛЕНИЕ: числа не найдены в источниках (%d из %d) [audience=%s]:',
      grounding.ungrounded.length,
      grounding.total,
      audience,
      grounding.ungrounded.map((c) => `${c.value} (${c.kind}) ← «${c.context}»`).join(' | ')
    );
  }

  // Клиенту неподтверждённое число отправлять нельзя: цена и срок — это
  // обещание, за которым стоят деньги. Внутреннему контуру ответ отдаётся:
  // сотрудник видит источники и способен проверить сам, а глушить ему выдачу
  // означало бы лишить его инструмента.
  const ungroundedBlocksClient = audience === 'client' && !grounding.grounded;

  // Приписка цены. Заземление проверяет ПРОИСХОЖДЕНИЕ числа и потому слепо к
  // самой дорогой ошибке: «нотариальное заверение перевода — 260 рублей за
  // страницу». Число из источников, и всё же это противоречие прайсу — 260 ₽/стр
  // стоит заверение КОПИИ, а перевода 1100 ₽/док. Здесь ответ сверяется с
  // таблицей прайса напрямую. В отличие от заземления, вердикт действует на оба
  // контура: сотруднику назвать клиенту чужой тариф так же нельзя.
  const priceAttribution = checkCertificationPriceAttribution(answer);
  if (!priceAttribution.consistent) {
    logPriceContradictions(priceAttribution.contradictions, rules.map((r) => r.ruleCode).join(', '));
  }

  // Сверка названных сумм с прайсом — последний рубеж.
  //
  // Проверка приписки выше знает только таблицу заверения; здесь сверяется весь
  // прайс. Признак ошибки узкий и потому надёжный: сумма НЕ встречается среди
  // действующих цен той услуги, которая названа в том же предложении. Замер:
  // 29 подложенных ошибок из 29 пойманы, ложных тревог на 156 сохранённых
  // ответах бота — ноль (`scripts/verify-stale-price.ts`,
  // `scripts/audit-stale-price-fp.ts`).
  //
  // Вердикт действует на оба контура: назвать клиенту прошлогоднюю цену
  // сотрудник не вправе так же, как и бот.
  const stalePrice = checkStalePrice(answer, tariffs);
  if (!stalePrice.ok) {
    console.warn(
      '[enhanced-answering] ПРАЙС: сумма не найдена среди действующих цен услуги [audience=%s]: %s',
      audience,
      stalePrice.findings
        .map((f) => `${f.amount} ₽ при «${f.serviceHint}» (действует ${f.currentAmounts.join(', ')})`)
        .join(' | ')
    );
  }

  // Под SCOPE_NULL_STRICT confidence-top пулы (byConfidence/qaRecent/чанки
  // выше нормального порога) уже не пропускают scenarioKey=null бесплатно —
  // такой контент попадает в финальный ответ ТОЛЬКО через keyword-match пул
  // (реальное вхождение терма вопроса в тело). Раз он всё же прошёл — тема
  // не подтверждена, только keyword; оператор должен это увидеть.
  const unscopedContentInAnswer =
    SCOPE_NULL_STRICT &&
    (rules.some((r) => r.scenarioKey === null) ||
      qaPairs.some((qa) => qa.scenarioKey === null) ||
      contextChunks.some((c) => c.scenarioKey === null));

  // Причины собираются ЗДЕСЬ ЖЕ, из тех же выражений, а не отдельной функцией:
  // объяснение, посчитанное второй раз, разойдётся с решением, которое оно
  // объясняет. Ровно так у песочницы появилась вторая копия политики отправки.
  // РЕЕСТР КОНТРОЛЕЙ. Тип `Record<HumanReviewReason, …>` обязывает: добавили
  // значение в перечисление причин — компилятор потребует и проверку, забыли
  // проверку — сборка не пройдёт.
  //
  // Так было не всегда. Сначала стояли восемь отдельных `if`, а флаг выводился
  // из длины списка причин, и я считал это защитой: контроль без причины
  // окажется бездействующим, а не молча работающим. Аудит Codex перевернул
  // довод — для контроля БЕЗОПАСНОСТИ «бездействующий» означает молча снятую
  // защиту, и это хуже, чем защита без объяснения. Реестр убирает саму
  // возможность: проверка и её причина — одна запись.
  //
  // Каждая проверка возвращает либо находку с подробностью для оператора, либо
  // `null`. Подробность — не название класса, а то, что именно найдено: без неё
  // нельзя отличить спасённого клиента от зря удержанного верного ответа.
  const HUMAN_REVIEW_CHECKS: Record<HumanReviewReason, () => ReasonDetail | null> = {
    consistency_failed: () =>
      consistency?.verificationFailed
        ? { reason: 'consistency_failed', detail: 'проверка утверждений не завершилась' }
        : null,
    unsupported_claims: () =>
      consistency?.unsupported.length
        ? {
            reason: 'unsupported_claims',
            detail: consistency.unsupported.map((c) => `«${c.claim}»`).join('; '),
          }
        : null,
    unscoped_content: () =>
      unscopedContentInAnswer
        ? {
            reason: 'unscoped_content',
            detail:
              'ответ опирается на правило/QA/чанк без узла в дереве сценариев (scenarioKey=null), допущенный только через keyword-совпадение',
          }
        : null,
    knowledge_gap_phrase: () =>
      answerSignalsKnowledgeGap(answer)
        ? { reason: 'knowledge_gap_phrase', detail: 'ответ признаёт отсутствие данных' }
        : null,
    composite_capability_risk: () =>
      answerSignalsCompositeCapabilityRisk(question, answer)
        ? {
            reason: 'composite_capability_risk',
            detail: 'утверждение о возможности без прямого подтверждения',
          }
        : null,
    client_safety: () =>
      clientSafety && !clientSafety.safe
        ? { reason: 'client_safety', detail: clientSafety.violations.join('; ') }
        : null,
    ungrounded_numbers: () =>
      ungroundedBlocksClient
        ? {
            reason: 'ungrounded_numbers',
            detail: grounding.ungrounded.map((c) => `${c.value} (${c.kind})`).join('; '),
          }
        : null,
    price_attribution: () =>
      priceAttribution.consistent
        ? null
        : {
            reason: 'price_attribution',
            detail: priceAttribution.contradictions
              .map((c) => `${c.serviceLabel}: назвал ${c.claimed}, прайс ${c.expected}`)
              .join('; '),
          },
    stale_price: () =>
      stalePrice.ok
        ? null
        : {
            reason: 'stale_price',
            detail: stalePrice.findings
              .map((f) => `${f.amount} ₽ при «${f.serviceHint}», действует ${f.currentAmounts.join(', ')}`)
              .join('; '),
          },
  };

  // Перебираются КЛЮЧИ РЕЕСТРА, а не список порядка. Порядок влияет только на
  // то, как причины лягут в отчёт.
  //
  // Так не было. Сначала перебирался `HUMAN_REVIEW_ORDER`, написанный руками, и
  // контроль, забытый в этом списке, молча не выполнялся вовсе — при чистой
  // сборке. То есть дыра «тихой смерти защиты», которую реестр закрывал, просто
  // переехала на строку ниже. Найдено независимым аудитом Kimi K3 и
  // воспроизведено: удаление `stale_price` из порядка оставляет `tsc` чистым.
  //
  // Сбой одной проверки не снимает остальные и не открывает ворота: упавшая
  // проверка считается СРАБОТАВШЕЙ. Ответ уйдёт человеку, и человек увидит, что
  // именно сломалось. Обратное — молча пропустить ответ клиенту, потому что
  // сторож упал, — для контроля безопасности недопустимо.
  const humanReviewReasons = (Object.keys(HUMAN_REVIEW_CHECKS) as HumanReviewReason[])
    .sort((a, b) => HUMAN_REVIEW_ORDER.indexOf(a) - HUMAN_REVIEW_ORDER.indexOf(b))
    .map((reason): ReasonDetail | null => {
      try {
        return HUMAN_REVIEW_CHECKS[reason]();
      } catch (e) {
        console.error('[enhanced-answering] контроль «%s» упал:', reason, e);
        return { reason, detail: `проверка не выполнилась: ${String(e).slice(0, 160)}` };
      }
    })
    .filter((item): item is ReasonDetail => item !== null);

  const requiresHumanReview = humanReviewReasons.length > 0;

  const answerReasons: AnswerReasons = {
    humanReview: humanReviewReasons,
    tariffContext: { sections: tariffContext.sections, rows: tariffContext.count },
    // Незаземлённые числа показываются ВСЕГДА, а не только когда они удержали
    // ответ: внутреннему контуру они ответ не блокируют, но сотруднику знать о
    // них надо — он отправляет этот текст клиенту своими руками.
    ungroundedValues: grounding.ungrounded.map((c) => `${c.value} ${c.unit ?? ''}`.trim()),
    stalePrices: stalePrice.findings.map((f) => `${f.amount} ₽ при «${f.serviceHint}»`),
    priceContradictions: priceAttribution.contradictions.map(
      (c) => `${c.serviceLabel}: ${c.claimed} против ${c.expected}`
    ),
  };

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

  // Цитаты-подтверждения: ровно те источники, которые заземлили числа ответа.
  const evidenceCitations = buildEvidenceCitations(grounding.supported, synthesisEvidence);

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
  const ruleCitations = citationRules.map((r) => {
    const authority = getVoiceAuthority(r.sourceSpan);
    return {
      ruleCode: r.ruleCode,
      documentTitle: r.document?.title,
      quote: ruleQuote(r.body),
      relevanceScore: r.documentId ? (docScoreByDocId.get(r.documentId) ?? 0) : 0,
      authorityTag: authority.authorityTag,
      priority: authority.priority,
    };
  });

  // Подтверждения идут ПЕРВЫМИ, тематические правила — следом, до общего
  // предела. Правила не выбрасываются: у ответа без чисел подтверждать нечего,
  // и там прежний список — единственный осмысленный. Порядок важен: первой
  // пользователь читает ту цитату, в которой названная сумма действительно
  // стоит, а не ту, что просто пришла из релевантного документа.
  const citations = mergeCitations(evidenceCitations, ruleCitations);

  // Отказ не опирается на цитаты: модель получила приказ «нет данных».
  // Оставлять правила в «источниках» — тот же обман, что и knowledge_base.
  const answerSource = resolveMainPathAnswerSource(confidenceLevel);
  const grounded = answerSource === 'knowledge_base';

  const result: EnhancedAnswerResult = {
    answer,
    confidence: overallConfidence,
    confidenceLevel,
    needsClarification,
    suggestedClarification,
    citations: grounded ? citations : [],
    domainsUsed: intentResult.domains,
    queryAnalysis: {
      originalQuery: question,
      expandedQueries: expandedQueries.variants,
      extractedEntities: entities,
      isAmbiguous: expandedQueries.isAmbiguous,
    },
    clarificationQuestion,
    primarySource: grounded ? primarySource : undefined,
    supplementarySources: grounded ? supplementarySources : undefined,
    scenarioKey: scenarioKeyForAnswer,
    scenarioLabel: scenarioLabelForAnswer,
    answerSource,
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
      reasons: answerReasons,
    };
  }

  return result;
}

/**
 * Guardrail'ы писались для внутреннего контура: их текст объясняет сотруднику,
 * что апостиль ставится по месту выдачи и куда клиенту идти. Клиенту такой
 * ответ выдавать нельзя — это отказ плюс отправка мимо бюро.
 *
 * Подтверждённой клиентской альтернативы для документа из чужого региона в базе
 * пока нет (правила про апостиль на нотариальную копию противоречат друг другу,
 * R-410/R-967 против R-407/R-1494), поэтому клиентский контур на таких вопросах
 * уходит к человеку: внутренний текст остаётся черновиком для оператора, а
 * клиент получает передачу коллеге. Как только правило «что мы предлагаем
 * вместо» появится в базе, здесь встанет продающий ответ.
 */
/**
 * Клиентский вариант текста, если ветка его написала.
 *
 * Прежде клиенту глушился ЛЮБОЙ детерминированный ответ — и это было верно,
 * пока все ветки писались для сотрудника: их текст содержит «ставится по месту
 * выдачи», то есть отправляет клиента делать услугу самостоятельно.
 *
 * Но ветки территориальности пишут клиенту прямо, и глушить их — терять самое
 * ценное. Ответ «да, диплом из любого региона апостилируем здесь» — это заказ;
 * заменять его на «уточню у коллеги» значит своими руками отдавать клиента
 * думать дальше. Поэтому ветка объявляет клиентский текст явно, а всё, что его
 * не объявило, по-прежнему удерживается.
 */
const CLIENT_ANSWER_KEY = '__clientAnswer';

type GuardrailWithClientText = EnhancedAnswerResult & { [CLIENT_ANSWER_KEY]?: string };

function buildDeterministicGuardrailResult(
  question: string,
  audience: Audience
): EnhancedAnswerResult | null {
  const result = buildInternalGuardrailResult(question) as GuardrailWithClientText | null;
  if (!result) return null;

  const { [CLIENT_ANSWER_KEY]: clientAnswer, ...clean } = result;
  if (audience !== 'client') return clean;

  if (clientAnswer) return { ...clean, answer: clientAnswer };

  // Клиентского варианта нет — текст написан для сотрудника, наружу нельзя
  // даже как черновик: потребитель API может взять поле answer напрямую.
  return {
    ...clean,
    answer:
      'Такой случай нужно разобрать индивидуально — уточню детали и вернусь с решением и стоимостью.',
    confidenceLevel: 'low',
    requiresHumanReview: true,
  };
}

/** Точки входа для тестов: см. scripts/verify-territorial-guardrail.ts. */
export function buildInternalGuardrailResultForTests(
  question: string
): EnhancedAnswerResult | null {
  return buildInternalGuardrailResult(question);
}

export function buildDeterministicGuardrailResultForTests(
  question: string,
  audience: Audience
): EnhancedAnswerResult | null {
  return buildDeterministicGuardrailResult(question, audience);
}

/**
 * Границы цены по вариантам одной услуги — для клиента, которому перечень
 * вариантов не выкладывается.
 */
function formatAmountRange(tariffs: { amount: number | null }[]): string {
  const amounts = tariffs.map((t) => t.amount).filter((a): a is number => a !== null);
  if (amounts.length === 0) return 'уточню';
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  const money = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;
  return min === max ? money(min) : `${money(min)} до ${money(max)}`;
}

/** Сколько символов источника уходит в цитату. */
const CITATION_QUOTE_CHARS = 200;

/** Сколько цитат показывается пользователю всего. */
const MAX_CITATIONS = 5;

/**
 * Оценка для цитаты-подтверждения. У прайсовой строки и Q&A-пары своего
 * retrieval-скора нет — они попадают в контекст не поиском. Ставится максимум
 * и это не подгонка: «источник содержит названное в ответе значение дословно»
 * — более сильное отношение к вопросу, чем любая семантическая близость
 * документа, которой измеряются остальные цитаты.
 */
const EVIDENCE_RELEVANCE = 1;

export interface EvidenceCitation {
  ruleCode?: string;
  documentTitle?: string;
  quote: string;
  relevanceScore: number;
}

/** Одинаковая обрезка в обоих местах — иначе одна и та же цитата правила
 *  приходит из подтверждений и из тематических правил как две разные. */
function ruleQuote(body: string): string {
  return body.slice(0, CITATION_QUOTE_CHARS) + (body.length > CITATION_QUOTE_CHARS ? '...' : '');
}

/** Источник синтеза вместе с тем, чем его предъявить пользователю. */
export interface SynthesisEvidence {
  /** Текст, который ушёл в промпт и по которому идёт заземление. */
  readonly text: string;
  readonly citation: EvidenceCitation;
}

/**
 * Цитаты из источников, которые РЕАЛЬНО заземлили числа ответа.
 *
 * Раньше цитаты брались только из правил, а цена приходила из прайса или из
 * Q&A-пары — источник ответа в пул цитат не попадал по построению, и
 * подтверждающая цитата не могла появиться в принципе (translation-ijy,
 * замер: 76% названных сумм без подтверждения). Здесь связь обратная:
 * цитата выводится из заземления, поэтому подтверждает по построению, а не
 * по совпадению темы.
 *
 * Порядок — по порядку появления утверждений в ответе: пользователь читает
 * цитаты в том же порядке, в каком встретил числа.
 */
export function buildEvidenceCitations(
  supported: readonly GroundedClaim[],
  evidence: readonly SynthesisEvidence[]
): EvidenceCitation[] {
  const seen = new Set<number>();
  const out: EvidenceCitation[] = [];
  for (const claim of supported) {
    for (const index of claim.sourceIndexes) {
      // Одно число может стоять в нескольких источниках. Показывается первый:
      // остальные то же самое подтвердят повторно и вытеснят подтверждения
      // ОСТАЛЬНЫХ чисел ответа за предел списка.
      if (seen.has(index)) continue;
      seen.add(index);
      const item = evidence[index];
      if (item) {
        // Фрагмент ВОКРУГ подтверждающего числа, а не первые N символов
        // источника: в длинном чанке или теле правила число часто стоит
        // дальше, и цитата-префикс не содержала бы того, что подтверждает.
        const excerpt = claimExcerpt(item.text, claim.unit, claim.value, CITATION_QUOTE_CHARS);
        out.push(excerpt ? { ...item.citation, quote: excerpt } : item.citation);
      }
      break;
    }
  }
  return out;
}

/** Подтверждения впереди, остальное следом, без дублей, до предела. */
export function mergeCitations<T extends EvidenceCitation>(
  evidenceCitations: readonly EvidenceCitation[],
  ruleCitations: readonly T[]
): (EvidenceCitation | T)[] {
  const merged: (EvidenceCitation | T)[] = [];
  const seenQuotes = new Set<string>();
  for (const citation of [...evidenceCitations, ...ruleCitations]) {
    const key = `${citation.ruleCode ?? ''}|${citation.quote}`;
    if (seenQuotes.has(key)) continue;
    seenQuotes.add(key);
    merged.push(citation);
    if (merged.length >= MAX_CITATIONS) break;
  }
  return merged;
}

/** Общая обвязка детерминированного ответа: разная у веток только суть. */
function buildGuardrailShell(
  question: string,
  answer: string,
  quotes: string[],
  /** Текст для клиента. Без него клиенту уйдёт удерживающая фраза. */
  clientAnswer?: string
): EnhancedAnswerResult {
  return {
    answer,
    ...(clientAnswer ? { [CLIENT_ANSWER_KEY]: clientAnswer } : {}),
    confidence: 0.9,
    confidenceLevel: 'medium',
    needsClarification: false,
    citations: quotes.map((quote) => ({
      documentTitle: 'Операционный guardrail',
      quote,
      relevanceScore: 0.9,
    })),
    domainsUsed: ['legal_compliance'],
    queryAnalysis: {
      originalQuery: question,
      expandedQueries: [],
      extractedEntities: { dates: [], prices: [], documentTypes: [], services: ['апостиль'] },
      isAmbiguous: false,
    },
    answerSource: 'deterministic_guardrail',
    requiresHumanReview: false,
  };
}

/**
 * К чему подшивается нотариальный перевод. Ветка стоит ПЕРВОЙ, до всего
 * апостильного: замер показал, что шесть формулировок одного вопроса дают
 * четыре разных ответа, и в четырёх из шести бот утверждает «нужен именно
 * оригинал» — то есть противоречит фактам и своими руками отказывает клиенту
 * из другого города, которому мы можем сделать всё удалённо.
 */
function buildSourceRouteResult(question: string): EnhancedAnswerResult | null {
  const verdict = resolveSourceDocumentRoute(question);
  if (verdict.kind === 'unknown') return null;

  const routes = SOURCE_DOCUMENT_ROUTES;
  const table = routes
    .map((r) => `— ${r.label}: оригинал ${r.originalRequired ? 'нужен' : 'НЕ нужен'}; выбирается, когда ${r.chosenWhen};`)
    .join('\n');

  if (verdict.kind === 'strict_destination') {
    const answer = [
      'Исходник для нотариального перевода бывает трёх видов, но названная инстанция относится к строгим, и для неё исходник должен быть заверенным: либо нотариальная копия, либо оригинал документа. Простой ксерокопии в таком случае недостаточно.',
      '',
      'Для обоих этих маршрутов нужен физический оригинал: нотариус обязан увидеть его, чтобы засвидетельствовать верность копии.',
      '',
      table,
    ].join('\n');

    const clientAnswer = [
      'Для такой подачи перевод нужно подшивать к заверенной копии — либо к нотариальной копии документа, либо к самому оригиналу. Обычной ксерокопии здесь не хватит.',
      '',
      'Значит, оригинал понадобится: наш нотариус снимет с него копию, а перевод подошьём уже к ней — или, если требуется, к самому оригиналу.',
      '',
      'Пришлите, пожалуйста, скан документа и скажите, куда именно его подаёте, — подтвержу, как лучше сделать, и назову стоимость и срок.',
    ].join('\n');

    return buildGuardrailShell(
      question,
      answer,
      ['Строгая инстанция требует заверенного исходника: нотариальная копия или оригинал (правила компании, §5 разбора цен со слов владельца).'],
      clientAnswer
    );
  }

  const answer = [
    'Исходник для нотариального перевода бывает трёх видов, и выбор определяется не предпочтением клиента, а дальнейшим путём документа:',
    '',
    table,
    '',
    'Нотариус, заверяя перевод, свидетельствует подлинность подписи переводчика, а не сам документ (ст. 80–81 Основ о нотариате), поэтому для этого действия оригинал не требуется. Оригинал обязателен там, где свидетельствуется верность копии (ст. 77) — то есть на маршруте нотариальной копии.',
    '',
    'Прежде чем называть маршрут, надо выяснить, куда подаётся документ.',
  ].join('\n');

  // Клиенту — то же самое, но начиная с возможности, а не с ограничений: сегодня
  // на этот вопрос он получает «нужен оригинал, привезите или пришлите почтой»,
  // и это неверно и стоит заказов. При этом «оригинал не нужен» тоже нельзя
  // говорить как обещание: маршрут задаёт принимающая сторона. Поэтому условие
  // названо прямо в той же фразе.
  // Язык — как у менеджеров в переписке, а не мой. Владелец бюро потребовал
  // прямо: «Пусть не выдумывает слова! А берёт из ответов менеджеров в истории
  // переписки». Проверено по корпусу из 180 реальных ответов: слово «маршрут»
  // не встречается НИ РАЗУ, «исходник» — только про файлы. Менеджеры говорят
  // «подшиваем к ксерокопии», «привезти оригинал для подшития», «пришлите скан».
  const clientAnswer = [
    'Зависит от того, куда вы подаёте документ.',
    '',
    'Если там не требуют, чтобы перевод был подшит к заверенной копии, мы подошьём его к обычной ксерокопии: вы присылаете скан или фото, мы распечатываем у себя, подшиваем и заверяем у нотариуса. Оригинал привозить не нужно, приезжать тоже — отправим готовое.',
    '',
    'Если документ идёт на апостиль, на легализацию или в инстанцию со строгими требованиями, перевод подшивается к нотариальной копии. Для неё оригинал нужно принести или прислать — нотариус обязан его увидеть.',
    '',
    'Третий вариант — подшить перевод прямо к оригиналу, если этого требуют. Тогда оригинал останется сшитым с переводом.',
    '',
    'Скажите, пожалуйста, что за документ и куда его подаёте, — подскажу, какой вариант нужен, и назову стоимость и срок. Скан или фото можно прислать прямо сейчас.',
  ].join('\n');

  return buildGuardrailShell(
    question,
    answer,
    ['Три маршрута исходника: простая копия, нотариальная копия, оригинал; выбор определяется дальнейшим путём документа (слова владельца, §5).'],
    clientAnswer
  );
}

/**
 * Перевод для суда. Ветка написана по прямому указанию владельца бюро после
 * забракованного живого ответа: бот предложил «присяжный перевод» как вариант
 * для российского суда, а такой услуги в России не существует вовсе.
 *
 * Слова владельца: «В России нотариальный перевод или перевод штампами в
 * зависимости от требований в конкретной ситуации. Но лучше нотариальный.
 * Если суд за рубежом, тогда там могут быть присяжные переводчики, но цену
 * такого перевода бот рассчитать не сможет».
 */
function buildCourtTranslationResult(question: string): EnhancedAnswerResult | null {
  const verdict = resolveCourtTranslation(question);
  if (verdict.kind === 'unknown') return null;

  if (verdict.kind === 'foreign_court') {
    const answer = [
      'Суд за рубежом: требования к переводу задаёт та страна. Там может действовать институт присяжного переводчика, которого в России нет, и стоимость такого перевода мы не рассчитываем.',
      '',
      'Что делаем мы: нотариальный перевод по российской процедуре и, если требуется, апостиль или консульскую легализацию. Подойдёт ли это конкретному суду — вопрос к принимающей стороне.',
    ].join('\n');

    const clientAnswer = [
      'Требования к переводу для зарубежного суда задаёт та страна, и уточнить их нужно у самого суда: где-то принимают перевод присяжного переводчика той страны — такой перевод мы не делаем и его стоимость не считаем.',
      '',
      'Со своей стороны мы делаем нотариальный перевод по российской процедуре и, если понадобится, апостиль или консульскую легализацию — этого достаточно для большинства случаев.',
      '',
      'Напишите, пожалуйста, какая страна и какой документ, — подскажу, что из этого понадобится, и назову стоимость и срок.',
    ].join('\n');

    return buildGuardrailShell(
      question,
      answer,
      ['Института присяжного перевода в России нет; для зарубежного суда требования задаёт страна назначения (указание владельца, 31.07.2026).'],
      clientAnswer
    );
  }

  const answer = [
    'Для суда в России есть два варианта заверения: нотариальный перевод или перевод, заверенный подписью переводчика и штампом бюро. Что именно требуется, зависит от конкретной ситуации, но предпочтительнее нотариальный.',
    '',
    'ПРИСЯЖНОГО ПЕРЕВОДА В РОССИИ НЕ СУЩЕСТВУЕТ — этот институт есть за рубежом, и предлагать его клиенту как вариант для российского суда нельзя.',
  ].join('\n');

  const clientAnswer = [
    'Для суда в России подойдёт один из двух вариантов: нотариальный перевод либо перевод, заверенный подписью переводчика и штампом нашего бюро. Что именно попросят, зависит от конкретной ситуации, но надёжнее нотариальный — его принимают везде.',
    '',
    'Пришлите, пожалуйста, скан документа и скажите, какой язык нужен, — назову стоимость и срок, и подскажу, какого заверения будет достаточно.',
  ].join('\n');

  return buildGuardrailShell(
    question,
    answer,
    ['Для суда в РФ: нотариальный перевод или заверение штампом бюро, предпочтительнее нотариальный; присяжного перевода в России нет (указание владельца, 31.07.2026).'],
    clientAnswer
  );
}

function buildInternalGuardrailResult(question: string): EnhancedAnswerResult | null {
  // Порядок значим. Вопрос про исходник разбирается ПЕРВЫМ, даже когда в нём
  // упомянут суд: «нужен ли оригинал для перевода в суд» — это вопрос про
  // оригинал, и отвечать на него рассказом про виды заверения значит отвечать
  // не на заданный вопрос. Ветка суда забирает только то, где про исходник не
  // спрашивали: «какой пакет документов нужен для суда».
  const sourceRoute = buildSourceRouteResult(question);
  if (sourceRoute) return sourceRoute;

  const court = buildCourtTranslationResult(question);
  if (court) return court;

  // All regexes use /iu flags and test the ORIGINAL question directly.
  // Never call normalizeRussianText() here — its toLowerCase() silently corrupts
  // Cyrillic to U+FFFD on some Alpine Linux / Node 20 (small-icu) deployments.
  const mentionsApostille = /апостил/iu.test(question);
  const mentionsSpb = /санкт\s*петербург|петербург|(?:^|[^а-яё])спб(?:[^а-яё]|$)/iu.test(question);
  const mentionsMoscow = /москв/iu.test(question);
  // Кроме вопросов «как/можно» сюда обязаны попадать заявления о потребности:
  // «нужен апостиль», «требуется апостиль», «хочу апостиль». Замер на проде
  // показал, что именно на них ветка молчала, и клиент вместо продающего ответа
  // получал «уточню у коллеги» — при том что решение у нас есть. Формулировка
  // «нужен апостиль на справку о несудимости из Саратова» — самая частая у
  // клиента, и она не содержит ни одного глагола прежнего списка.
  const asksHowOrCan =
    /как|можн|нельзя|получится|сдела|постав|простав|подат|оформ|нужен|нужна|нужно|требуется|необходим|хочу|надо|интересует/iu.test(
      question
    );
  const mentionsEducation =
    /образован|диплом|аттестат|вуз|университет|колледж|школ/iu.test(question);

  // "Другой регион" path: a ЗАГС document issued OUTSIDE СПб/ЛО (the user picked
  // the "Другой регион" option or named a non-local city). The bureau apostilles
  // ЗАГС ORIGINALS only at the place of issue it serves (СПб/ЛО); an original
  // from another region must be apostilled THERE. Explain that + offer the
  // notarized-copy alternative. Fires only when it's NOT the mirror case (which
  // mentions both СПб and Москва and has its own directional answer below).
  // Территориальность решает ОДНА таблица — apostille-authority.ts, собранная
  // по тетради стажёра. Раньше решение было размазано: здесь регулярка про
  // ЗАГС, ниже отдельная ветка про Москву, а справка о несудимости из чужого
  // региона не попадала никуда и уходила в свободный синтез. Ниже по тексту
  // различается только ФОРМУЛИРОВКА ответа по органам; сам вывод «берём или
  // нет» приходит из таблицы.
  const territorial = resolveApostilleTerritoriality(question);

  if (mentionsApostille && territorial.kind === 'reject_original' && territorial.authority.key === 'zags') {
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

  // Остальные территориальные органы: Минюст и МВД. Раньше сюда не доходил
  // никто — ветка ниже требует, чтобы в вопросе были названы ОБА города, а
  // «справка о несудимости выдана в Саратове» не называет ни одного. Именно на
  // этом классе бот сочинял, что апостиль можно поставить в Петербурге.
  if (mentionsApostille && asksHowOrCan && territorial.kind === 'reject_original') {
    const { authority } = territorial;
    const answer = [
      `Апостиль на такой документ ставит ${authority.label}, и у этого органа действует территориальный признак: апостилируются только документы, выданные в том же регионе. Документ выдан в другом регионе — значит, апостиль на оригинал ставится по месту выдачи, и здесь мы этого сделать не можем.`,
      '',
      // Сноска тетради: чем закрывать вопрос, когда прямой путь закрыт.
      'Что можно предложить: апостиль на НОТАРИАЛЬНУЮ КОПИЮ документа — её снимает наш нотариус, и она становится документом, выданным здесь. Апостиль на оригинал всегда предпочтительнее, поэтому этот вариант подходит, только если принимающая сторона допускает апостиль на копию. Требования лучше уточнить заранее.',
      '',
      `Сроки органа: ${authority.deadline}. Доверенность: ${authority.powerOfAttorney}.`,
      ...(authority.footnote ? ['', authority.footnote] : []),
    ].join('\n');

    // Клиенту то же самое, но без слов, которыми мы отправляем его делать
    // услугу самостоятельно: ни «по месту выдачи», ни названий органов с их
    // порядком приёма. Только то, что делаем МЫ.
    const clientAnswer = [
      'Оригинал такого документа апостилируется только в том регионе, где он был выдан, поэтому с оригиналом здесь мы работать не сможем.',
      '',
      'Зато можем решить иначе: наш нотариус снимет с документа копию, и апостиль поставим уже на неё — это полностью наша работа, вам никуда ехать не нужно. Вариант подходит, если принимающая сторона допускает апостиль на копию, а не на оригинал.',
      '',
      'Пришлите, пожалуйста, скан документа и скажите, для какой страны он готовится — проверим требования и назову стоимость и срок.',
    ].join('\n');

    return buildGuardrailShell(
      question,
      answer,
      ['Территориальный признак органа апостилирования (тетрадь стажёра, с. 10): апостилируются только документы, выданные в регионе обращения.'],
      clientAnswer
    );
  }

  // Обратный случай и главный по деньгам: образовательный комитет
  // территориального признака НЕ имеет. Без этой ветки вопрос «можно ли
  // апостилировать саратовский диплом у вас» рискует получить отказ по общему
  // правилу про регион — то есть потерю заказа на ровном месте.
  if (
    mentionsApostille &&
    asksHowOrCan &&
    territorial.kind === 'accept' &&
    territorial.authority.key === 'education' &&
    detectIssuingRegion(question) === 'other'
  ) {
    const { authority } = territorial;
    // «Да, можем» без условий было бы обещанием, которого тетрадь не даёт: у
    // образовательных документов есть чек-лист отказов (с. 11), и без него
    // положительный ответ противоречит фактам, а не просто неполон.
    const answer = [
      `Да, регион не помеха. Образовательные документы апостилирует ${authority.label}, и территориального признака у него нет: диплом или аттестат, выданный в любом регионе России, апостилируется здесь.`,
      '',
      'Что нужно проверить до оформления: документы должны быть вашими собственными, ВУЗ — действующим, документ — неповреждённым, приложение к диплому или аттестату — на руках (без него возможен отказ). И важно: если вы уже подавали заявку на Госуслугах или оплачивали пошлину самостоятельно, документ не примут.',
      '',
      `Сроки: ${authority.deadline}. Доверенность: ${authority.powerOfAttorney}.`,
      ...(authority.footnote ? ['', authority.footnote] : []),
    ].join('\n');

    // Клиентский вариант — это заказ, а не справка. Тот же положительный
    // ответ, но без названия органа и его порядка приёма: клиенту незачем
    // знать, куда мы понесём документ, ему важно, что мы это сделаем.
    const clientAnswer = [
      'Да, регион не помеха: диплом или аттестат, выданный в любом городе России, мы апостилируем здесь — везти документ обратно не нужно.',
      '',
      `Срок обычно ${authority.deadline.replace('официальный срок комитета 45 рабочих дней; на практике ', '')} — по факту быстрее официального норматива.`,
      '',
      'Что понадобится: сам документ обязательно с приложением — без него в приёме откажут. Важно заранее сказать, если вы уже подавали заявку через Госуслуги или сами оплачивали пошлину: в этом случае документ не примут.',
      '',
      'Пришлите скан диплома с приложением — посчитаю точную стоимость и срок.',
    ].join('\n');

    return buildGuardrailShell(
      question,
      answer,
      ['Образовательный комитет НЕ имеет территориального признака: апостилируются документы, выданные в любом ином регионе (тетрадь стажёра, с. 10).'],
      clientAnswer
    );
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

// Пускать ли вопрос в general_ai — ответ БЕЗ опоры на базу знаний.
//
// Здесь словарь услуг уместен, в отличие от снятого гейта на входе в поиск:
// это не «пускать ли к базе», а «разрешено ли отвечать по общим знаниям модели,
// когда база промолчала». Для вопроса вне области ответа быть не должно вовсе,
// поэтому отсутствие услуги в вопросе — законное основание не отвечать.
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

  // Ветка общих знаний — единственная, где базы нет вовсе, и именно здесь бот
  // предложил клиенту «присяжный перевод» для российского суда. Клиенту такой
  // ответ не уходит (ниже requiresHumanReview=true и эскалация), но оператор
  // видит черновик и может утвердить его в базу одной кнопкой — так неверный
  // факт становится каноническим. Поэтому поправка ставится ПЕРЕД текстом.
  const sworn = checkSwornTranslationClaim(answer);
  if (!sworn.safe) {
    console.warn(
      '[enhanced-answering] ПРИСЯЖНЫЙ: общее знание предложило несуществующую в РФ услугу: %s',
      sworn.violations.map((v) => v.sentence).join(' | ')
    );
  }

  return {
    answer: [
      ...(sworn.safe
        ? []
        : [
            '⚠️ НЕ УТВЕРЖДАТЬ В БАЗУ БЕЗ ПРАВКИ: в тексте ниже упомянут присяжный перевод. В России этого института НЕ СУЩЕСТВУЕТ. Для суда в РФ — нотариальный перевод или заверение штампом бюро, предпочтительнее нотариальный. Присяжные переводчики бывают за рубежом, и стоимость такого перевода мы не рассчитываем.',
            '',
          ]),
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
  rules: { ruleCode: string; title: string; body: string; sourceSpan?: unknown }[],
  qaPairs: { question: string; answer: string }[],
  tariffBlock: string = ''
): string {
  let context = '';

  // Прайс идёт ПЕРВЫМ и с явным указанием приоритета. Цены живут ещё и текстом
  // внутри правил, где они устаревают: «20 000 вместо 22 000» — это ровно
  // прошлогодний прайс, оставшийся активным в базе знаний. Пока дублирование не
  // снесено, побеждать должна таблица, сверенная с бумагой.
  if (tariffBlock) {
    context += `${tariffBlock}\n\n`;
  }

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
      const authority = getVoiceAuthority(rule.sourceSpan);
      const marker = authority.authorityTag
        ? ` [VOICE_AUTHORITY:${authority.priority ?? 'HIGH'}]`
        : '';
      context += `[${rule.ruleCode}]${marker} ${rule.title}:\n${rule.body}\n\n`;
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
  audience: Audience,
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
      return answerQuestionEnhanced({
        question: isFollowUp.expandedQuestion,
        audience,
        sessionId,
        includeDebug,
      });
    }
  }

  return answerQuestionEnhanced({ question, audience, sessionId, includeDebug });
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

