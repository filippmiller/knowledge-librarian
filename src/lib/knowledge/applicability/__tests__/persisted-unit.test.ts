import { describe, expect, it } from 'vitest';
import { persistedKnowledgeUnitSchema } from '../persisted-unit';

const VALID_SOURCE_SPAN = { anchor: 'block-3', quote: 'не более 3 дней подряд' };

function validPersistedUnit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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

describe('persistedKnowledgeUnitSchema — ExtractedKnowledgeUnit + три ID', () => {
  it('валидный persisted unit проходит', () => {
    expect(persistedKnowledgeUnitSchema.safeParse(validPersistedUnit()).success).toBe(true);
  });

  it('наследует проверки ExtractedKnowledgeUnit — пустой statement всё ещё отвергается', () => {
    expect(
      persistedKnowledgeUnitSchema.safeParse(validPersistedUnit({ statement: '   ' })).success
    ).toBe(false);
  });

  it.each(['sourceBlockAnchor', 'unitId', 'contentHash'])('пустой %s отвергается', (field) => {
    expect(
      persistedKnowledgeUnitSchema.safeParse(validPersistedUnit({ [field]: '' })).success
    ).toBe(false);
  });

  it('без одного из трёх ID-полей — отвергается (не опциональны)', () => {
    const { unitId: _drop, ...withoutUnitId } = validPersistedUnit();
    expect(persistedKnowledgeUnitSchema.safeParse(withoutUnitId).success).toBe(false);
  });
});
