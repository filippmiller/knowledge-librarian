import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';

export async function GET(request: NextRequest): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const searchParams = request.nextUrl.searchParams;
  const status = searchParams.get('status') || 'ACTIVE';
  const domainSlug = searchParams.get('domain');

  try {
    const rules = await prisma.rule.findMany({
      where: {
        status: status as 'ACTIVE' | 'SUPERSEDED' | 'DEPRECATED',
        ...(domainSlug && {
          domains: { some: { domain: { slug: domainSlug } } },
        }),
      },
      include: {
        document: { select: { title: true } },
        domains: { include: { domain: { select: { slug: true, title: true } } } },
        supersedesRule: { select: { ruleCode: true, title: true } },
        supersededBy: { select: { ruleCode: true, title: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return NextResponse.json(rules);
  } catch (error) {
    console.error('Error fetching rules:', error);
    return NextResponse.json({ error: 'Failed to fetch rules' }, { status: 500 });
  }
}
