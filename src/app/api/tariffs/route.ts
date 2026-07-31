import { NextRequest, NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import prisma from '@/lib/db';
import { getAuthenticatedUser, requireAdminAuth } from '@/lib/auth';
import { languageStem } from '@/lib/knowledge/tariffs';
import { serializeTariff, toConflictDTO, toPrismaData } from '@/lib/tariffs/serialize';
import { findOverlapCandidates, generateNaturalKey } from '@/lib/tariffs/repository';
import {
  findOverlappingTariffs,
  validateTariffInput,
  TARIFF_AUDIENCES,
  TARIFF_SECTIONS,
  TARIFF_TURNAROUNDS,
  TRANSLATION_DIRECTIONS,
} from '@/lib/tariffs/validation';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildWhere(params: URLSearchParams): Prisma.TariffWhereInput {
  const where: Prisma.TariffWhereInput = {};
  const and: Prisma.TariffWhereInput[] = [];

  const sections = (params.get('section') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => (TARIFF_SECTIONS as string[]).includes(s));
  if (sections.length === 1) where.section = sections[0] as Prisma.TariffWhereInput['section'];
  else if (sections.length > 1) where.section = { in: sections as never[] };

  const audience = params.get('audience');
  if (audience && (TARIFF_AUDIENCES as string[]).includes(audience)) {
    where.audience = audience as Prisma.TariffWhereInput['audience'];
  }

  const active = params.get('active') ?? 'true';
  if (active === 'true') where.isActive = true;
  else if (active === 'false') where.isActive = false;

  const category = Number(params.get('category'));
  if (Number.isInteger(category) && category > 0) where.complexityCategory = category;

  const direction = params.get('direction');
  if (direction && (TRANSLATION_DIRECTIONS as string[]).includes(direction)) {
    where.direction = direction as Prisma.TariffWhereInput['direction'];
  }

  const turnaround = params.get('turnaround');
  if (turnaround && (TARIFF_TURNAROUNDS as string[]).includes(turnaround)) {
    where.turnaround = turnaround as Prisma.TariffWhereInput['turnaround'];
  }

  const includesNotary = params.get('includesNotary');
  if (includesNotary === 'true' || includesNotary === 'false') {
    where.includesNotary = includesNotary === 'true';
  }

  // Язык сравнивается по основе слова: в прайсе «АНГЛИЙСКИЙ», спрашивают
  // «английского». Основа — префикс, поэтому поиск подстрокой её находит.
  const language = params.get('language');
  if (language && language.trim() !== '') {
    where.language = { contains: languageStem(language), mode: 'insensitive' };
  }

  const query = params.get('q');
  if (query && query.trim() !== '') {
    const needle = query.trim();
    and.push({
      OR: [
        { serviceName: { contains: needle, mode: 'insensitive' } },
        { authority: { contains: needle, mode: 'insensitive' } },
        { sectionTitle: { contains: needle, mode: 'insensitive' } },
        { language: { contains: needle, mode: 'insensitive' } },
        { termText: { contains: needle, mode: 'insensitive' } },
      ],
    });
  }

  const effectiveOn = parseDate(params.get('effectiveOn')) ?? (params.get('current') === '1' ? new Date() : null);
  if (effectiveOn) {
    and.push({ effectiveFrom: { lte: effectiveOn } });
    and.push({ OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveOn } }] });
  }

  if (and.length > 0) where.AND = and;
  return where;
}

export async function GET(request: NextRequest): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const params = request.nextUrl.searchParams;

  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const requestedSize = Number(params.get('pageSize') ?? String(DEFAULT_PAGE_SIZE));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.isFinite(requestedSize) ? requestedSize : DEFAULT_PAGE_SIZE)
  );

  try {
    const where = buildWhere(params);

    // Матрица перевода — 1560 строк, поэтому общее число берётся отдельным
    // счётчиком: без него страница не может показать, сколько строк отсеклось.
    const [total, rows] = await Promise.all([
      prisma.tariff.count({ where }),
      prisma.tariff.findMany({
        where,
        orderBy: [{ section: 'asc' }, { sortOrder: 'asc' }, { serviceName: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { document: { select: { title: true } } },
      }),
    ]);

    return NextResponse.json({
      items: rows.map(serializeTariff),
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    });
  } catch (error) {
    console.error('Error fetching tariffs:', error);
    return NextResponse.json({ error: 'Не удалось загрузить тарифы' }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;
  const user = await getAuthenticatedUser(request);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Некорректный JSON' }, { status: 400 });
  }

  const result = validateTariffInput(body);
  if (!result.ok) {
    return NextResponse.json(
      { error: 'Тариф не прошёл проверку', issues: result.issues },
      { status: 400 }
    );
  }
  const value = result.value;

  try {
    const force = request.nextUrl.searchParams.get('force') === '1';
    if (!force) {
      const conflicts = findOverlappingTariffs(value, await findOverlapCandidates(value));
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

    const created = await prisma.tariff.create({
      data: {
        ...toPrismaData(value),
        naturalKey: await generateNaturalKey(value),
        updatedBy: user?.username ?? null,
      },
      include: { document: { select: { title: true } } },
    });

    return NextResponse.json(serializeTariff(created), { status: 201 });
  } catch (error) {
    console.error('Error creating tariff:', error);
    return NextResponse.json({ error: 'Не удалось создать тариф' }, { status: 500 });
  }
}
