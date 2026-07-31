import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';

/**
 * GET /api/rules/[id]/source — правило вместе с текстом документа-источника.
 *
 * Отдельная ручка от `/api/rules/[id]`, потому что `rawText` тянуть в список
 * правил нельзя: правил ~2000, документы до 16 КБ текста каждый. Здесь текст
 * грузится ровно по клику на код одного правила.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const rule = await prisma.rule.findUnique({
      where: { id },
      select: {
        id: true,
        ruleCode: true,
        title: true,
        body: true,
        confidence: true,
        status: true,
        version: true,
        createdAt: true,
        sourceSpan: true,
        document: {
          select: {
            id: true,
            title: true,
            filename: true,
            parseStatus: true,
            rawText: true,
          },
        },
      },
    });

    if (!rule) {
      return NextResponse.json({ error: 'Rule not found' }, { status: 404 });
    }

    const span = (rule.sourceSpan ?? null) as Record<string, unknown> | null;
    const quote = typeof span?.quote === 'string' ? span.quote : null;
    const locationHint = typeof span?.locationHint === 'string' ? span.locationHint : null;
    // Голосовые правила помечаются authorityTag='VOICE_AUTHORITY' — у них
    // документа-источника нет по природе, и модалка должна сказать это прямо.
    const authorityTag = typeof span?.authorityTag === 'string' ? span.authorityTag : null;

    return NextResponse.json({
      rule: {
        id: rule.id,
        ruleCode: rule.ruleCode,
        title: rule.title,
        body: rule.body,
        confidence: rule.confidence,
        status: rule.status,
        version: rule.version,
        createdAt: rule.createdAt,
      },
      span: { quote, locationHint, authorityTag },
      document: rule.document
        ? {
            id: rule.document.id,
            title: rule.document.title,
            filename: rule.document.filename,
            parseStatus: rule.document.parseStatus,
            rawText: rule.document.rawText,
          }
        : null,
    });
  } catch (error) {
    console.error('Error fetching rule source:', error);
    return NextResponse.json({ error: 'Failed to fetch rule source' }, { status: 500 });
  }
}
