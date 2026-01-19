import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  const searchParams = request.nextUrl.searchParams;
  const status = searchParams.get('status') || 'ACTIVE';
  const domainSlug = searchParams.get('domain');

  try {
    const qaPairs = await prisma.qAPair.findMany({
      where: {
        status: status as 'ACTIVE' | 'SUPERSEDED' | 'DEPRECATED',
        ...(domainSlug && {
          domains: { some: { domain: { slug: domainSlug } } },
        }),
      },
      include: {
        document: { select: { title: true } },
        rule: { select: { ruleCode: true, title: true } },
        domains: { include: { domain: { select: { slug: true, title: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json(qaPairs);
  } catch (error) {
    console.error('Error fetching Q&A pairs:', error);
    return NextResponse.json({ error: 'Failed to fetch Q&A pairs' }, { status: 500 });
  }
}
