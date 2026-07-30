import { NextRequest, NextResponse } from 'next/server';
import { KnowledgeAudience } from '@prisma/client';
import prisma from '@/lib/db';
import { createAuthResponse, getAuthenticatedUser } from '@/lib/auth';
import { getBotLabCase } from '@/lib/bot-lab/cases';
import { upsertLearnedQaPair } from '@/lib/knowledge/qa-upsert';

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
    // Бот-лаб — внутренний инструмент, и оператор здесь утверждает ТЕКСТ ответа,
    // а не условие, при котором он верен. Поэтому пара пишется как внутренняя:
    // выпускать её клиенту без условия применимости нельзя. Явная метка нужна
    // ещё и затем, чтобы подмена версии не задела одноимённую клиентскую пару —
    // раньше поиск шёл только по тексту вопроса и гасил её молча.
    const upsert = await upsertLearnedQaPair(tx, {
      question,
      answer,
      audience: KnowledgeAudience.INTERNAL_ONLY,
      scenarioKey: sourceCase.category ?? null,
      metadata: {
        origin: 'historical-operator',
        // Тег сохраняет происхождение, но авторитета не даёт: см.
        // HISTORICAL_IMPORT_HAS_AUTHORITY в enhanced-answering-engine.ts.
        authorityTag: 'HISTORICAL_ANSWER_AUTHORITY',
        approvedBy: `web:${actor.username}`,
        approvedAt: approvedAt.toISOString(),
        evalCaseId: sourceCase.id,
        source: 'bot-lab-historical-card',
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
          answer,
          version: upsert.version,
          scenarioKey: sourceCase.category ?? null,
          audience: KnowledgeAudience.INTERNAL_ONLY,
          authorityTag: 'HISTORICAL_ANSWER_AUTHORITY',
        },
        reason: upsert.supersededId
          ? 'Оператор утвердил исторический ответ как эталонный в Bot Decision Lab'
          : 'Оператор сохранил исторический ответ как эталонный в Bot Decision Lab',
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
      authorityTag: 'HISTORICAL_ANSWER_AUTHORITY',
    },
    { status: 201 }
  );
}
