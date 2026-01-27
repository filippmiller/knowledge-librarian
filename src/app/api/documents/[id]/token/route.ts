/**
 * Generate a short-lived processing token for SSE authentication
 * This token allows EventSource to authenticate without headers
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/auth';
import { createProcessingToken } from '@/lib/crypto';
import { prisma } from '@/lib/db';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  // This endpoint DOES require Basic Auth (called from browser with credentials)
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const { id: documentId } = await params;

  // Verify document exists
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { id: true },
  });

  if (!document) {
    return NextResponse.json(
      { error: 'Document not found' },
      { status: 404 }
    );
  }

  // Generate token
  const token = createProcessingToken(documentId);

  return NextResponse.json({ token });
}
