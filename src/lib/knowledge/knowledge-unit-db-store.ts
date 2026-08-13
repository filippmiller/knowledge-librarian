import type { Prisma, PrismaClient } from '@prisma/client';
import prisma from '@/lib/db';
import type { PersistedKnowledgeUnit } from './applicability/identity-assignment';
import { persistedKnowledgeUnitSchema } from './applicability/persisted-unit';
import { reviewDecisionSchema, type ReviewDecision } from './applicability/review-decision';

/**
 * Production Prisma-persistence юнитов нового движка (план §2.4 — БД-слой
 * после пилота; файловый JSONL-слой в knowledge-unit-store.ts остаётся для
 * пилотных прогонов вне БД).
 *
 * Источник истины — колонка payload: канонический JSON юнита, который
 * persistedKnowledgeUnitSchema валидирует и на записи, и на чтении. Колонки
 * unitId/contentHash/kind/... — денормализация для выборок; расхождение
 * payload'а с колонками невозможно, потому что обе стороны пишутся из одного
 * распарсенного объекта в одной транзакции.
 *
 * Ничего из старого контура (Rule/QAPair/DocChunk) здесь не удаляется и не
 * изменяется: юниты нового движка лежат РЯДОМ со старыми правилами, а не
 * вместо них — переключение ответов на новые знания отдельный шаг со своим
 * гейтом (reviewed-snapshot.ts), не побочный эффект сохранения.
 */

/** Подмножество PrismaClient, которое использует этот модуль, — в тестах
 *  подменяется in-memory реализацией без реальной БД. */
export type KnowledgeUnitDb = Pick<PrismaClient, '$transaction'> & {
  knowledgeExtractionRun: Pick<
    PrismaClient['knowledgeExtractionRun'],
    'upsert' | 'findUnique' | 'findFirst'
  >;
  knowledgeUnitRecord: Pick<
    PrismaClient['knowledgeUnitRecord'],
    'deleteMany' | 'createMany' | 'findMany'
  >;
  knowledgeUnitReviewDecision: Pick<
    PrismaClient['knowledgeUnitReviewDecision'],
    'upsert' | 'findMany'
  >;
};

/**
 * Провенанс одного прогона извлечения. Поле-в-поле совпадает с
 * EvaluationSnapshotMetadata (src/lib/eval/evaluation-snapshot.ts), но живёт
 * на продуктовой стороне: oracle-isolation запрещает продуктовому коду
 * импортировать что-либо из lib/eval, и это правильная граница — eval может
 * зависеть от продуктовых типов, не наоборот.
 */
export interface ExtractionRunProvenance {
  readonly sourceRevisionHash: string;
  readonly canonicalTextHash: string;
  readonly parserVersion: string;
  readonly extractionRunId: string;
  readonly extractionProvider: string;
  readonly extractionModel: string;
  readonly extractionPromptVersion: string;
  readonly extractionSchemaVersion: string;
}

export interface SaveExtractionRunInput {
  readonly metadata: ExtractionRunProvenance;
  readonly units: readonly PersistedKnowledgeUnit[];
  /** Прод-документ, из которого извлекали; null для пилотных фикстур. */
  readonly documentId?: string | null;
  /** Путь фикстуры для пилотных прогонов вне БД. */
  readonly sourceDocPath?: string | null;
  /** true только после прохождения человеческого ревью (Gate 1). */
  readonly humanReviewed?: boolean;
  readonly qualifiedAt?: string | null;
}

export interface SavedExtractionRun {
  readonly runRecordId: string;
  readonly extractionRunId: string;
  readonly unitCount: number;
}

/**
 * Сохраняет прогон извлечения целиком и идемпотентно: повторный вызов с тем
 * же extractionRunId заменяет юниты ЭТОГО прогона (та же семантика, что
 * атомарная перезапись JSONL-файла), а прогоны с другими id не трогает.
 * Валидация — до первой записи: один невалидный юнит проваливает весь вызов,
 * частично сохранённых прогонов не бывает.
 */
