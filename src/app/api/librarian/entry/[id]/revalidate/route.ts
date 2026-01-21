import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/auth';
import { revalidateEntry } from '@/lib/librarian-service';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const body = await request.json();

    const result = await revalidateEntry(id, body.validatedBy || body.agentId || 'admin');

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      message: 'Entry revalidated, freshness reset to 1.0',
    });
  } catch (error) {
    console.error('Error revalidating entry:', error);
    return NextResponse.json({ error: 'Revalidation failed' }, { status: 500 });
  }
}
