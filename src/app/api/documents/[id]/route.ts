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
    const processingTimeoutMs = 6 * 60 * 60 * 1000;
    const timeoutCutoff = new Date(Date.now() - processingTimeoutMs);

    await prisma.document.updateMany({
      where: {
        id,
        parseStatus: 'PROCESSING',
        uploadedAt: { lt: timeoutCutoff },
      },
      data: {
        parseStatus: 'FAILED',
        parseError: 'Processing timed out. Please retry.',
      },
    });

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
    // Delete related data first
    await prisma.stagedExtraction.deleteMany({ where: { documentId: id } });
    await prisma.docChunk.deleteMany({ where: { documentId: id } });
    await prisma.documentDomain.deleteMany({ where: { documentId: id } });

    await prisma.document.delete({
      where: { id },
    });

    return NextResponse.json({ message: 'Document deleted' });
  } catch (error) {
    console.error('Error deleting document:', error);
    return NextResponse.json({ error: 'Failed to delete document' }, { status: 500 });
  }
}

/**
 * PATCH /api/documents/[id]
 * Update document status (reset, cancel processing)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const body = await request.json();
    const { action } = body;

    switch (action) {
      case 'reset': {
        // Reset to PENDING, clear staged data
        await prisma.stagedExtraction.deleteMany({ where: { documentId: id } });
        await prisma.document.update({
          where: { id },
          data: {
            parseStatus: 'PENDING',
            parseError: null,
          },
        });
        return NextResponse.json({ message: 'Document reset to pending' });
      }

      case 'cancel': {
        // Cancel processing, mark as FAILED
        await prisma.stagedExtraction.deleteMany({ where: { documentId: id } });
        await prisma.document.update({
          where: { id },
          data: {
            parseStatus: 'FAILED',
            parseError: 'Processing cancelled by user',
          },
        });
        return NextResponse.json({ message: 'Processing cancelled' });
      }

      case 'retry': {
        // Reset for retry - same as reset but mark for reprocessing
        await prisma.stagedExtraction.deleteMany({ where: { documentId: id } });
        await prisma.document.update({
          where: { id },
          data: {
            parseStatus: 'PENDING',
            parseError: null,
          },
        });
        return NextResponse.json({ message: 'Document ready for retry' });
      }

      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('Error updating document:', error);
    return NextResponse.json({ error: 'Failed to update document' }, { status: 500 });
  }
}
