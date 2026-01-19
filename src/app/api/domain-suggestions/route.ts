import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  try {
    const suggestions = await prisma.domainSuggestion.findMany({
      include: {
        document: { select: { title: true, filename: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json(suggestions);
  } catch (error) {
    console.error('Error fetching domain suggestions:', error);
    return NextResponse.json({ error: 'Failed to fetch suggestions' }, { status: 500 });
  }
}
