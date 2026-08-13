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
  // Лок и анлок идут через $executeRawUnsafe, НЕ через $queryRawUnsafe:
  // pg_advisory_lock() возвращает тип void, а десериализация void-колонки —
  // известная ошибка Prisma («Failed to deserialize column of type 'void'»).
  // Именно на этом первый прод-запуск bootstrap'а упал целиком (2026-08-13:
  // /api/health/schema отвечал, а таблиц не было). executeRaw колонок не
  // читает — возвращает только счётчик строк.
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

export interface BootstrapStatus {
  readonly at: string;
  readonly ok: boolean;
  readonly statementsRun: number;
  readonly error: string | null;
}

// Память последнего запуска — /api/health/schema показывает её наружу, чтобы
// сбой bootstrap'а был виден по HTTPS, а не только в логах контейнера
// (первый прод-сбой 2026-08-13 диагностировался вслепую именно из-за этого).
let lastBootstrapStatus: BootstrapStatus | null = null;

export function getLastBootstrapStatus(): BootstrapStatus | null {
  return lastBootstrapStatus;
}

/**
 * Обёртка для старта сервера: ошибка схемы НЕ роняет прод — путь ответов
 * пользователям новые таблицы пока не читает, а мёртвый сервис хуже сервиса
 * без Aurora-таблиц. Ошибка уходит в лог и в getLastBootstrapStatus().
 */
export async function bootstrapKnowledgeSchemaAtStartup(): Promise<void> {
  try {
    const result = await runKnowledgeSchemaBootstrap();
    lastBootstrapStatus = {
      at: new Date().toISOString(),
      ok: true,
      statementsRun: result.statementsRun,
      error: null,
    };
    console.log(
      `[aurora-schema-bootstrap] ok: ${result.statementsRun}/${KNOWLEDGE_SCHEMA_BOOTSTRAP_STATEMENTS.length} statements applied`
    );
  } catch (error) {
    lastBootstrapStatus = {
      at: new Date().toISOString(),
      ok: false,
      statementsRun: 0,
      error: error instanceof Error ? error.message : String(error),
    };
    console.error('[aurora-schema-bootstrap] FAILED — Aurora v2 таблицы не созданы:', error);
  }
}
