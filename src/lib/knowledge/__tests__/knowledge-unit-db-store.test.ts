import { describe, expect, it } from 'vitest';
import type { ExtractionRunProvenance } from '../knowledge-unit-db-store';
import type { PersistedKnowledgeUnit } from '../applicability/identity-assignment';
import type { ReviewDecision } from '../applicability/review-decision';
import {
  loadLatestReviewedUnitsForDocument,
  loadUnitReviewDecisions,
  loadUnitsForRun,
  saveExtractionRun,
  upsertUnitReviewDecision,
  type KnowledgeUnitDb,
} from '../knowledge-unit-db-store';

const VALID_SOURCE_SPAN = { anchor: 'block-3', quote: 'не более 3 дней подряд' };

function unit(overrides: Partial<PersistedKnowledgeUnit> = {}): PersistedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'Раздражение кожи проходит не более чем за 3 дня подряд.',
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    parentRuleRef: null,
    sourceSpan: VALID_SOURCE_SPAN,
    evidenceByField: { statement: VALID_SOURCE_SPAN },
    uncertainties: [],
    sourceBlockAnchor: 'a1b2c3d4e5f6a7b8',
    unitId: 'f6e5d4c3b2a1b8a7',
    contentHash: '0011223344556677',
    ...overrides,
  };
}

function metadata(overrides: Partial<ExtractionRunProvenance> = {}): ExtractionRunProvenance {
  return {
    sourceRevisionHash: 'rev-hash-1',
    canonicalTextHash: 'canon-hash-1',
    parserVersion: 'parser-v2',
    extractionRunId: 'run-001',
    extractionProvider: 'anthropic',
    extractionModel: 'claude-test',
    extractionPromptVersion: 'prompt-v3',
    extractionSchemaVersion: 'schema-v2',
    ...overrides,
  };
}

interface RunRow {
  id: string;
  extractionRunId: string;
  documentId: string | null;
  sourceDocPath: string | null;
  humanReviewed: boolean;
  qualifiedAt: Date | null;
  createdAt: Date;
  [key: string]: unknown;
}

interface UnitRow {
  runId: string;
  unitId: string;
  contentHash: string;
  kind: string;
  sourceBlockAnchor: string;
  parentRuleRef: string | null;
  payload: unknown;
}

interface DecisionRow {
  unitId: string;
  decision: string;
  reviewedBy: string;
  reviewedAt: Date;
  notes: string | null;
}

/** Ровно те аргументы, которыми стор зовёт Prisma: двойник обязан ломаться, если стор поменяет форму вызова. */
type RunCreateInput = ExtractionRunProvenance & {
  documentId: string | null;
  sourceDocPath: string | null;
  humanReviewed: boolean;
  qualifiedAt: Date | null;
};

type RunUpdateInput = Omit<RunCreateInput, 'extractionRunId'>;

type DecisionCreateInput = DecisionRow;
type DecisionUpdateInput = Omit<DecisionRow, 'unitId'>;

/** In-memory двойник ровно того подмножества Prisma, что использует стор. */
function fakeDb() {
  const runs: RunRow[] = [];
  const units: UnitRow[] = [];
  const decisions: DecisionRow[] = [];
  let nextId = 1;
  let clock = 0;

  const db = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    knowledgeExtractionRun: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { extractionRunId: string };
        create: RunCreateInput;
        update: RunUpdateInput;
      }) => {
        const existing = runs.find((r) => r.extractionRunId === where.extractionRunId);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row: RunRow = {
          id: `run-row-${nextId++}`,
          createdAt: new Date(2026, 0, 1, 0, 0, clock++),
          ...create,
        };
        runs.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { extractionRunId: string } }) =>
        runs.find((r) => r.extractionRunId === where.extractionRunId) ?? null,
      findFirst: async ({
        where,
        orderBy,
      }: {
        where: { documentId: string; humanReviewed?: boolean };
        orderBy?: { createdAt?: 'asc' | 'desc' };
      }) => {
        const matches = runs.filter(
          (r) =>
            r.documentId === where.documentId &&
            (where.humanReviewed === undefined || r.humanReviewed === where.humanReviewed)
        );
        if (orderBy?.createdAt === 'desc') {
          matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        return matches[0] ?? null;
      },
    },
    knowledgeUnitRecord: {
      deleteMany: async ({ where }: { where: { runId: string } }) => {
        for (let i = units.length - 1; i >= 0; i--) {
          if (units[i].runId === where.runId) units.splice(i, 1);
        }
      },
      createMany: async ({ data }: { data: UnitRow[] }) => {
        units.push(...data);
      },
      findMany: async ({ where }: { where: { runId: string } }) =>
        units
          .filter((u) => u.runId === where.runId)
          .sort((a, b) => a.unitId.localeCompare(b.unitId)),
    },
    knowledgeUnitReviewDecision: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { unitId: string };
        create: DecisionCreateInput;
        update: DecisionUpdateInput;
      }) => {
        const existing = decisions.find((d) => d.unitId === where.unitId);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        decisions.push({ ...create });
        return create;
      },
      findMany: async () => [...decisions].sort((a, b) => a.unitId.localeCompare(b.unitId)),
    },
  };

  return { db: db as unknown as KnowledgeUnitDb, runs, units, decisions };
}

