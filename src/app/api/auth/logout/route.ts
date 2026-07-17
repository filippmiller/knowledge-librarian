import { NextResponse } from 'next/server';
import { clearSessionCookie } from '@/lib/session';

export async function POST(): Promise<NextResponse> {
  const response = NextResponse.json({ success: true });
  clearSessionCookie(response);
  return response;
}
