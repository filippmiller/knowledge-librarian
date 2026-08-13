import { NextResponse } from 'next/server';
import prisma from '@/lib/db';

export const dynamic = 'force-dynamic';

const AURORA_V2_TABLES = [
  'KnowledgeExtractionRun',
  'KnowledgeUnitRecord',
  'KnowledgeUnitReviewDecision',
] as const;

/**
 * Проверка, что схема Aurora v2 применена к живой БД (создаётся стартовым
 * bootstrap'ом — см. src/instrumentation.ts). Позволяет убедиться в успехе
 * выкладки снаружи, без доступа к БД и к контейнеру.
 */
export async function GET() {
  try {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('KnowledgeExtractionRun', 'KnowledgeUnitRecord', 'KnowledgeUnitReviewDecision')
    `;
    const present = rows.map((row) => row.table_name).sort();
    const missing = AURORA_V2_TABLES.filter((table) => !present.includes(table));
    return NextResponse.json({
      auroraV2Ready: missing.length === 0,
      present,
      missing,
    });
  } catch (error) {
    return NextResponse.json(
      { auroraV2Ready: false, error: error instanceof Error ? error.message : 'unknown' },
      { status: 500 }
    );
  }
}
