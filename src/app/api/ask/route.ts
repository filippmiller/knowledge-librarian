import { NextRequest, NextResponse } from 'next/server';
import {
  answerQuestion,
  saveChatMessage,
  getOrCreateSession,
} from '@/lib/ai/answering-engine';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { question, sessionId, includeDebug } = body;

    if (!question || typeof question !== 'string') {
      return NextResponse.json({ error: 'Question is required' }, { status: 400 });
    }

    // Get or create session
    let currentSessionId = sessionId;
    if (!currentSessionId) {
      const session = await getOrCreateSession('API');
      currentSessionId = session.id;
    }

    // Save user message
    await saveChatMessage(currentSessionId, 'USER', question);

    // Generate answer
    const result = await answerQuestion(question, includeDebug === true);

    // Save assistant message
    await saveChatMessage(currentSessionId, 'ASSISTANT', result.answer, {
      confidence: result.confidence,
      domainsUsed: result.domainsUsed,
      citationCount: result.citations.length,
    });

    return NextResponse.json({
      sessionId: currentSessionId,
      ...result,
    });
  } catch (error) {
    console.error('Error answering question:', error);
    return NextResponse.json(
      { error: 'Failed to generate answer' },
      { status: 500 }
    );
  }
}
