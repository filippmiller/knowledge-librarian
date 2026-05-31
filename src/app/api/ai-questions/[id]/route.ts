import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, createAuthResponse } from '@/lib/auth';
import { approveKnowledgeGap, rejectKnowledgeGap } from '@/lib/ai/knowledge-feedback';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  // Resolve the acting principal (not just "is the credential valid") — writing
  // to the knowledge base requires the top web role, and the approver name must
  // come from the authenticated user, never from the request body.
  const actor = await getAuthenticatedUser(request);
  if (!actor) return createAuthResponse();

  const { id } = await params;

  try {
    const body = await request.json();
    const { action, response } = body;

    const question = await prisma.aIQuestion.findUnique({
      where: { id },
    });

    if (!question) {
      return NextResponse.json({ error: 'Question not found' }, { status: 404 });
    }

    if (action === 'answer') {
      if (!response) {
        return NextResponse.json({ error: 'Response is required' }, { status: 400 });
      }

      await prisma.aIQuestion.update({
        where: { id },
        data: {
          status: 'ANSWERED',
          response,
          respondedAt: new Date(),
        },
      });

      // If there's an affected rule, we might want to trigger an update
      // This could be extended to actually apply the proposed change

      return NextResponse.json({ message: 'Question answered' });
    } else if (action === 'dismiss') {
      await prisma.aIQuestion.update({
        where: { id },
        data: {
          status: 'DISMISSED',
          respondedAt: new Date(),
        },
      });

      return NextResponse.json({ message: 'Question dismissed' });
    } else if (action === 'approve') {
      // Writing a new QAPair into the knowledge base is the most privileged web
      // action — gate it to the top web role (ADMIN). EDITOR/VIEWER may not.
      if (actor.role !== 'ADMIN') {
        return NextResponse.json(
          { error: 'Недостаточно прав: утверждать черновики может только администратор' },
          { status: 403 }
        );
      }
      // Approve a knowledge_gap draft → create an ACTIVE QAPair (answer may be
      // edited) and mark this AIQuestion ANSWERED. approvedBy is derived from the
      // authenticated principal, NOT trusted from the request body.
      try {
        const { qaPairId } = await approveKnowledgeGap(id, {
          answer: body.answer,
          scenarioKey: body.scenarioKey,
          approvedBy: `web:${actor.username}`,
        });
        return NextResponse.json({ message: 'Approved and saved to knowledge base', qaPairId });
      } catch (e) {
        return NextResponse.json({ error: (e as Error).message }, { status: 400 });
      }
    } else if (action === 'reject') {
      if (actor.role !== 'ADMIN') {
        return NextResponse.json(
          { error: 'Недостаточно прав: отклонять черновики может только администратор' },
          { status: 403 }
        );
      }
      await rejectKnowledgeGap(id);
      return NextResponse.json({ message: 'Draft rejected' });
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('Error processing AI question:', error);
    return NextResponse.json({ error: 'Failed to process question' }, { status: 500 });
  }
}
