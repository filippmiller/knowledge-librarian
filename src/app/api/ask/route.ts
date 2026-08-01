import { NextRequest, NextResponse } from 'next/server';
import {
  answerQuestionEnhanced,
  answerWithContext,
} from '@/lib/ai/enhanced-answering-engine';
import { getCachedAnswer, storeCachedAnswer } from '@/lib/ai/answer-cache';
import { applyDelivery, resolveDelivery } from '@/lib/ai/delivery';
import { recordHeldAnswer } from '@/lib/ai/held-answers';
import {
  saveChatMessage,
  getOrCreateSession,
} from '@/lib/ai/answering-engine';
import {
  checkRateLimit,
  getClientKey,
  RATE_LIMITS,
} from '@/lib/rate-limiter';
import { escalateUnconvincingAIAnswer } from '@/lib/telegram/ai-escalation';
import type { Audience } from '@/lib/knowledge/audience';
import { getSession } from '@/lib/session';

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

    const {
      question,
      sessionId,
      includeDebug,
      useConversationContext,
      clarificationAnswer,
      audience: rawAudience,
      sandbox: rawSandbox,
    } = body as {
        question?: unknown;
        sessionId?: string;
        includeDebug?: boolean;
        useConversationContext?: boolean;
        clarificationAnswer?: string;
        audience?: unknown;
        sandbox?: unknown;
      };

    if (!question || typeof question !== 'string') {
      return NextResponse.json({ error: 'Question is required' }, { status: 400 });
    }

    if (rawAudience !== undefined && rawAudience !== 'internal' && rawAudience !== 'client') {
      return NextResponse.json(
        { error: "audience должен быть 'internal' или 'client'" },
        { status: 400 }
      );
    }

    // Этот роут публичный: middleware его не закрывает, и любой внешний вызов
    // сюда доходит. Поэтому внутренний контур выдаётся ТОЛЬКО по сессии
    // сотрудника. Аноним получает клиентский контур независимо от того, что
    // прислал в теле: неавторизованный вызывающий по определению не сотрудник,
    // а ошибка в эту сторону приводит к менее полному ответу, а не к утечке
    // адресов госорганов и внутренней себестоимости.
    const session = await getSession(request);
    const audience: Audience = session && rawAudience !== 'client' ? 'internal' : 'client';
    if (!session && rawAudience === 'internal') {
      console.warn('[ASK] Внутренний контур запрошен без сессии — отдаём клиентский');
    }

    // Прогон в песочнице: ответ считается как обычно, но побочные действия не
    // выполняются.
    //
    // Найдено аудитом Codex. `/admin/bot-lab` бьёт в этот же роут, и КАЖДЫЙ
    // прогон оператора создавал черновик пробела знаний и слал супер-админам
    // сообщение в Телеграм. Песочница, на которой написано «никаких отправок»,
    // на деле спамила единственному получателю уведомлений и засоряла очередь
    // `AIQuestion` вопросами, которых никто не задавал.
    //
    // Флаг признаётся ТОЛЬКО по сессии сотрудника: иначе любой анонимный
    // вызывающий глушил бы эскалацию настоящих клиентских вопросов, прислав
    // `sandbox: true`.
    const sandbox = rawSandbox === true && Boolean(session);
    if (rawSandbox === true && !session) {
      console.warn('[ASK] sandbox запрошен без сессии — игнорирую, эскалация остаётся');
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

    // Check shared answer cache first (skip for debug and conversation-context requests).
    if (!includeDebug) {
      const cached = !useConversationContext ? getCachedAnswer(audience, question, clarificationAnswer) : null;
      if (cached) {
        console.log('[ASK] Returning cached answer for:', question.substring(0, 60));
        // Политика доставки применяется и к кэшу: настройки автоответа могли
        // измениться с момента записи, а отданный без решения ответ потребитель
        // отправит клиенту как есть.
        const cachedDelivery = await resolveDelivery(cached.result, audience);
        return NextResponse.json({
          sessionId: currentSessionId,
          ...applyDelivery(cached.result, cachedDelivery, { includeDraft: Boolean(session) }),
        });
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
      ? await answerWithContext(effectiveQuestion, currentSessionId, audience, includeDebug === true)
      : await answerQuestionEnhanced({
          question: effectiveQuestion,
          audience,
          sessionId: currentSessionId,
          includeDebug: includeDebug === true,
        });
    console.log('[ASK] Answer generated successfully');

    // Cache only convincing final answers; weak answers and clarification prompts are skipped.
    if (!includeDebug && !useConversationContext) {
      storeCachedAnswer(audience, question, result, clarificationAnswer);
    }

    // Решение о доставке принимается ДО записи в историю. Иначе в историю
    // ложится сырой черновик, а клиент видит удерживающий текст — и следующий
    // запрос с useConversationContext подхватывает из истории ровно тот
    // неподтверждённый факт, который только что удержали.
    const delivery = await resolveDelivery(result, audience);
    if (delivery.withheld) {
      console.warn(
        '[ASK] Черновик удержан от клиента (decision=%s, confidence=%s, requiresHumanReview=%s):',
        delivery.decision,
        result.confidence.toFixed(2),
        result.requiresHumanReview,
        question.slice(0, 80)
      );
    }

    // Эскалация ПОСЛЕ решения о доставке и с его учётом.
    //
    // Удерживающий текст обещает клиенту ответ живого человека. Обычная
    // эскалация срабатывает только на признаках недоверия к ответу, а уверенный
    // ответ может быть забракован одними настройками — выключенным автоответом
    // или поднятым порогом. Без явной причины такой случай не создавал ни
    // задачи, ни уведомления: клиенту обещали коллегу, а вопрос не получал никто.
    if (sandbox) {
      console.log('[ASK] Песочница: эскалация и черновик пробела знаний пропущены');
    } else {
      // Удержанный ответ записывается, чтобы позже получить вердикт человека:
      // без него частота срабатывания контроля не отличает верную тревогу от
      // ложной. Наблюдение не имеет права ломать ответ — отсюда fire-and-forget.
      if (delivery.decision === 'escalate') {
        void recordHeldAnswer({
          question,
          result,
          audience,
          source: 'API',
          delivery: delivery.decision,
          blocker: delivery.blocker,
          draftAnswer: delivery.draftAnswer,
          sessionId: currentSessionId,
        });
      }
      void escalateUnconvincingAIAnswer({
        question,
        result,
        source: 'API',
        audience,
        sessionId: currentSessionId,
        extraReasons: delivery.withheld
          ? [`ответ удержан от клиента политикой доставки (${delivery.decision})`]
          : undefined,
      });
    }

    // В историю — то, что реально увидел собеседник. Черновик сохраняется
    // рядом, в метаданных: оператору он нужен, в контекст следующего ответа
    // попасть не должен.
    await saveChatMessage(currentSessionId, 'ASSISTANT', delivery.outboundAnswer, {
      confidence: result.confidence,
      confidenceLevel: result.confidenceLevel,
      domainsUsed: result.domainsUsed,
      citationCount: result.citations.length,
      needsClarification: result.needsClarification,
      delivery: delivery.decision,
      withheldDraft: delivery.withheld ? delivery.draftAnswer : undefined,
      queryAnalysis: {
        isAmbiguous: result.queryAnalysis.isAmbiguous,
        expandedQueriesCount: result.queryAnalysis.expandedQueries.length,
      },
    });

    // Build response with rate limit headers
    const response = NextResponse.json({
      sessionId: currentSessionId,
      // Черновик отдаётся только по сессии сотрудника. Аноним не должен
      // получить текст, который мы только что признали недопустимым для него:
      // иначе подмена ответа — косметика, а не защита.
      ...applyDelivery(result, delivery, { includeDraft: Boolean(session) }),
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
