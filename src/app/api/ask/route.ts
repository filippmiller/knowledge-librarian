import { NextRequest, NextResponse } from 'next/server';
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

    const { question, sessionId, includeDebug, useConversationContext } =
      body as {
        question?: unknown;
        sessionId?: string;
        includeDebug?: boolean;
        useConversationContext?: boolean;
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

    // Generate answer using enhanced engine
    // Use conversation context if session exists and flag is set
    console.log('[ASK] Generating answer...');
    const result = useConversationContext && sessionId
      ? await answerWithContext(question, currentSessionId, includeDebug === true)
      : await answerQuestionEnhanced(question, currentSessionId, includeDebug === true);
    console.log('[ASK] Answer generated successfully');

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
