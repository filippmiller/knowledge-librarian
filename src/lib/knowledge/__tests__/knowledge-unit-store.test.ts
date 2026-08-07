import { mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PersistedKnowledgeUnit } from '../applicability/identity-assignment';
import type { ReviewDecision } from '../applicability/review-decision';
import {
  appendReviewDecision,
  readReviewDecisionsJsonl,
  readUnitsJsonl,
  writeUnitsJsonl,
} from '../knowledge-unit-store';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const mockedRename = vi.mocked(rename);

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

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'jsonl-store-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  mockedRename.mockClear();
});

describe('readUnitsJsonl / writeUnitsJsonl', () => {
  it('файл, которого ещё нет, — пустой массив, не ошибка (первый прогон на новом документе)', async () => {
    const units = await readUnitsJsonl(join(dir, 'nonexistent.jsonl'));
    expect(units).toEqual([]);
  });

  it('round-trip сохраняет units, создаёт вложенные директории', async () => {
    const filePath = join(dir, 'nested', 'units.jsonl');
    const units = [unit(), unit({ unitId: 'другой-id', sourceSpan: { anchor: 'b', quote: 'x' } })];
    await writeUnitsJsonl(filePath, units);
    const read = await readUnitsJsonl(filePath);
    expect(read).toEqual(units);
  });

  it('файл читаем как plain JSONL — cat/grep без тулинга', async () => {
    const filePath = join(dir, 'units.jsonl');
    await writeUnitsJsonl(filePath, [unit()]);
    const raw = await readFile(filePath, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ unitId: 'f6e5d4c3b2a1b8a7' });
  });

  it('запись атомарна — temp-файл убран, в директории остаётся только целевой файл (write-then-rename, не прямой перезаписи)', async () => {
    const filePath = join(dir, 'units.jsonl');
    await writeUnitsJsonl(filePath, [unit()]);
    const entries = await readdir(dir);
    expect(entries).toEqual(['units.jsonl']);
  });

  it('крах МЕЖДУ записью temp-файла и rename не портит существующий файл — находка независимого ревью (Grok+Codex) этого PR', async () => {
    const filePath = join(dir, 'units.jsonl');
    await writeUnitsJsonl(filePath, [unit()]); // существующее, "хорошее" состояние

    mockedRename.mockRejectedValueOnce(new Error('симулированный крах процесса'));
    await expect(
      writeUnitsJsonl(filePath, [unit({ unitId: 'новая-версия-которая-не-долетела' })])
    ).rejects.toThrow('симулированный крах процесса');

    // Прямая запись (writeFile в целевой путь) на этом месте уже обнулила бы
    // файл, даже не записав новых данных — rename упал ПОСЛЕ записи temp,
    // но исходный файл обязан остаться нетронутым.
    const survived = await readUnitsJsonl(filePath);
    expect(survived).toEqual([unit()]);
  });
});

describe('appendReviewDecision — повторный прогон не создаёт дубликаты', () => {
  const decision: ReviewDecision = {
    unitId: 'unit-1',
    decision: 'ACCEPT',
    reviewedBy: 'anna',
    reviewedAt: '2026-08-07T10:00:00Z',
  };

  it('первое решение — создаёт файл с одной записью', async () => {
    const filePath = join(dir, 'reviews.jsonl');
    const result = await appendReviewDecision(filePath, decision);
    expect(result).toEqual([decision]);
    expect(await readReviewDecisionsJsonl(filePath)).toEqual([decision]);
  });

  it('повторный вызов с ТЕМ ЖЕ unitId — заменяет запись на диске, не добавляет вторую строку', async () => {
    const filePath = join(dir, 'reviews.jsonl');
    await appendReviewDecision(filePath, decision);
    const revised: ReviewDecision = { ...decision, decision: 'EDIT', reviewedAt: '2026-08-07T12:00:00Z' };
    const result = await appendReviewDecision(filePath, revised);

    expect(result).toEqual([revised]);
    const onDisk = await readReviewDecisionsJsonl(filePath);
    expect(onDisk).toEqual([revised]);
  });

  it('решения по разным unitId накапливаются', async () => {
    const filePath = join(dir, 'reviews.jsonl');
    await appendReviewDecision(filePath, decision);
    const other: ReviewDecision = { ...decision, unitId: 'unit-2' };
    const result = await appendReviewDecision(filePath, other);
    expect(result).toHaveLength(2);
  });
});
