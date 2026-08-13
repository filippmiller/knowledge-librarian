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
 * Предел на ВЕСЬ bootstrap при старте сервера.
 *
 * Живой отказ 2026-08-13 (деплой `0a89eb7c`): после починки лока bootstrap
 * впервые реально дошёл до БД — и завис. В логах контейнера `Ready in 93ms`,
 * затем `Stopping Container`, и НИ ОДНОЙ строки `[aurora-schema-bootstrap]`:
 * ни `ok`, ни `FAILED`. Healthcheck 11 раз получил service unavailable и
 * деплой был отменён.
 *
 * Причина класса: `register()` в instrumentation.ts ждёт bootstrap, а тот ждал
 * БД без единого предела. Любая блокировка на стороне Postgres — удерживаемый
 * advisory-лок, ожидание блокировки `Document` при добавлении внешнего ключа,
 * зависшее соединение — превращалась в несостоявшийся деплой.
 *
 * Модуль с самого начала объявляет политику «мёртвый сервис хуже сервиса без
 * Aurora-таблиц». Ловить только ИСКЛЮЧЕНИЕ для этого мало: зависание не бросает
 * ничего. Предел ниже делает политику исполнимой, а не декларативной.
 */
const BOOTSTRAP_TOTAL_TIMEOUT_MS = 20_000;

export type SchemaBootstrapDb = Pick<PrismaClient, '$executeRawUnsafe' | '$queryRawUnsafe'>;

export interface SchemaBootstrapResult {
  readonly ok: boolean;
  readonly statementsRun: number;
  /**
   * true — лок занят другим инстансом, DDL СОЗНАТЕЛЬНО пропущен. Это не ошибка:
   * схему в этот момент приводит в порядок сосед, а весь DDL идемпотентен.
   */
  readonly skippedLockHeld?: boolean;
  readonly error?: string;
}

export async function runKnowledgeSchemaBootstrap(
  db: SchemaBootstrapDb = prisma
): Promise<SchemaBootstrapResult> {
  let statementsRun = 0;
  // pg_TRY_advisory_lock, а не pg_advisory_lock: блокирующий вариант ЖДЁТ
  // столько, сколько нужно, и именно это подвесило старт сервера 2026-08-13
  // (деплой `0a89eb7c`). Try-версия отвечает мгновенно — либо взяли, либо нет.
  //
  // Читаем результат через $queryRawUnsafe и это НЕ возврат к прошлому багу:
  // упал он на pg_advisory_lock(), возвращающем `void`, который Prisma не умеет
  // десериализовать. pg_try_advisory_lock() возвращает boolean — обычный тип,
  // читается штатно. Иначе результат лока прочитать нечем: $executeRaw отдаёт
  // счётчик строк, а не значение.
  const lockRows = await db.$queryRawUnsafe<Array<{ locked: boolean }>>(
    `SELECT pg_try_advisory_lock(${BOOTSTRAP_LOCK_KEY}) AS locked`
  );
  if (lockRows[0]?.locked !== true) {
    // Лок у соседнего инстанса — он и приводит схему в порядок. Ждать нечего:
    // весь DDL идемпотентен, а ожидание здесь стоило бы готовности сервера.
    return { ok: true, statementsRun: 0, skippedLockHeld: true };
  }
  try {
    for (const statement of KNOWLEDGE_SCHEMA_BOOTSTRAP_STATEMENTS) {
      await db.$executeRawUnsafe(statement);
      statementsRun++;
    }
    return { ok: true, statementsRun };
  } finally {
    // Разлок через executeRaw: pg_advisory_unlock() возвращает boolean, но
    // значение здесь не нужно — важен только сам вызов.
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
 * Обёртка для старта сервера: ни ошибка схемы, ни ЗАВИСАНИЕ на БД не мешают
 * сервису подняться — путь ответов пользователям новые таблицы пока не читает,
 * а мёртвый сервис хуже сервиса без Aurora-таблиц. Оба исхода уходят в лог и в
 * getLastBootstrapStatus().
 *
 * Предел обязателен ИМЕННО здесь, а не только внутри: `register()` ждёт эту
 * функцию, и до 2026-08-13 зависание БД означало провал healthcheck и отмену
 * деплоя. Исключение ловилось, зависание — нет.
 */
export async function bootstrapKnowledgeSchemaAtStartup(
  db: SchemaBootstrapDb = prisma
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      runKnowledgeSchemaBootstrap(db),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `bootstrap не уложился в ${BOOTSTRAP_TOTAL_TIMEOUT_MS} мс — БД не отвечает или держит блокировку; старт сервера продолжается без Aurora-таблиц`
              )
            ),
          BOOTSTRAP_TOTAL_TIMEOUT_MS
        );
        timer.unref?.();
      }),
    ]);
    if (result.skippedLockHeld === true) {
      lastBootstrapStatus = {
        at: new Date().toISOString(),
        ok: true,
        statementsRun: 0,
        error: null,
      };
      console.log('[aurora-schema-bootstrap] пропущен: лок держит другой инстанс');
      return;
    }
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
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
