import { createChatCompletion } from '@/lib/ai/chat-provider';
import prisma from '@/lib/db';
import { searchSimilarChunks } from './chunker';

export interface AnswerResult {
  answer: string;
  confidence: number;
  citations: {
    ruleCode?: string;
    documentTitle?: string;
    quote: string;
  }[];
  domainsUsed: string[];
  debug?: {
    chunks: { content: string; similarity: number }[];
    intentClassification: string;
  };
}

interface IntentClassification {
  intent: string;
  domains: string[];
  confidence: number;
}

const INTENT_CLASSIFIER_PROMPT = `Ты - классификатор намерений для системы знаний бюро переводов.

Классифицируй вопрос пользователя:
1. Определи намерение (price_query, procedure_query, contact_query, general_info)
2. Определи релевантные домены из списка
3. Оцени свою уверенность

Доступные домены:
- general_ops, notary, pricing, translation_ops, formatting_delivery
- it_tools, hr_internal, sales_clients, legal_compliance

Ответь в формате JSON:
{
  "intent": "строка",
  "domains": ["строка"],
  "confidence": 0.0-1.0
}`;

const ANSWERING_PROMPT = `Ты - ИИ-библиотекарь знаний для бюро переводов.

КРИТИЧЕСКИЕ ПРАВИЛА:
1. Отвечай ТОЛЬКО на основе предоставленных знаний
2. Если знаний недостаточно - чётко скажи об этом
3. Всегда указывай источники
4. Будь краток и точен
5. Отвечай на русском языке

Если не можешь ответить:
- Скажи "Я не нашёл информации по этому вопросу в базе знаний"
- Предложи, какая информация может понадобиться

Для цен и процедур:
- Цитируй точные значения из базы знаний
- Отметь, если информация может быть устаревшей`;

export async function classifyIntent(question: string): Promise<IntentClassification> {
  const content = await createChatCompletion({
    messages: [
      { role: 'system', content: INTENT_CLASSIFIER_PROMPT },
      { role: 'user', content: question },
    ],
    responseFormat: 'json_object',
    temperature: 0.1,
  });
  if (!content) {
    return { intent: 'general_info', domains: [], confidence: 0.5 };
  }

  return JSON.parse(content);
}

export async function answerQuestion(
  question: string,
  includeDebug: boolean = false
): Promise<AnswerResult> {
  // Step 1: Classify intent and domains
  const intentResult = await classifyIntent(question);

  // Step 2: Retrieve relevant chunks
  const chunks = await searchSimilarChunks(
    question,
    intentResult.domains.length > 0 ? intentResult.domains : [],
    5
  );

  // Step 3: Get relevant active rules
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
  });

  // Step 4: Get relevant Q&A pairs
  const qaPairs = await prisma.qAPair.findMany({
    where: {
      status: 'ACTIVE',
      domains: intentResult.domains.length > 0
        ? { some: { domain: { slug: { in: intentResult.domains } } } }
        : undefined,
    },
    take: 5,
  });

  // Build context for the AI
  const context = buildContext(chunks, rules, qaPairs);

  // Step 5: Generate answer
  const answer =
    (await createChatCompletion({
      messages: [
        { role: 'system', content: ANSWERING_PROMPT },
        {
          role: 'user',
          content: `Question: ${question}

Available Knowledge:
${context}

Provide a helpful answer based ONLY on the knowledge above. If the information is not available, say so.`,
        },
      ],
      temperature: 0.3,
    })) || 'Не удалось сформировать ответ';

  // Build citations
  const citations = rules.slice(0, 3).map((r) => ({
    ruleCode: r.ruleCode,
    documentTitle: r.document?.title,
    quote: r.body.slice(0, 200) + (r.body.length > 200 ? '...' : ''),
  }));

  const result: AnswerResult = {
    answer,
    confidence: intentResult.confidence,
    citations,
    domainsUsed: intentResult.domains,
  };

  if (includeDebug) {
    result.debug = {
      chunks: chunks.map((c) => ({ content: c.content.slice(0, 200), similarity: c.similarity })),
      intentClassification: intentResult.intent,
    };
  }

  return result;
}

function buildContext(
  chunks: { content: string }[],
  rules: { ruleCode: string; title: string; body: string }[],
  qaPairs: { question: string; answer: string }[]
): string {
  let context = '';

  if (rules.length > 0) {
    context += '## Business Rules\n';
    for (const rule of rules) {
      context += `[${rule.ruleCode}] ${rule.title}: ${rule.body}\n\n`;
    }
  }

  if (qaPairs.length > 0) {
    context += '## Related Q&A\n';
    for (const qa of qaPairs) {
      context += `Q: ${qa.question}\nA: ${qa.answer}\n\n`;
    }
  }

  if (chunks.length > 0) {
    context += '## Document Excerpts\n';
    for (const chunk of chunks) {
      context += `${chunk.content}\n---\n`;
    }
  }

  return context || 'No relevant knowledge found.';
}

export async function saveChatMessage(
  sessionId: string,
  role: 'USER' | 'ASSISTANT',
  content: string,
  metadata?: Record<string, unknown>
) {
  return prisma.chatMessage.create({
    data: {
      sessionId,
      role,
      content,
      metadata: metadata as object | undefined,
    },
  });
}

export async function getOrCreateSession(source: 'WEB' | 'TELEGRAM' | 'API' = 'WEB', userId?: string) {
  return prisma.chatSession.create({
    data: {
      source,
      userId,
    },
  });
}
