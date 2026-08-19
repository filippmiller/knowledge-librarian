import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import {
  bootstrapKnowledgeSchemaAtStartup,
  getLastBootstrapStatus,
} from '@/lib/knowledge/schema-bootstrap';

export const dynamic = 'force-dynamic';

const AURORA_V2_TABLES = [
  'KnowledgeExtractionRun',
  'KnowledgeUnitRecord',
  'KnowledgeUnitReviewDecision',
] as const;

const CORPUS_TABLES = ['Document', 'Rule', 'QAPair', 'DocChunk', 'Tariff'] as const;

async function listPresentTables(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('KnowledgeExtractionRun', 'KnowledgeUnitRecord', 'KnowledgeUnitReviewDecision')
  `;
  return rows.map((row) => row.table_name).sort();
}

async function listPresentCorpusTables(): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'corpusId'
      AND table_name IN ('Document', 'Rule', 'QAPair', 'DocChunk', 'Tariff')
  `;
  return rows.map((row) => row.table_name).sort();
}

/**
 * Проверка, что схема Aurora v2 применена к живой БД (создаётся стартовым
 * bootstrap'ом — см. src/instrumentation.ts). Позволяет убедиться в успехе
 * выкладки снаружи, без доступа к БД и к контейнеру.
 *
 * Если таблиц нет — пробует применить схему прямо сейчас (self-heal): DDL
 * идемпотентен, строго аддитивен и сериализован advisory-локом, поэтому
 * повторный вызов безопасен. lastBootstrap в ответе — статус последней
 * попытки, чтобы сбой был диагностируем по HTTPS, а не только из логов.
 */
export async function GET() {
  try {
    let present = await listPresentTables();
    let missing = AURORA_V2_TABLES.filter((table) => !present.includes(table));
    let corpusPresent = await listPresentCorpusTables();
    let corpusMissing = CORPUS_TABLES.filter((table) => !corpusPresent.includes(table));

    if (missing.length > 0 || corpusMissing.length > 0) {
      await bootstrapKnowledgeSchemaAtStartup();
      present = await listPresentTables();
      missing = AURORA_V2_TABLES.filter((table) => !present.includes(table));
      corpusPresent = await listPresentCorpusTables();
      corpusMissing = CORPUS_TABLES.filter((table) => !corpusPresent.includes(table));
    }

    return NextResponse.json({
      auroraV2Ready: missing.length === 0,
      corpusIsolationReady: corpusMissing.length === 0,
      present,
      missing,
      corpusColumns: { present: corpusPresent, missing: corpusMissing },
      lastBootstrap: getLastBootstrapStatus(),
    });
  } catch (error) {
    return NextResponse.json(
      {
        auroraV2Ready: false,
        corpusIsolationReady: false,
        error: error instanceof Error ? error.message : 'unknown',
        lastBootstrap: getLastBootstrapStatus(),
      },
      { status: 500 }
    );
  }
}
