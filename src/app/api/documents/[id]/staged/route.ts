import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';

// GET - получить все staged элементы документа с пагинацией
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const { id: documentId } = await params;
  const searchParams = request.nextUrl.searchParams;

  // Pagination params
  const page = Math.max(1, parseInt(searchParams.get('page') || '1'));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50')));
  const itemType = searchParams.get('itemType'); // Optional filter by type

  try {
    // Get total count
    const totalCount = await prisma.stagedExtraction.count({
      where: {
        documentId,
        ...(itemType && { itemType: itemType as never }),
      },
    });

    // Get paginated items
    const stagedItems = await prisma.stagedExtraction.findMany({
      where: {
        documentId,
        ...(itemType && { itemType: itemType as never }),
      },
      orderBy: [{ phase: 'asc' }, { createdAt: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    });

    // Group by phase and itemType
    const grouped = {
      DOMAIN_CLASSIFICATION: {
        DOMAIN_ASSIGNMENT: [] as typeof stagedItems,
        DOMAIN_SUGGESTION: [] as typeof stagedItems,
      },
      KNOWLEDGE_EXTRACTION: {
        RULE: [] as typeof stagedItems,
        QA_PAIR: [] as typeof stagedItems,
        UNCERTAINTY: [] as typeof stagedItems,
      },
      CHUNKING: {
        CHUNK: [] as typeof stagedItems,
      },
    };

    for (const item of stagedItems) {
      const phase = item.phase as keyof typeof grouped;
      const itemType = item.itemType as string;
      if (grouped[phase] && itemType in grouped[phase]) {
        (grouped[phase] as Record<string, typeof stagedItems>)[itemType].push(item);
      }
    }

    const stats = {
      total: totalCount,
      verified: stagedItems.filter((i) => i.isVerified).length,
      rejected: stagedItems.filter((i) => i.isRejected).length,
      pending: stagedItems.filter((i) => !i.isVerified && !i.isRejected).length,
    };

    const pagination = {
      page,
      limit,
      totalCount,
      totalPages: Math.ceil(totalCount / limit),
      hasMore: page * limit < totalCount,
    };

    return NextResponse.json({
      items: stagedItems,
      grouped,
      stats,
      pagination,
    });
  } catch (error) {
    console.error('Error fetching staged items:', error);
    return NextResponse.json(
      { error: 'Не удалось получить промежуточные данные' },
      { status: 500 }
    );
  }
}

// PATCH - обновить статус верификации
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const { id: documentId } = await params;

  try {
    const body = await request.json();
    const { itemIds, action } = body as {
      itemIds: string[];
      action: 'verify' | 'reject' | 'reset';
    };

    if (!itemIds || !Array.isArray(itemIds) || itemIds.length === 0) {
      return NextResponse.json(
        { error: 'Требуется указать идентификаторы элементов' },
        { status: 400 }
      );
    }

    if (!['verify', 'reject', 'reset'].includes(action)) {
      return NextResponse.json(
        { error: 'Неверное действие. Допустимые: verify, reject, reset' },
        { status: 400 }
      );
    }

    const updateData =
      action === 'verify'
        ? { isVerified: true, isRejected: false, verifiedAt: new Date() }
        : action === 'reject'
        ? { isVerified: false, isRejected: true, verifiedAt: null }
        : { isVerified: false, isRejected: false, verifiedAt: null };

    const result = await prisma.stagedExtraction.updateMany({
      where: {
        id: { in: itemIds },
        documentId,
      },
      data: updateData,
    });

    return NextResponse.json({
      success: true,
      updated: result.count,
      message:
        action === 'verify'
          ? `Подтверждено элементов: ${result.count}`
          : action === 'reject'
          ? `Отклонено элементов: ${result.count}`
          : `Сброшен статус элементов: ${result.count}`,
    });
  } catch (error) {
    console.error('Error updating staged items:', error);
    return NextResponse.json(
      { error: 'Не удалось обновить статус элементов' },
      { status: 500 }
    );
  }
}
