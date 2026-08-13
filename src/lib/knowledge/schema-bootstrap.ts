import type { PrismaClient } from '@prisma/client';
import prisma from '@/lib/db';

/**
 * Самоприменяющаяся схема Aurora v2 — зеркало миграции
 * prisma/migrations/20260813120000_aurora_v2_knowledge_units, переписанное
 * идемпотентно (IF NOT EXISTS / guarded ALTER). Запускается при старте
 * сервера (src/instrumentation.ts): выкладка кода сама приводит БД к нужной
 * схеме, без ручного `railway run npx prisma db push` с чьей-то машины.
 *
 * Почему не `prisma migrate deploy` на старте: прод-БД исторически ведётся
 * через db push и НЕ имеет записи baseline-миграции — migrate deploy попытался
 * бы накатить baseline поверх живых таблиц и упал. Идемпотентный DDL ниже
 * строго аддитивен: существующие таблицы не читает и не меняет, повторный
 * запуск — no-op.
 */
export const KNOWLEDGE_SCHEMA_BOOTSTRAP_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "KnowledgeExtractionRun" (
    "id" TEXT NOT NULL,
    "extractionRunId" TEXT NOT NULL,
    "documentId" TEXT,
    "sourceDocPath" TEXT,
    "sourceRevisionHash" TEXT NOT NULL,
    "canonicalTextHash" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "extractionProvider" TEXT NOT NULL,
    "extractionModel" TEXT NOT NULL,
    "extractionPromptVersion" TEXT NOT NULL,
    "extractionSchemaVersion" TEXT NOT NULL,
    "humanReviewed" BOOLEAN NOT NULL DEFAULT false,
    "qualifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeExtractionRun_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE IF NOT EXISTS "KnowledgeUnitRecord" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceBlockAnchor" TEXT NOT NULL,
    "parentRuleRef" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "KnowledgeUnitRecord_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE IF NOT EXISTS "KnowledgeUnitReviewDecision" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reviewedBy" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "KnowledgeUnitReviewDecision_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeExtractionRun_extractionRunId_key" ON "KnowledgeExtractionRun"("extractionRunId")`,
  `CREATE INDEX IF NOT EXISTS "KnowledgeExtractionRun_documentId_idx" ON "KnowledgeExtractionRun"("documentId")`,
  `CREATE INDEX IF NOT EXISTS "KnowledgeExtractionRun_canonicalTextHash_idx" ON "KnowledgeExtractionRun"("canonicalTextHash")`,
  `CREATE INDEX IF NOT EXISTS "KnowledgeUnitRecord_unitId_idx" ON "KnowledgeUnitRecord"("unitId")`,
  `CREATE INDEX IF NOT EXISTS "KnowledgeUnitRecord_contentHash_idx" ON "KnowledgeUnitRecord"("contentHash")`,
  `CREATE INDEX IF NOT EXISTS "KnowledgeUnitRecord_kind_idx" ON "KnowledgeUnitRecord"("kind")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeUnitRecord_runId_unitId_key" ON "KnowledgeUnitRecord"("runId", "unitId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeUnitReviewDecision_unitId_key" ON "KnowledgeUnitReviewDecision"("unitId")`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeExtractionRun_documentId_fkey') THEN
      ALTER TABLE "KnowledgeExtractionRun" ADD CONSTRAINT "KnowledgeExtractionRun_documentId_fkey"
        FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'KnowledgeUnitRecord_runId_fkey') THEN
      ALTER TABLE "KnowledgeUnitRecord" ADD CONSTRAINT "KnowledgeUnitRecord_runId_fkey"
        FOREIGN KEY ("runId") REFERENCES "KnowledgeExtractionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
];

/** Ключ advisory-лока: два инстанса на одном деплое не гоняют DDL наперегонки. */
const BOOTSTRAP_LOCK_KEY = 4_270_813_001;

/**
 * Только `$executeRawUnsafe`, и это не сокращение ради краткости: лок берётся
 * тем же путём, что и DDL. `pg_advisory_lock()` возвращает `void`, а
 * `$queryRaw*` пытается десериализовать колонку результата и падает на нём с
 * "Failed to deserialize column of type 'void'" — исключение прилетало ДО
 * первого DDL, поэтому таблицы молча не создавались при полностью успешном
 * деплое (живой отказ 2026-08-13, деплой `0ec97d79`).
 */
export type SchemaBootstrapDb = Pick<PrismaClient, '$executeRawUnsafe'>;

export interface SchemaBootstrapResult {
  readonly ok: boolean;
  readonly statementsRun: number;
  readonly error?: string;
}

export async function runKnowledgeSchemaBootstrap(
  db: SchemaBootstrapDb = prisma
): Promise<SchemaBootstrapResult> {
  let statementsRun = 0;
  await db.$executeRawUnsafe(`SELECT pg_advisory_lock(${BOOTSTRAP_LOCK_KEY})`);
  try {
    for (const statement of KNOWLEDGE_SCHEMA_BOOTSTRAP_STATEMENTS) {
      await db.$executeRawUnsafe(statement);
      statementsRun++;
    }
    return { ok: true, statementsRun };
  } finally {
    await db
      .$executeRawUnsafe(`SELECT pg_advisory_unlock(${BOOTSTRAP_LOCK_KEY})`)
      .catch(() => undefined);
  }
}

/**
 * Обёртка для старта сервера: ошибка схемы НЕ роняет прод — путь ответов
 * пользователям новые таблицы пока не читает, а мёртвый сервис хуже сервиса
 * без Aurora-таблиц. Ошибка уходит в лог с однозначным префиксом.
 */
export async function bootstrapKnowledgeSchemaAtStartup(): Promise<void> {
  try {
    const result = await runKnowledgeSchemaBootstrap();
    console.log(
      `[aurora-schema-bootstrap] ok: ${result.statementsRun}/${KNOWLEDGE_SCHEMA_BOOTSTRAP_STATEMENTS.length} statements applied`
    );
  } catch (error) {
    console.error('[aurora-schema-bootstrap] FAILED — Aurora v2 таблицы не созданы:', error);
  }
}
