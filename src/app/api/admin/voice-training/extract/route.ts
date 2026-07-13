import { NextRequest, NextResponse } from 'next/server';
import { createAuthResponse, getAuthenticatedUser } from '@/lib/auth';
import { extractVoiceRules } from '@/lib/ai/voice-rule-extractor';

export async function POST(request: NextRequest): Promise<Response> {
  const actor = await getAuthenticatedUser(request);
  if (!actor) return createAuthResponse();
  if (actor.role === 'VIEWER') {
    return NextResponse.json({ error: 'Недостаточно прав для извлечения правил' }, { status: 403 });
  }

  const body = await request.json().catch(() => null) as { transcript?: unknown } | null;
  const transcript = typeof body?.transcript === 'string' ? body.transcript.trim() : '';
  try {
    return NextResponse.json(await extractVoiceRules(transcript));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Не удалось извлечь правила' },
      { status: 400 }
    );
  }
}
