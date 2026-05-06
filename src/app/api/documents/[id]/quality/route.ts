import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/auth';
import {
  buildDocumentQualityReport,
  runDocumentRetrievalEval,
  type RetrievalEvalCase,
} from '@/lib/document-quality';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const report = await buildDocumentQualityReport(id);
    return NextResponse.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to build quality report';
    const status = message === 'Document not found' ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const body = await request.json();
    const cases = parseEvalCases(body);
    if (cases.length === 0) {
      return NextResponse.json({ error: 'cases must contain at least one question' }, { status: 400 });
    }

    const [report, retrieval] = await Promise.all([
      buildDocumentQualityReport(id),
      runDocumentRetrievalEval(id, cases),
    ]);

    return NextResponse.json({
      report,
      retrieval,
      summary: {
        total: retrieval.length,
        passedKeywords: retrieval.filter((item) => item.passedKeywords).length,
        sourceMarkerHits: retrieval.filter((item) => item.sourceMarkerHit).length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to run quality eval';
    const status = message === 'Document not found' ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

function parseEvalCases(body: unknown): RetrievalEvalCase[] {
  if (!body || typeof body !== 'object') return [];
  const rawCases = (body as { cases?: unknown }).cases;
  if (!Array.isArray(rawCases)) return [];

  const parsed: RetrievalEvalCase[] = [];

  for (const item of rawCases) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (typeof record.question !== 'string' || record.question.trim().length === 0) continue;

      parsed.push({
        question: record.question.trim(),
        expectedKeywords: Array.isArray(record.expectedKeywords)
          ? record.expectedKeywords.filter((keyword): keyword is string => typeof keyword === 'string')
          : [],
        expectedDocumentId: typeof record.expectedDocumentId === 'string' ? record.expectedDocumentId : undefined,
      });
  }

  return parsed;
}
