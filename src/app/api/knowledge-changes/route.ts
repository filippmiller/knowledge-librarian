import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const searchParams = request.nextUrl.searchParams;
  const limit = parseInt(searchParams.get('limit') || '50');

  try {
    const changes = await prisma.knowledgeChange.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return NextResponse.json(changes);
  } catch (error) {
    console.error('Error fetching knowledge changes:', error);
    return NextResponse.json({ error: 'Failed to fetch changes' }, { status: 500 });
  }
}
