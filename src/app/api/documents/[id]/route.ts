import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const document = await prisma.document.findUnique({
      where: { id },
      include: {
        domains: {
          include: {
            domain: true,
          },
        },
        rules: {
          where: { status: 'ACTIVE' },
          include: {
            domains: { include: { domain: true } },
          },
        },
        qaPairs: {
          where: { status: 'ACTIVE' },
          include: {
            domains: { include: { domain: true } },
          },
        },
        domainSuggestions: {
          where: { status: 'PENDING' },
        },
      },
    });

    if (!document) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    return NextResponse.json(document);
  } catch (error) {
    console.error('Error fetching document:', error);
    return NextResponse.json({ error: 'Failed to fetch document' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    await prisma.document.delete({
      where: { id },
    });

    return NextResponse.json({ message: 'Document deleted' });
  } catch (error) {
    console.error('Error deleting document:', error);
    return NextResponse.json({ error: 'Failed to delete document' }, { status: 500 });
  }
}
