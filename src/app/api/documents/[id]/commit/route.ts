import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/auth';
import { commitDocumentKnowledge } from '@/lib/document-processing/commit';

// POST - сохранить верифицированные элементы в финальные таблицы
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const { id: documentId } = await params;

  try {
    const body = await request.json().catch(() => ({}));
    const { autoVerifyPending = false, replaceExisting = false } = body as { autoVerifyPending?: boolean; replaceExisting?: boolean };
    const result = await commitDocumentKnowledge(documentId, { autoVerifyPending, replaceExisting });
    return NextResponse.json(result);
  } catch (error) {
    console.error('[COMMIT ERROR]', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: 'Не удалось сохранить данные', details: errorMessage },
      { status: 500 }
    );
  }
}
