import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { createAuthResponse, getAuthenticatedUser } from '@/lib/auth';
import { polishVoiceAnswer } from '@/lib/ai/voice-answer-polisher';
import { getBotLabCase } from '@/lib/bot-lab/cases';

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

export async function POST(request: NextRequest): Promise<Response> {
  const actor = await getAuthenticatedUser(request);
  if (!actor) return createAuthResponse();
  if (actor.role !== 'ADMIN') {
    return NextResponse.json(
      { error: 'Только администратор может сохранять эталонные ответы' },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => null) as {
    caseId?: unknown;
    question?: unknown;
    rawTranscript?: unknown;
    polishedAnswer?: unknown;
  } | null;

  const caseId = clean(body?.caseId, 180);
  const question = clean(body?.question, 2000);
  const rawTranscript = clean(body?.rawTranscript, 8000);
  let polishedAnswer = clean(body?.polishedAnswer, 8000);

  if (!question || !rawTranscript) {
    return NextResponse.json(
      { error: 'Вопрос и расшифровка обязательны' },
      { status: 400 }
    );
  }

  // If the operator did not pre-polish the answer, do it now.
  if (!polishedAnswer) {
    try {
      const polished = await polishVoiceAnswer(question, rawTranscript);
      polishedAnswer = polished.polishedAnswer;
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Не удалось отполировать ответ' },
        { status: 400 }
      );
    }
  }

  if (polishedAnswer.length < 10 || polishedAnswer.length > 8000) {
    return NextResponse.json(
      { error: 'Ответ должен содержать от 10 до 8000 символов' },
      { status: 400 }
    );
  }

  const sourceCase = caseId ? getBotLabCase(caseId) : null;
  const approvedAt = new Date();

  const result = await prisma.$transaction(async (tx) => {
    // Supersede any existing active pair for the same canonical question.
    const existingQa = await tx.qAPair.findFirst({
      where: { status: 'ACTIVE', question },
      orderBy: { updatedAt: 'desc' },
    });

    if (existingQa && existingQa.answer.trim() === polishedAnswer) {
      return { qaPairId: existingQa.id, reused: true, version: existingQa.version };
    }

    if (existingQa) {
      await tx.qAPair.update({
        where: { id: existingQa.id },
        data: { status: 'SUPERSEDED' },
      });
    }

    const qa = await tx.qAPair.create({
      data: {
        question,
        answer: polishedAnswer,
        status: 'ACTIVE',
        version: existingQa ? existingQa.version + 1 : 1,
        supersedesQaId: existingQa?.id,
        scenarioKey: sourceCase?.category ?? null,
        metadata: {
          origin: 'voice-operator',
          authorityTag: 'VOICE_ANSWER_AUTHORITY',
          confidence: 1.0,
          approvedBy: `web:${actor.username}`,
          approvedAt: approvedAt.toISOString(),
          rawTranscript,
          evalCaseId: caseId || null,
          note: null,
        },
      },
    });

    await tx.knowledgeChange.create({
      data: {
        targetType: 'QA_PAIR',
        targetId: qa.id,
        changeType: existingQa ? 'SUPERSEDE' : 'CREATE',
        oldValue: existingQa
          ? { question: existingQa.question, answer: existingQa.answer, version: existingQa.version }
          : undefined,
        newValue: {
          question: qa.question,
          answer: qa.answer,
          version: qa.version,
          scenarioKey: qa.scenarioKey,
          authorityTag: 'VOICE_ANSWER_AUTHORITY',
        },
        reason: existingQa
          ? 'Оператор записал новую версию эталонного ответа в Bot Decision Lab'
          : 'Оператор записал эталонный ответ в Bot Decision Lab',
        initiatedBy: 'ADMIN',
        approvedBy: `web:${actor.username}`,
        status: 'APPROVED',
        reviewedAt: approvedAt,
      },
    });

    return { qaPairId: qa.id, reused: false, version: qa.version };
  });

  return NextResponse.json(
    {
      qaPairId: result.qaPairId,
      reused: result.reused,
      version: result.version,
      authorityTag: 'VOICE_ANSWER_AUTHORITY',
    },
    { status: 201 }
  );
}

/**
 * Optional: pre-polish a raw transcript without saving.
 * Lets the UI show a preview before the operator approves it.
 */
export async function PUT(request: NextRequest): Promise<Response> {
  const actor = await getAuthenticatedUser(request);
  if (!actor) return createAuthResponse();
  if (actor.role === 'VIEWER') {
    return NextResponse.json(
      { error: 'Недостаточно прав для полировки ответа' },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => null) as {
    question?: unknown;
    rawTranscript?: unknown;
  } | null;

  const question = clean(body?.question, 2000);
  const rawTranscript = clean(body?.rawTranscript, 8000);

  if (!question || !rawTranscript) {
    return NextResponse.json(
      { error: 'Вопрос и расшифровка обязательны' },
      { status: 400 }
    );
  }

  try {
    const result = await polishVoiceAnswer(question, rawTranscript);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Не удалось отполировать ответ' },
      { status: 400 }
    );
  }
}
