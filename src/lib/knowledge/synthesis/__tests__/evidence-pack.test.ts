import { describe, expect, it } from 'vitest';
import type { PersistedKnowledgeUnit } from '../../applicability/identity-assignment';
import type { ResolutionDecision } from '../../applicability/resolution';
import { buildEvidencePack } from '../evidence-pack';

/**
 * План §3 PR H — правила synthesis-пути, обязательные, а не рекомендации:
 * «генератор получает ТОЛЬКО selected reviewed units — не сырые чанки, не
 * результаты поиска до applicability-фильтрации»; «citations строятся из source
 * anchors (PR F), не из порядкового номера кандидата».
 *
 * Evidence pack — это ГРАНИЦА: всё, что синтезатор вправе увидеть, и ничего
 * сверх того.
 */

const span = (anchor: string, quote: string) => ({ anchor, quote });

function unit(overrides: Partial<PersistedKnowledgeUnit> = {}): PersistedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'Непрерывное почёсывание допускается не дольше 15 секунд.',
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

function resolution(overrides: Partial<ResolutionDecision> = {}): ResolutionDecision {
  return {
    disposition: 'ANSWER',
    selected: ['u1'],
    undetermined: [],
    excluded: [],
    overridden: [],
    numericConflicts: [],
    requiresHumanReview: false,
    clarificationNeeds: { facets: [], triggerFacts: [], ambiguities: [] },
    reasons: [],
    ...overrides,
  };
}

describe('buildEvidencePack — граница «только выбранное»', () => {
  it('включает выбранный unit', () => {
    const pack = buildEvidencePack([unit()], resolution());

    expect(pack.items).toHaveLength(1);
    expect(pack.items[0].unitId).toBe('u1');
    expect(pack.items[0].statement).toContain('15 секунд');
  });

  it('НЕ включает кандидата, который не выбран — даже если его передали', () => {
    const pack = buildEvidencePack(
      [unit(), unit({ unitId: 'u2', statement: 'Исключение для автобуса.' })],
      resolution({ selected: ['u1'] })
    );

    expect(pack.items.map((i) => i.unitId)).toEqual(['u1']);
  });

  it('НЕ включает исключённого кандидата', () => {
    const pack = buildEvidencePack(
      [unit(), unit({ unitId: 'u2' })],
      resolution({ selected: ['u1'], excluded: [{ unitId: 'u2', reason: 'scope_conflict' }] })
    );

    expect(pack.items.map((i) => i.unitId)).toEqual(['u1']);
  });

  it('НЕ включает неопределившегося кандидата — UNKNOWN не даёт права на синтез', () => {
    const pack = buildEvidencePack(
      [unit(), unit({ unitId: 'u2' })],
      resolution({ selected: ['u1'], undetermined: [{ unitId: 'u2', reason: 'scope_unknown_held' }] })
    );

    expect(pack.items.map((i) => i.unitId)).toEqual(['u1']);
  });

  it('падает, если выбранного unit нет среди переданных — молча меньше evidence недопустимо', () => {
    expect(() => buildEvidencePack([unit()], resolution({ selected: ['u1', 'missing'] }))).toThrow(
      /missing/
    );
  });

  it('падает при disposition, отличном от ANSWER — синтезировать нечего', () => {
    expect(() =>
      buildEvidencePack([unit()], resolution({ disposition: 'CLARIFY', selected: ['u1'] }))
    ).toThrow(/CLARIFY/);
    expect(() =>
      buildEvidencePack([unit()], resolution({ disposition: 'HOLD', selected: ['u1'] }))
    ).toThrow(/HOLD/);
  });

  it('падает на пустом наборе выбранного — ответ без evidence запрещён', () => {
    expect(() => buildEvidencePack([unit()], resolution({ selected: [] }))).toThrow();
  });
});

describe('buildEvidencePack — цитаты и числа', () => {
  it('цитата берётся из source anchor, а не из порядкового номера кандидата', () => {
    const pack = buildEvidencePack(
      [unit({ sourceSpan: span('anchor-42', 'цитата из источника') })],
      resolution()
    );

    expect(pack.items[0].citation).toEqual({ anchor: 'anchor-42', quote: 'цитата из источника' });
  });

  it('собирает numericConstraint выбранных unit-ов', () => {
    const pack = buildEvidencePack(
      [
        unit({ numericConstraint: { factKey: 'max_seconds', value: 15, unit: 'seconds' } }),
        unit({
          unitId: 'u2',
          numericConstraint: { factKey: 'min_pause_seconds', value: 30, unit: 'seconds' },
        }),
      ],
      resolution({ selected: ['u1', 'u2'] })
    );

    expect(pack.numericFacts).toEqual([
      { factKey: 'max_seconds', value: 15, unit: 'seconds' },
      { factKey: 'min_pause_seconds', value: 30, unit: 'seconds' },
    ]);
  });

  it('не включает числа НЕвыбранных unit-ов — иначе ответ обоснует чужое ограничение', () => {
    const pack = buildEvidencePack(
      [
        unit(),
        unit({
          unitId: 'u2',
          numericConstraint: { factKey: 'max_cycles', value: 3, unit: 'cycles' },
        }),
      ],
      resolution({ selected: ['u1'] })
    );

    expect(pack.numericFacts).toEqual([]);
  });

  it('сохраняет порядок выбранного набора — детерминированный артефакт прогона', () => {
    const pack = buildEvidencePack(
      [unit({ unitId: 'u2' }), unit({ unitId: 'u1' })],
      resolution({ selected: ['u1', 'u2'] })
    );

    expect(pack.items.map((i) => i.unitId)).toEqual(['u1', 'u2']);
  });

  it('падает на дубле unitId среди переданных — неоднозначно, чью цитату брать', () => {
    expect(() =>
      buildEvidencePack([unit(), unit({ statement: 'другое' })], resolution())
    ).toThrow(/u1/);
  });
});
