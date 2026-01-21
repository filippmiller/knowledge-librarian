import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/auth';
import { getHealthStats } from '@/lib/librarian-service';

export async function GET(request: NextRequest): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  try {
    const stats = await getHealthStats();

    return NextResponse.json({
      status: 'healthy',
      ...stats,
    });
  } catch (error) {
    console.error('Error getting health stats:', error);
    return NextResponse.json({ error: 'Failed to get health stats' }, { status: 500 });
  }
}
