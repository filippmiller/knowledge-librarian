import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';

/**
 * Словари для фильтров: языки матрицы, категории сложности, число строк по
 * разделам. Считаются на сервере — тянуть в браузер 1560 строк ради списка из
 * 52 языков незачем.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  try {
    const [languageRows, categoryRows, sectionRows] = await Promise.all([
      prisma.tariff.findMany({
        where: { section: 'TRANSLATION', language: { not: null } },
        distinct: ['language'],
        select: { language: true },
        orderBy: { language: 'asc' },
      }),
      prisma.tariff.findMany({
        where: { section: 'TRANSLATION', complexityCategory: { not: null } },
        distinct: ['complexityCategory'],
        select: { complexityCategory: true },
        orderBy: { complexityCategory: 'asc' },
      }),
      prisma.tariff.groupBy({
        by: ['section', 'isActive'],
        _count: { _all: true },
      }),
    ]);

    const bySection = new Map<string, { section: string; active: number; archived: number }>();
    for (const row of sectionRows) {
      const entry = bySection.get(row.section) ?? { section: row.section, active: 0, archived: 0 };
      if (row.isActive) entry.active += row._count._all;
      else entry.archived += row._count._all;
      bySection.set(row.section, entry);
    }

    return NextResponse.json({
      languages: languageRows.map((r) => r.language).filter((l): l is string => l !== null),
      categories: categoryRows
        .map((r) => r.complexityCategory)
        .filter((c): c is number => c !== null),
      sections: [...bySection.values()].sort((a, b) => a.section.localeCompare(b.section)),
    });
  } catch (error) {
    console.error('Error fetching tariff facets:', error);
    return NextResponse.json({ error: 'Не удалось загрузить словари' }, { status: 500 });
  }
}
