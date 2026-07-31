import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, requireAdminAuth } from '@/lib/auth';
import { serializeTariff, toConflictDTO, toPrismaData } from '@/lib/tariffs/serialize';
import { findOverlapCandidates } from '@/lib/tariffs/repository';
import { findOverlappingTariffs, validateTariffInput } from '@/lib/tariffs/validation';
import type { Tariff } from '@prisma/client';

/** Существующая строка в том же виде, в каком приходит правка из формы: правка
 *  проверяется целиком, а не по одному полю, иначе смена вида цены оставляет
 *  строку с суммой и процентом одновременно. */
function toRawInput(row: Tariff): Record<string, unknown> {
  return {
    section: row.section,
    sectionTitle: row.sectionTitle,
    serviceName: row.serviceName,
    authority: row.authority,
    termText: row.termText,
    conditions: row.conditions,
    amount: row.amount === null ? null : row.amount.toNumber(),
    amountKind: row.amountKind,
    percent: row.percent === null ? null : row.percent.toNumber(),
    percentBase: row.percentBase,
    baseFeeAmount: row.baseFeeAmount === null ? null : row.baseFeeAmount.toNumber(),
    unit: row.unit,
    currency: row.currency,
    priceText: row.priceText,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    audience: row.audience,
    footnote: row.footnote,
    language: row.language,
    complexityCategory: row.complexityCategory,
    direction: row.direction,
    turnaround: row.turnaround,
    includesNotary: row.includesNotary,
    sourceFile: row.sourceFile,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const { id } = await params;

  try {
    const tariff = await prisma.tariff.findUnique({
      where: { id },
      include: { document: { select: { title: true } } },
    });
    if (!tariff) {
      return NextResponse.json({ error: 'Тариф не найден' }, { status: 404 });
    }
    return NextResponse.json(serializeTariff(tariff));
  } catch (error) {
    console.error('Error fetching tariff:', error);
    return NextResponse.json({ error: 'Не удалось загрузить тариф' }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;
  const user = await getAuthenticatedUser(request);

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Ожидался объект с полями тарифа' }, { status: 400 });
  }

  try {
    const existing = await prisma.tariff.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: 'Тариф не найден' }, { status: 404 });
    }

    const merged = { ...toRawInput(existing), ...(body as Record<string, unknown>) };
    const result = validateTariffInput(merged);
    if (!result.ok) {
      return NextResponse.json(
        { error: 'Тариф не прошёл проверку', issues: result.issues },
        { status: 400 }
      );
    }
    const value = result.value;

    const force = request.nextUrl.searchParams.get('force') === '1';
    if (!force) {
      const conflicts = findOverlappingTariffs(value, await findOverlapCandidates(value), {
        excludeId: id,
      });
      if (conflicts.length > 0) {
        return NextResponse.json(
          {
            error:
              'На эту услугу уже есть действующий тариф с пересекающимся периодом. Два активных тарифа на одну услугу дают клиенту две разные цены.',
            code: 'OVERLAP',
            conflicts: conflicts.map(toConflictDTO),
          },
          { status: 409 }
        );
      }
    }

    const updated = await prisma.tariff.update({
      where: { id },
      data: { ...toPrismaData(value), updatedBy: user?.username ?? null },
      include: { document: { select: { title: true } } },
    });

    return NextResponse.json(serializeTariff(updated));
  } catch (error) {
    console.error('Error updating tariff:', error);
    return NextResponse.json({ error: 'Не удалось изменить тариф' }, { status: 500 });
  }
}

/**
 * Архивирование. Физического удаления нет.
 *
 * Цена — это история: по ней разбирают, что бюро обещало клиенту в марте, и
 * сверяют старые ответы бота. Строка снимается с публикации (`isActive = false`)
 * и получает дату окончания действия.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;
  const user = await getAuthenticatedUser(request);

  const { id } = await params;

  try {
    const existing = await prisma.tariff.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: 'Тариф не найден' }, { status: 404 });
    }

    const raw = request.nextUrl.searchParams.get('effectiveTo');
    const requested = raw ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw) : new Date();
    if (Number.isNaN(requested.getTime())) {
      return NextResponse.json({ error: 'Некорректная дата окончания' }, { status: 400 });
    }

    // Тариф, ещё не вступивший в силу, закрыть задним числом нельзя: конец
    // действия обязан быть позже начала. Он просто снимается с публикации.
    const effectiveTo =
      requested.getTime() > existing.effectiveFrom.getTime() ? requested : existing.effectiveTo;

    const archived = await prisma.tariff.update({
      where: { id },
      data: { isActive: false, effectiveTo, updatedBy: user?.username ?? null },
      include: { document: { select: { title: true } } },
    });

    return NextResponse.json(serializeTariff(archived));
  } catch (error) {
    console.error('Error archiving tariff:', error);
    return NextResponse.json({ error: 'Не удалось архивировать тариф' }, { status: 500 });
  }
}
