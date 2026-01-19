import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';

export async function GET(request: NextRequest) {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  try {
    const domains = await prisma.domain.findMany({
      include: {
        parentDomain: { select: { slug: true, title: true } },
        childDomains: { select: { slug: true, title: true } },
        _count: {
          select: { documents: true, rules: true, qaPairs: true },
        },
      },
      orderBy: { slug: 'asc' },
    });

    return NextResponse.json(domains);
  } catch (error) {
    console.error('Error fetching domains:', error);
    return NextResponse.json({ error: 'Failed to fetch domains' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const authError = requireAdminAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { slug, title, description, parentSlug } = body;

    if (!slug || !title) {
      return NextResponse.json({ error: 'Slug and title are required' }, { status: 400 });
    }

    let parentDomainId: string | null = null;

    if (parentSlug) {
      const parent = await prisma.domain.findUnique({
        where: { slug: parentSlug },
      });
      if (!parent) {
        return NextResponse.json({ error: 'Parent domain not found' }, { status: 400 });
      }
      parentDomainId = parent.id;
    }

    const domain = await prisma.domain.create({
      data: {
        slug,
        title,
        description,
        parentDomainId,
      },
    });

    return NextResponse.json(domain);
  } catch (error) {
    console.error('Error creating domain:', error);
    return NextResponse.json({ error: 'Failed to create domain' }, { status: 500 });
  }
}
