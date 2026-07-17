import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const session = await getSession(request);

  if (!session) {
    return NextResponse.json({ user: null }, { status: 401 });
  }

  return NextResponse.json({
    user: {
      id: session.userId,
      username: session.username,
      role: session.role,
    },
  });
}
