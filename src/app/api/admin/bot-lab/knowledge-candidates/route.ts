import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { createAuthResponse, getAuthenticatedUser } from '@/lib/auth';
import { getBotLabCase } from '@/lib/bot-lab/cases';

function normalizeQuestion(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export async function POST(request: NextRequest): Promise<Response> {
  const actor = await getAuthenticatedUser(request);
  if (!actor) return createAuthResponse();
  if (actor.role !== 'ADMIN') {
    return NextResponse.json(
      { error: 'Только администратор может создавать кандидаты знаний' },
      { status: 403 }
    );
  }

  let body: { caseId?: unknown; answer?: unknown; note?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  }

  const caseId = typeof body.caseId === 'string' ? body.caseId : '';
  const answer = typeof body.answer === 'string' ? body.answer.trim() : '';
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  const sourceCase = getBotLabCase(caseId);

  if (!sourceCase) return NextResponse.json({ error: 'Кейс не найден' }, { status: 404 });
  if (answer.length < 10 || answer.length > 8000) {
    return NextResponse.json({ error: 'Ответ должен содержать от 10 до 8000 символов' }, { status: 400 });
  }
  if (note.length > 2000) {
    return NextResponse.json({ error: 'Комментарий не должен превышать 2000 символов' }, { status: 400 });
  }

  const recentCandidates = await prisma.aIQuestion.findMany({
    where: { issueType: 'knowledge_gap', status: 'OPEN' },
    select: { id: true, question: true, context: true },
    orderBy: { createdAt: 'desc' },
    take: 300,
  });
  const existing = recentCandidates.find((candidate) => {
    const context = candidate.context as { evalCaseId?: unknown } | null;
    return context?.evalCaseId === sourceCase.id ||
      normalizeQuestion(candidate.question) === normalizeQuestion(sourceCase.question);
  });
  if (existing) {
    const previousContext = existing.context as Record<string, unknown> | null;
    await prisma.aIQuestion.update({
      where: { id: existing.id },
      data: {
        context: {
          ...previousContext,
          evalCaseId: sourceCase.id,
          operatorNote: note || null,
          submittedBy: actor.username,
          draft: {
            question: sourceCase.question,
            answer,
            scenarioKey: null,
          },
        },
      },
    });
    return NextResponse.json({ candidateId: existing.id, deduplicated: true });
  }

  const candidate = await prisma.aIQuestion.create({
    data: {
      issueType: 'knowledge_gap',
      question: sourceCase.question,
      status: 'OPEN',
      context: {
        source: 'BOT_DECISION_LAB',
        evalCaseId: sourceCase.id,
        category: sourceCase.category,
        priceDependent: sourceCase.price_dependent,
        historicalAnswer: sourceCase.answer,
        operatorNote: note || null,
        submittedBy: actor.username,
        draft: {
          question: sourceCase.question,
          answer,
          scenarioKey: null,
        },
      },
    },
    select: { id: true },
  });

  return NextResponse.json({ candidateId: candidate.id, deduplicated: false }, { status: 201 });
}
