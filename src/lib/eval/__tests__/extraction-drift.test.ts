import { describe, expect, it } from 'vitest';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';
import { compareExtractionRuns } from '../extraction-drift';

/**
 * translation-bqt — Gate 2 (diagnostic, non-blocking), реализация
 * docs/plans/2026-08-08-reviewed-snapshot-vs-drift-gate-design.md.
 *
 * `compareExtractionRuns(baseline, candidate)` НИКОГДА не бросает и не
 * "проваливает" прогон — это чистая классификация различий между иммутабельным
 * reviewed snapshot (`baseline`) и свежим `--stage=extraction` прогоном
 * (`candidate`). Сценарии здесь взяты из РЕАЛЬНОГО расхождения run1/run2
 * этой сессии (см. отчёт), не выдуманы.
 */

const span = (anchor: string, quote: string) => ({ anchor, quote });

function unit(overrides: Partial<PersistedKnowledgeUnit> = {}): PersistedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'Не дольше 15 секунд подряд.',
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    parentRuleRef: null,
    sourceSpan: span('anchor-1', 'не дольше 15 секунд'),
    evidenceByField: { statement: span('anchor-1', 'не дольше 15 секунд') },
    uncertainties: [],
    sourceBlockAnchor: 'block-1',
    unitId: 'u1',
    contentHash: 'hash-1',
    ...overrides,
  };
}

describe('compareExtractionRuns — STABLE', () => {
  it('идентичный unit в обеих сторонах -> STABLE, без drift-флагов', () => {
    const report = compareExtractionRuns([unit()], [unit()]);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({ unitId: 'u1', status: 'STABLE' });
    expect(report.stableCount).toBe(1);
    expect(report.contentChangedCount).toBe(0);
    expect(report.omittedCount).toBe(0);
    expect(report.addedCount).toBe(0);
  });
});

describe('compareExtractionRuns — CONTENT_CHANGE', () => {
  it('тот же unitId, другой contentHash -> CONTENT_CHANGE, contentHashChanged=true', () => {
    const report = compareExtractionRuns([unit()], [unit({ contentHash: 'hash-2' })]);
    expect(report.entries[0]).toMatchObject({ unitId: 'u1', status: 'CONTENT_CHANGE' });
    expect(report.entries[0].detail?.contentHashChanged).toBe(true);
    expect(report.contentChangedCount).toBe(1);
  });
});

describe('compareExtractionRuns — CONTENT_OMISSION / CONTENT_ADDITION', () => {
  it('unit есть в baseline, отсутствует в candidate -> CONTENT_OMISSION (реальный кейс: "визуально чистые руки" пропало между прогонами)', () => {
    const report = compareExtractionRuns([unit({ unitId: 'omitted' })], []);
    expect(report.entries).toEqual([
      expect.objectContaining({ unitId: 'omitted', status: 'CONTENT_OMISSION', detail: null }),
    ]);
    expect(report.omittedCount).toBe(1);
  });

  it('unit есть в candidate, отсутствует в baseline -> CONTENT_ADDITION', () => {
    const report = compareExtractionRuns([], [unit({ unitId: 'added' })]);
    expect(report.entries).toEqual([
      expect.objectContaining({ unitId: 'added', status: 'CONTENT_ADDITION', detail: null }),
    ]);
    expect(report.addedCount).toBe(1);
  });
});

