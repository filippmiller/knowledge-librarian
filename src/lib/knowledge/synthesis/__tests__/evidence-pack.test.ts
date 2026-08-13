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
  it('carries recognized effective trigger evidence and negative mode into presentation conditions', () => {
    const pack = buildEvidencePack(
      [unit()],
      resolution({
        selectedApplicability: [{
          unitId: 'u1',
          mode: 'NEGATIVE',
          presentationConditions: ['только при явном согласии'],
        }],
      })
    );
    expect(pack.items[0]).toMatchObject({
      applicabilityMode: 'NEGATIVE',
      presentationConditions: ['только при явном согласии'],
    });
  });

  it('negative numeric evidence is visible for denial but cannot ground a positive numeric claim', () => {
    const negative = unit({ numericConstraint: { factKey: 'maximum', value: 3, unit: 'times' } });
    const pack = buildEvidencePack(
      [negative],
      resolution({
        selected: [],
        negativeEvidence: ['u1'],
        selectedApplicability: [{ unitId: 'u1', mode: 'NEGATIVE', presentationConditions: ['только при согласии'] }],
      })
    );
    expect(pack.items).toHaveLength(1);
    expect(pack.items[0].numericConstraint?.value).toBe(3);
    expect(pack.numericFacts).toEqual([]);
  });

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

describe('buildEvidencePack — overridden direct-parent supporting context', () => {
  const child = (id: string, parentRuleRef: string) => unit({
    unitId: id,
    kind: 'EXCEPTION_RULE',
    parentRuleRef,
    triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] },
    statement: `Исключение ${id}`,
  });

  it('keeps a direct overridden parent as non-operative context without reselecting it', () => {
    const parent = unit({
      unitId: 'parent',
      statement: 'Не более 3 секунд, затем перейти в уединённое место; не повторять.',
      numericConstraint: { factKey: 'max_seconds', value: 3, unit: 'seconds' },
    });
    const pack = buildEvidencePack(
      [parent, child('exception', 'parent')],
      resolution({ selected: ['exception'], overridden: [{ unitId: 'parent', byUnitId: 'exception' }] })
    );

    expect(pack.items.map((item) => item.unitId)).toEqual(['exception']);
    expect(pack.supportingContext).toEqual([
      expect.objectContaining({
        role: 'OVERRIDDEN_PARENT_CONTEXT',
        unitId: 'parent',
        overriddenByUnitId: 'exception',
      }),
    ]);
    expect(pack.numericFacts).toEqual([]);
  });

  it('excludes a grandparent when its overrider was itself overridden', () => {
    const pack = buildEvidencePack(
      [unit({ unitId: 'grandparent' }), child('parent-exception', 'grandparent'), child('selected-exception', 'parent-exception')],
      resolution({
        selected: ['selected-exception'],
        overridden: [
          { unitId: 'grandparent', byUnitId: 'parent-exception' },
          { unitId: 'parent-exception', byUnitId: 'selected-exception' },
        ],
      })
    );
    expect(pack.supportingContext?.map((item) => item.unitId)).toEqual(['parent-exception']);
  });

  it.each([
    {
      name: 'dangling unit',
      units: [child('exception', 'missing')],
      edge: { unitId: 'missing', byUnitId: 'exception' },
    },
    {
      name: 'non-exception child',
      units: [unit({ unitId: 'parent' }), unit({ unitId: 'child', parentRuleRef: 'parent' })],
      edge: { unitId: 'parent', byUnitId: 'child' },
    },
    {
      name: 'wrong direct parent',
      units: [unit({ unitId: 'parent' }), unit({ unitId: 'other' }), child('exception', 'other')],
      edge: { unitId: 'parent', byUnitId: 'exception' },
    },
  ])('fails closed for fabricated $name edge', ({ units, edge }) => {
    expect(() => buildEvidencePack(units, resolution({ selected: [edge.byUnitId], overridden: [edge] }))).toThrow();
  });

  it('fails closed for duplicate edges', () => {
    const edge = { unitId: 'parent', byUnitId: 'exception' };
    expect(() => buildEvidencePack(
      [unit({ unitId: 'parent' }), child('exception', 'parent')],
      resolution({ selected: ['exception'], overridden: [edge, edge] })
    )).toThrow(/duplicate/);
  });

  it('fails closed instead of exposing a parent number contradicted by the selected child', () => {
    const parent = unit({
      unitId: 'parent',
      numericConstraint: { factKey: 'max_seconds', value: 10, unit: 'seconds' },
    });
    const exception = child('exception', 'parent');
    const conflictingChild = {
      ...exception,
      numericConstraint: { factKey: 'max_seconds', value: 3, unit: 'seconds' },
    } satisfies PersistedKnowledgeUnit;
    expect(() => buildEvidencePack(
      [parent, conflictingChild],
      resolution({ selected: ['exception'], overridden: [{ unitId: 'parent', byUnitId: 'exception' }] })
    )).toThrow(/selected-child precedence/);
  });
});

/**
 * Q08 postfix, Fix 3 (2026-08-11): decision-relevance's OWN rationale for why
 * a unit is relevant threaded through to synthesis, so it does not have to
 * re-derive a bridging judgement an earlier stage already made. This is
 * additive plumbing — a THIRD, optional argument to `buildEvidencePack` — not
 * a new requirement: every existing call site above (no third argument) must
 * keep behaving exactly as before.
 */
describe('buildEvidencePack — relevanceRationale (Fix 3)', () => {
  it('attaches the rationale from the map to the matching selected item', () => {
    const pack = buildEvidencePack(
      [unit()],
      resolution({ selected: ['u1'] }),
      new Map([['u1', 'Описывает прямые действия после завершения процедуры.']])
    );

    expect(pack.items[0].relevanceRationale).toBe(
      'Описывает прямые действия после завершения процедуры.'
    );
  });

  it('leaves relevanceRationale undefined when no map is passed at all — old call sites unaffected', () => {
    const pack = buildEvidencePack([unit()], resolution({ selected: ['u1'] }));

    expect(pack.items[0].relevanceRationale).toBeUndefined();
  });

  it('leaves relevanceRationale undefined for a unit absent from the map, even though the unit IS selected', () => {
    // Simulates exactly the case the classifier must fail closed on: this
    // unit reached the pack through resolution (selected), but the caller's
    // rationale map does not carry it — e.g. because its decision-relevance
    // verdict was IRRELEVANT and got filtered out upstream.
    const pack = buildEvidencePack(
      [unit()],
      resolution({ selected: ['u1'] }),
      new Map([['some-other-unit', 'не относится к u1']])
    );

    expect(pack.items[0].relevanceRationale).toBeUndefined();
  });

  it('also attaches to negativeEvidence items — the pack treats selected and negative evidence uniformly', () => {
    const negative = unit({ numericConstraint: { factKey: 'maximum', value: 3, unit: 'times' } });
    const pack = buildEvidencePack(
      [negative],
      resolution({
        selected: [],
        negativeEvidence: ['u1'],
        selectedApplicability: [{ unitId: 'u1', mode: 'NEGATIVE', presentationConditions: [] }],
      }),
      new Map([['u1', 'Условие исключения признано неактивным, но relevant к вопросу.']])
    );

    expect(pack.items).toHaveLength(1);
    expect(pack.items[0].relevanceRationale).toBe(
      'Условие исключения признано неактивным, но relevant к вопросу.'
    );
  });
});
