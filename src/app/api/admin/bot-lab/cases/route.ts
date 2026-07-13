import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/auth';
import { botLabCases, getBotLabDatasetSummary } from '@/lib/bot-lab/cases';

export async function GET(request: NextRequest) {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  return NextResponse.json(
    {
      dataset: getBotLabDatasetSummary(),
      cases: botLabCases,
    },
    {
      headers: {
        'Cache-Control': 'private, no-store',
      },
    }
  );
}
