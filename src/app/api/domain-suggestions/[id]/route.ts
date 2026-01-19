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
    const { action } = body; // 'approve' or 'reject'

    const suggestion = await prisma.domainSuggestion.findUnique({
      where: { id },
    });

    if (!suggestion) {
      return NextResponse.json({ error: 'Suggestion not found' }, { status: 404 });
    }

    if (action === 'approve') {
      // Create the domain
      let parentDomainId: string | null = null;

      if (suggestion.parentSlug) {
        const parent = await prisma.domain.findUnique({
          where: { slug: suggestion.parentSlug },
        });
        if (parent) {
          parentDomainId = parent.id;
        }
      }

      await prisma.domain.create({
        data: {
          slug: suggestion.suggestedSlug,
          title: suggestion.title,
          description: suggestion.description,
          parentDomainId,
        },
      });

      await prisma.domainSuggestion.update({
        where: { id },
        data: {
          status: 'APPROVED',
          reviewedAt: new Date(),
          reviewedBy: 'admin',
        },
      });

      return NextResponse.json({ message: 'Domain created' });
    } else if (action === 'reject') {
      await prisma.domainSuggestion.update({
        where: { id },
        data: {
          status: 'REJECTED',
          reviewedAt: new Date(),
          reviewedBy: 'admin',
        },
      });

      return NextResponse.json({ message: 'Suggestion rejected' });
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('Error processing domain suggestion:', error);
    return NextResponse.json({ error: 'Failed to process suggestion' }, { status: 500 });
  }
}