export async function saveExtractionRun(
  input: SaveExtractionRunInput,
  db: KnowledgeUnitDb = prisma
): Promise<SavedExtractionRun> {
  if (input.units.length === 0) {
    // Та же защита, что buildEvaluationSnapshot: вырожденный "успех" на
    // пустой экстракции скрыл бы сломанный пайплайн.
    throw new Error(
      'saveExtractionRun: units пуст — свежая экстракция не выдала ни одного unit, сохранять нечего'
    );
  }
  const units = input.units.map((unit) => persistedKnowledgeUnitSchema.parse(unit));
  const meta = input.metadata;

  const runRecordId = await db.$transaction(async (tx) => {
    const run = await tx.knowledgeExtractionRun.upsert({
      where: { extractionRunId: meta.extractionRunId },
      create: {
        extractionRunId: meta.extractionRunId,
        documentId: input.documentId ?? null,
        sourceDocPath: input.sourceDocPath ?? null,
        sourceRevisionHash: meta.sourceRevisionHash,
        canonicalTextHash: meta.canonicalTextHash,
        parserVersion: meta.parserVersion,
        extractionProvider: meta.extractionProvider,
        extractionModel: meta.extractionModel,
        extractionPromptVersion: meta.extractionPromptVersion,
        extractionSchemaVersion: meta.extractionSchemaVersion,
        humanReviewed: input.humanReviewed ?? false,
        qualifiedAt: input.qualifiedAt ? new Date(input.qualifiedAt) : null,
      },
      update: {
        documentId: input.documentId ?? null,
        sourceDocPath: input.sourceDocPath ?? null,
        sourceRevisionHash: meta.sourceRevisionHash,
        canonicalTextHash: meta.canonicalTextHash,
        parserVersion: meta.parserVersion,
        extractionProvider: meta.extractionProvider,
        extractionModel: meta.extractionModel,
        extractionPromptVersion: meta.extractionPromptVersion,
        extractionSchemaVersion: meta.extractionSchemaVersion,
        humanReviewed: input.humanReviewed ?? false,
        qualifiedAt: input.qualifiedAt ? new Date(input.qualifiedAt) : null,
      },
    });
    await tx.knowledgeUnitRecord.deleteMany({ where: { runId: run.id } });
    await tx.knowledgeUnitRecord.createMany({
      data: units.map((unit) => ({
        runId: run.id,
        unitId: unit.unitId,
        contentHash: unit.contentHash,
        kind: unit.kind,
        sourceBlockAnchor: unit.sourceBlockAnchor,
        parentRuleRef: unit.parentRuleRef,
        payload: unit as unknown as Prisma.InputJsonValue,
      })),
    });
    return run.id;
  });

  return {
    runRecordId,
    extractionRunId: meta.extractionRunId,
    unitCount: units.length,
  };
}

/**
 * Юниты одного прогона, каждый payload заново провалидирован схемой: битая
 * строка в БД — исключение на чтении, а не молча пролезший в ответы юнит.
 */
export async function loadUnitsForRun(
  extractionRunId: string,
  db: KnowledgeUnitDb = prisma
): Promise<PersistedKnowledgeUnit[]> {
  const run = await db.knowledgeExtractionRun.findUnique({ where: { extractionRunId } });
  if (run === null) return [];
  const records = await db.knowledgeUnitRecord.findMany({
    where: { runId: run.id },
    orderBy: { unitId: 'asc' },
  });
  return records.map((record) => persistedKnowledgeUnitSchema.parse(record.payload));
}

/**
 * Юниты последнего прошедшего ревью прогона по документу — единственная
 * выборка, которой разрешено кормить retrieval/applicability/synthesis
 * (граница humanReviewed — та же, что ReviewedKnowledgeSnapshot).
 */
export async function loadLatestReviewedUnitsForDocument(
  documentId: string,
  db: KnowledgeUnitDb = prisma
): Promise<PersistedKnowledgeUnit[]> {
  const run = await db.knowledgeExtractionRun.findFirst({
    where: { documentId, humanReviewed: true },
    orderBy: { createdAt: 'desc' },
  });
  if (run === null) return [];
  const records = await db.knowledgeUnitRecord.findMany({
    where: { runId: run.id },
    orderBy: { unitId: 'asc' },
  });
  return records.map((record) => persistedKnowledgeUnitSchema.parse(record.payload));
}

/**
 * Last-write-wins по unitId — та же семантика, что upsertReviewDecision в
 * review-decision.ts: повторный прогон по неизменному документу дубликат не
 * создаёт, новое решение заменяет старое целиком.
 */
export async function upsertUnitReviewDecision(
  decision: ReviewDecision,
  db: KnowledgeUnitDb = prisma
): Promise<void> {
  const parsed = reviewDecisionSchema.parse(decision);
  await db.knowledgeUnitReviewDecision.upsert({
    where: { unitId: parsed.unitId },
    create: {
      unitId: parsed.unitId,
      decision: parsed.decision,
      reviewedBy: parsed.reviewedBy,
      reviewedAt: new Date(parsed.reviewedAt),
      notes: parsed.notes ?? null,
    },
    update: {
      decision: parsed.decision,
      reviewedBy: parsed.reviewedBy,
      reviewedAt: new Date(parsed.reviewedAt),
      notes: parsed.notes ?? null,
    },
  });
}

export async function loadUnitReviewDecisions(
  db: KnowledgeUnitDb = prisma
): Promise<ReviewDecision[]> {
  const rows = await db.knowledgeUnitReviewDecision.findMany({ orderBy: { unitId: 'asc' } });
  return rows.map((row) =>
    reviewDecisionSchema.parse({
      unitId: row.unitId,
      decision: row.decision,
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt.toISOString(),
      ...(row.notes === null ? {} : { notes: row.notes }),
    })
  );
}
