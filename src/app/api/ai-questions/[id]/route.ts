import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

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
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('Error processing AI question:', error);
    return NextResponse.json({ error: 'Failed to process question' }, { status: 500 });
  }
}
