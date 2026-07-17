import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { createAuthResponse, getAuthenticatedUser } from '@/lib/auth';
import { getBotLabCase } from '@/lib/bot-lab/cases';

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
  } | null;

  const caseId = typeof body?.caseId === 'string' ? body.caseId.trim() : '';
  const sourceCase = caseId ? getBotLabCase(caseId) : null;

  if (!sourceCase) {
    return NextResponse.json({ error: 'Кейс не найден' }, { status: 404 });
  }

  const question = sourceCase.question.trim();
  const answer = sourceCase.answer.trim();

  if (!question || answer.length < 10 || answer.length > 8000) {
    return NextResponse.json(
      { error: 'Вопрос или исторический ответ не подходят для сохранения' },
      { status: 400 }
    );
  }

  const approvedAt = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const existingQa = await tx.qAPair.findFirst({
      where: { status: 'ACTIVE', question },
      orderBy: { updatedAt: 'desc' },
    });

    if (existingQa && existingQa.answer.trim() === answer) {
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
        answer,
        status: 'ACTIVE',
        version: existingQa ? existingQa.version + 1 : 1,
        supersedesQaId: existingQa?.id,
        scenarioKey: sourceCase.category ?? null,
        metadata: {
          origin: 'historical-operator',
          authorityTag: 'HISTORICAL_ANSWER_AUTHORITY',
          confidence: 1.0,
          approvedBy: `web:${actor.username}`,
          approvedAt: approvedAt.toISOString(),
          evalCaseId: sourceCase.id,
          source: 'bot-lab-historical-card',
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
          authorityTag: 'HISTORICAL_ANSWER_AUTHORITY',
        },
        reason: existingQa
          ? 'Оператор утвердил исторический ответ как эталонный в Bot Decision Lab'
          : 'Оператор сохранил исторический ответ как эталонный в Bot Decision Lab',
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
      authorityTag: 'HISTORICAL_ANSWER_AUTHORITY',
    },
    { status: 201 }
  );
}
