import { NextRequest, NextResponse } from 'next/server';
import { EnhancedAnswerResult } from '@/lib/ai/enhanced-answering-engine';

// In-memory answer cache (1 hour TTL)
const answerCache = new Map<string, { result: EnhancedAnswerResult; expiresAt: number }>();
const CACHE_TTL = 60 * 60 * 1000;

function getCacheKey(question: string, clarificationAnswer?: string): string {
  const normalized = question.toLowerCase().trim().replace(/\s+/g, ' ');
  return clarificationAnswer
    ? `${normalized}|${clarificationAnswer.toLowerCase().trim()}`
    : normalized;
}
import {
  answerQuestionEnhanced,
  answerWithContext,
} from '@/lib/ai/enhanced-answering-engine';
import {
  saveChatMessage,
  getOrCreateSession,
} from '@/lib/ai/answering-engine';
import {
  checkRateLimit,
  getClientKey,
  RATE_LIMITS,
} from '@/lib/rate-limiter';

export async function POST(request: NextRequest) {
  // Rate limiting
  const clientKey = getClientKey(request);
  const rateLimitResult = checkRateLimit(clientKey, RATE_LIMITS.askQuestion);

  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      {
        error: 'Превышен лимит запросов. Пожалуйста, подождите.',
        retryAfterMs: rateLimitResult.retryAfterMs,
        resetAt: rateLimitResult.resetAt.toISOString(),
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((rateLimitResult.retryAfterMs || 0) / 1000)),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': rateLimitResult.resetAt.toISOString(),
        },
      }
    );
  }

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch (error) {
      console.error('Invalid JSON body:', error);
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { question, sessionId, includeDebug, useConversationContext, clarificationAnswer } =
      body as {
        question?: unknown;
        sessionId?: string;
        includeDebug?: boolean;
        useConversationContext?: boolean;
        clarificationAnswer?: string;
      };

    if (!question || typeof question !== 'string') {
      return NextResponse.json({ error: 'Question is required' }, { status: 400 });
    }

    // Validate question length
    if (question.length > 2000) {
      return NextResponse.json(
        { error: 'Вопрос слишком длинный. Максимум 2000 символов.' },
        { status: 400 }
      );
    }

    console.log('[ASK] Received question:', question);

    // Get or create session
    let currentSessionId = sessionId;
    if (!currentSessionId) {
      console.log('[ASK] Creating new session...');
      const session = await getOrCreateSession('API');
      currentSessionId = session.id;
      console.log('[ASK] Created session:', currentSessionId);
    }

    // Save user message
    console.log('[ASK] Saving user message...');
    await saveChatMessage(currentSessionId, 'USER', question);

    // Check cache first (skip for debug requests)
    const cacheKey = getCacheKey(question, clarificationAnswer);
    if (!includeDebug) {
      const cached = answerCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        console.log('[ASK] Returning cached answer for:', question.substring(0, 60));
        return NextResponse.json({ sessionId: currentSessionId, ...cached.result });
      }
    }

    // Build effective question (append clarification context if provided)
    const effectiveQuestion = clarificationAnswer
      ? `${question}\n\nУточнение пользователя: ${clarificationAnswer}`
      : question;

    // Generate answer using enhanced engine
    // Use conversation context if session exists and flag is set
    console.log('[ASK] Generating answer...');
    const result = useConversationContext && sessionId
      ? await answerWithContext(effectiveQuestion, currentSessionId, includeDebug === true)
      : await answerQuestionEnhanced(effectiveQuestion, currentSessionId, includeDebug === true);
    console.log('[ASK] Answer generated successfully');

    // Cache the result (only if no clarification question returned)
    if (!result.clarificationQuestion && !includeDebug) {
      answerCache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL });
    }

    // Save assistant message with enhanced metadata
    await saveChatMessage(currentSessionId, 'ASSISTANT', result.answer, {
      confidence: result.confidence,
      confidenceLevel: result.confidenceLevel,
      domainsUsed: result.domainsUsed,
      citationCount: result.citations.length,
      needsClarification: result.needsClarification,
      queryAnalysis: {
        isAmbiguous: result.queryAnalysis.isAmbiguous,
        expandedQueriesCount: result.queryAnalysis.expandedQueries.length,
      },
    });

    // Build response with rate limit headers
    const response = NextResponse.json({
      sessionId: currentSessionId,
      ...result,
    });

    response.headers.set('X-RateLimit-Remaining', String(rateLimitResult.remaining));
    response.headers.set('X-RateLimit-Reset', rateLimitResult.resetAt.toISOString());

    return response;
  } catch (error) {
    console.error('Error answering question:', error);
    return NextResponse.json(
      { error: 'Не удалось сформировать ответ. Попробуйте позже.' },
      { status: 500 }
    );
  }
}