describe('saveExtractionRun / loadUnitsForRun', () => {
  it('round-trip: сохранённые юниты читаются байт-в-байт', async () => {
    const { db } = fakeDb();
    const saved = await saveExtractionRun(
      { metadata: metadata(), units: [unit(), unit({ unitId: 'другой-id' })] },
      db
    );
    expect(saved.unitCount).toBe(2);
    const read = await loadUnitsForRun('run-001', db);
    expect(read).toEqual([unit(), unit({ unitId: 'другой-id' })].sort((a, b) => a.unitId.localeCompare(b.unitId)));
  });

  it('повторное сохранение того же прогона идемпотентно — юниты заменяются, не дублируются', async () => {
    const { db, units } = fakeDb();
    await saveExtractionRun({ metadata: metadata(), units: [unit()] }, db);
    await saveExtractionRun(
      { metadata: metadata(), units: [unit({ statement: 'Обновлённая формулировка юнита.' })] },
      db
    );
    expect(units).toHaveLength(1);
    const read = await loadUnitsForRun('run-001', db);
    expect(read[0].statement).toBe('Обновлённая формулировка юнита.');
  });

  it('прогоны с разными id не трогают юниты друг друга', async () => {
    const { db } = fakeDb();
    await saveExtractionRun({ metadata: metadata(), units: [unit()] }, db);
    await saveExtractionRun(
      {
        metadata: metadata({ extractionRunId: 'run-002' }),
        units: [unit({ unitId: 'unit-второго-прогона' })],
      },
      db
    );
    expect(await loadUnitsForRun('run-001', db)).toHaveLength(1);
    expect(await loadUnitsForRun('run-002', db)).toHaveLength(1);
  });

  it('пустой список юнитов — ошибка, а не вырожденный успех', async () => {
    const { db, runs } = fakeDb();
    await expect(saveExtractionRun({ metadata: metadata(), units: [] }, db)).rejects.toThrow(
      /units пуст/
    );
    expect(runs).toHaveLength(0);
  });

  it('один невалидный юнит проваливает весь вызов до первой записи', async () => {
    const { db, runs, units } = fakeDb();
    const broken = { ...unit(), unitId: '' } as PersistedKnowledgeUnit;
    await expect(
      saveExtractionRun({ metadata: metadata(), units: [unit(), broken] }, db)
    ).rejects.toThrow();
    expect(runs).toHaveLength(0);
    expect(units).toHaveLength(0);
  });

  it('битый payload в БД — исключение на чтении, а не молча пролезший юнит', async () => {
    const { db, units } = fakeDb();
    await saveExtractionRun({ metadata: metadata(), units: [unit()] }, db);
    units[0].payload = { мусор: true };
    await expect(loadUnitsForRun('run-001', db)).rejects.toThrow();
  });

  it('неизвестный extractionRunId — пустой массив, не ошибка', async () => {
    const { db } = fakeDb();
    expect(await loadUnitsForRun('нет-такого', db)).toEqual([]);
  });
});

describe('loadLatestReviewedUnitsForDocument', () => {
  it('отдаёт юниты только humanReviewed-прогона; непроверенные прогоны невидимы', async () => {
    const { db } = fakeDb();
    await saveExtractionRun(
      {
        metadata: metadata({ extractionRunId: 'reviewed-run' }),
        units: [unit({ unitId: 'проверенный' })],
        documentId: 'doc-1',
        humanReviewed: true,
        qualifiedAt: '2026-08-13T10:00:00.000Z',
      },
      db
    );
    await saveExtractionRun(
      {
        metadata: metadata({ extractionRunId: 'raw-run' }),
        units: [unit({ unitId: 'сырой' })],
        documentId: 'doc-1',
      },
      db
    );
    const read = await loadLatestReviewedUnitsForDocument('doc-1', db);
    expect(read.map((u) => u.unitId)).toEqual(['проверенный']);
  });

  it('документ без единого проверенного прогона — пустой массив', async () => {
    const { db } = fakeDb();
    await saveExtractionRun(
      { metadata: metadata(), units: [unit()], documentId: 'doc-1' },
      db
    );
    expect(await loadLatestReviewedUnitsForDocument('doc-1', db)).toEqual([]);
  });
});

describe('upsertUnitReviewDecision / loadUnitReviewDecisions', () => {
  const decision: ReviewDecision = {
    unitId: 'f6e5d4c3b2a1b8a7',
    decision: 'ACCEPT',
    reviewedBy: 'operator-1',
    reviewedAt: '2026-08-13T09:30:00.000Z',
  };

  it('round-trip с нотами и без', async () => {
    const { db } = fakeDb();
    await upsertUnitReviewDecision(decision, db);
    await upsertUnitReviewDecision(
      { ...decision, unitId: 'второй-unit', notes: 'цитата сверена' },
      db
    );
    const read = await loadUnitReviewDecisions(db);
    expect(read).toHaveLength(2);
    expect(read).toEqual(
      expect.arrayContaining([
        { ...decision, unitId: 'второй-unit', notes: 'цитата сверена' },
        decision,
      ])
    );
  });

  it('last-write-wins: повторное решение по тому же unitId заменяет старое, дубликата нет', async () => {
    const { db, decisions } = fakeDb();
    await upsertUnitReviewDecision(decision, db);
    await upsertUnitReviewDecision(
      { ...decision, decision: 'REJECT', reviewedAt: '2026-08-13T11:00:00.000Z' },
      db
    );
    expect(decisions).toHaveLength(1);
    const read = await loadUnitReviewDecisions(db);
    expect(read[0].decision).toBe('REJECT');
    expect(read[0].reviewedAt).toBe('2026-08-13T11:00:00.000Z');
  });
});
