import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/auth';
import { markDisputed } from '@/lib/librarian-service';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const body = await request.json();

    // Validate required fields
    if (!body.reason || typeof body.reason !== 'string') {
      return NextResponse.json({ error: 'reason is required' }, { status: 400 });
    }
    if (body.reason.length > 2000) {
      return NextResponse.json({ error: 'reason exceeds 2000 characters' }, { status: 400 });
    }

    const result = await markDisputed(id, body.disputedBy || 'admin', body.reason);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      message: 'Entry marked as disputed',
    });
  } catch (error) {
    console.error('Error marking entry as disputed:', error);
    return NextResponse.json({ error: 'Failed to mark as disputed' }, { status: 500 });
  }
}
