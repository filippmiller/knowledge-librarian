import { NextRequest, NextResponse } from 'next/server';
import { KnowledgeAudience } from '@prisma/client';
import prisma from '@/lib/db';
import { createAuthResponse, getAuthenticatedUser } from '@/lib/auth';
import { polishVoiceAnswer } from '@/lib/ai/voice-answer-polisher';
import { getBotLabCase } from '@/lib/bot-lab/cases';
import { upsertLearnedQaPair } from '@/lib/knowledge/qa-upsert';

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
    // Пара пишется как внутренняя и опознаётся по тройке (вопрос, аудитория,
    // сценарий). Раньше поиск шёл только по тексту вопроса, и запись голосового
    // эталона гасила одноимённую КЛИЕНТСКУЮ пару, подставляя вместо неё
    // внутреннюю. Выпускать голосовой эталон клиенту без разметки нельзя:
    // оператор наговорил его сотруднику, а не заказчику.
    const upsert = await upsertLearnedQaPair(tx, {
      question,
      answer: polishedAnswer,
      audience: KnowledgeAudience.INTERNAL_ONLY,
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
    });

    if (upsert.reused) {
      return { qaPairId: upsert.qaPairId, reused: true, version: upsert.version };
    }

    await tx.knowledgeChange.create({
      data: {
        targetType: 'QA_PAIR',
        targetId: upsert.qaPairId,
        changeType: upsert.supersededId ? 'SUPERSEDE' : 'CREATE',
        oldValue: upsert.previous,
        newValue: {
          question,
          answer: polishedAnswer,
          version: upsert.version,
          scenarioKey: sourceCase?.category ?? null,
          audience: KnowledgeAudience.INTERNAL_ONLY,
          authorityTag: 'VOICE_ANSWER_AUTHORITY',
        },
        reason: upsert.supersededId
          ? 'Оператор записал новую версию эталонного ответа в Bot Decision Lab'
          : 'Оператор записал эталонный ответ в Bot Decision Lab',
        initiatedBy: 'ADMIN',
        approvedBy: `web:${actor.username}`,
        status: 'APPROVED',
        reviewedAt: approvedAt,
      },
    });

    return { qaPairId: upsert.qaPairId, reused: false, version: upsert.version };
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