describe('compareExtractionRuns — PARENT_DRIFT / TRIGGER_DRIFT / UNCERTAINTY_DRIFT', () => {
  it('тот же unitId, тот же contentHash, но parentRuleRef изменился (реальный кейс: rule 10, второй EXCEPTION_RULE) -> parentDrift=true', () => {
    const report = compareExtractionRuns(
      [unit({ parentRuleRef: null })],
      [unit({ parentRuleRef: 'some-other-unit' })]
    );
    expect(report.entries[0].detail?.parentDrift).toBe(true);
  });

  it('тот же unitId, но triggerCondition отличается по составу (реальный кейс: rule 9, consentStatus появился только в run2) -> triggerDrift=true', () => {
    const report = compareExtractionRuns(
      [unit({ triggerCondition: { all: [{ fact: 'helperPresent', equals: true }] } })],
      [
        unit({
          triggerCondition: {
            all: [
              { fact: 'consentStatus', equals: 'EXPLICIT' },
              { fact: 'helperPresent', equals: true },
            ],
          },
        }),
      ]
    );
    expect(report.entries[0].detail?.triggerDrift).toBe(true);
  });

  it('порядок конъюнктов triggerCondition.all НЕ считается drift (тот же смысл, другой порядок)', () => {
    const report = compareExtractionRuns(
      [
        unit({
          triggerCondition: {
            all: [
              { fact: 'privacyContext', equals: 'PUBLIC' },
              { fact: 'consentStatus', equals: 'EXPLICIT' },
            ],
          },
        }),
      ],
      [
        unit({
          triggerCondition: {
            all: [
              { fact: 'consentStatus', equals: 'EXPLICIT' },
              { fact: 'privacyContext', equals: 'PUBLIC' },
            ],
          },
        }),
      ]
    );
    expect(report.entries[0].detail?.triggerDrift).toBe(false);
  });

  it('состав uncertainties изменился -> uncertaintyDrift=true', () => {
    const report = compareExtractionRuns(
      [unit({ uncertainties: [] })],
      [unit({ uncertainties: [{ kind: 'OTHER', description: 'новая находка', quote: 'x' }] })]
    );
    expect(report.entries[0].detail?.uncertaintyDrift).toBe(true);
  });
});

describe('compareExtractionRuns — FRAGMENTATION_CHANGE', () => {
  it('на одном sourceBlockAnchor одновременно есть omission И addition -> группируется как fragmentation change (реальный кейс: block b7/b12, split<->merge между run1/run2)', () => {
    const baseline = [
      unit({ unitId: 'split-1', sourceBlockAnchor: 'block-7', statement: 'Часть А.' }),
      unit({ unitId: 'split-2', sourceBlockAnchor: 'block-7', statement: 'Часть Б.' }),
    ];
    const candidate = [
      unit({ unitId: 'merged', sourceBlockAnchor: 'block-7', statement: 'Часть А и Часть Б вместе.' }),
    ];

    const report = compareExtractionRuns(baseline, candidate);

    expect(report.fragmentationChanges).toHaveLength(1);
    expect(report.fragmentationChanges[0]).toMatchObject({
      sourceBlockAnchor: 'block-7',
    });
    expect(new Set(report.fragmentationChanges[0].omittedUnitIds)).toEqual(
      new Set(['split-1', 'split-2'])
    );
    expect(report.fragmentationChanges[0].addedUnitIds).toEqual(['merged']);
  });

  it('чистый omission БЕЗ addition на том же anchor — НЕ fragmentation change (реальная потеря содержания, отдельный сигнал)', () => {
    const report = compareExtractionRuns(
      [unit({ unitId: 'lost', sourceBlockAnchor: 'block-6' })],
      []
    );
    expect(report.fragmentationChanges).toEqual([]);
    expect(report.omittedCount).toBe(1);
  });

  it('omission на одном anchor и addition на ДРУГОМ anchor — НЕ группируются вместе', () => {
    const report = compareExtractionRuns(
      [unit({ unitId: 'a', sourceBlockAnchor: 'block-1' })],
      [unit({ unitId: 'b', sourceBlockAnchor: 'block-2' })]
    );
    expect(report.fragmentationChanges).toEqual([]);
  });
});

describe('compareExtractionRuns — не бросает, всегда возвращает отчёт', () => {
  it('оба пустые -> пустой отчёт, не исключение', () => {
    const report = compareExtractionRuns([], []);
    expect(report.entries).toEqual([]);
    expect(report.stableCount).toBe(0);
  });
});
