import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/auth';
import { verifyEntry } from '@/lib/librarian-service';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const body = await request.json();

    const result = await verifyEntry(
      id,
      body.verifiedBy || 'admin',
      body.asCanonical === true
    );

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      message: body.asCanonical ? 'Entry marked as canonical' : 'Entry verified',
    });
  } catch (error) {
    console.error('Error verifying entry:', error);
    return NextResponse.json({ error: 'Verification failed' }, { status: 500 });
  }
}
