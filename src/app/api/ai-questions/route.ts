import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  const searchParams = request.nextUrl.searchParams;
  const status = searchParams.get('status') || 'OPEN';

  try {
    const questions = await prisma.aIQuestion.findMany({
      where: {
        status: status as 'OPEN' | 'ANSWERED' | 'DISMISSED',
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json(questions);
  } catch (error) {
    console.error('Error fetching AI questions:', error);
    return NextResponse.json({ error: 'Failed to fetch questions' }, { status: 500 });
  }
}
