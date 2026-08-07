import { describe, expect, it } from 'vitest';
import { buildRetrievalText } from '../retrieval-text';
import type { PersistedKnowledgeUnit } from '../identity-assignment';

/**
 * PR G acceptance criterion (plan §3): "не более 15 секунд подряд" обязано
 * находиться вопросом "как долго можно водить пальцами" — а для этого в
 * индексируемом тексте обязан присутствовать контекст, из которого видно,
 * что речь о почёсывании. statement фрагмента сам по себе этого не несёт.
 */

const VALID_SOURCE_SPAN = { anchor: 'block-3', quote: 'не более 15 секунд подряд' };

function unit(overrides: Partial<PersistedKnowledgeUnit> = {}): PersistedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'Не более 15 секунд подряд, затем пауза минимум 30 секунд.',
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

describe('buildRetrievalText — базовые поля', () => {
  it('включает statement', () => {
    expect(buildRetrievalText(unit(), new Map())).toContain('Не более 15 секунд подряд');
  });

  it('включает title, если есть', () => {
    const text = buildRetrievalText(unit({ title: 'Продолжительность почёсывания' }), new Map());
    expect(text).toContain('Продолжительность почёсывания');
  });

  it('включает дословную цитату источника (sourceSpan.quote) — может нести слова, которых нет в абстрагированном statement', () => {
    const withRichQuote = unit({
      sourceSpan: { anchor: 'block-3', quote: 'почёсывание не более 15 секунд подряд' },
    });
    expect(buildRetrievalText(withRichQuote, new Map())).toContain('почёсывание');
  });
});

describe('buildRetrievalText — регрессия Q04: контекст родителя закрывает разрыв между фрагментом и вопросом', () => {
  it('фрагмент БЕЗ упоминания "почёсывания" в собственном statement получает его через statement родителя', () => {
    const parent = unit({
      unitId: 'parent-id',
      statement: 'Зудящий участок кожи разрешается почёсывать подушечками пальцев.',
      sourceSpan: { anchor: 'block-2', quote: 'почёсывать подушечками пальцев' },
    });
    const fragment = unit({
      unitId: 'fragment-id',
      parentRuleRef: 'parent-id',
      statement: 'Не более 15 секунд подряд, затем пауза минимум 30 секунд.',
      numericConstraint: { factKey: 'максимум секунд подряд', value: 15, unit: 'секунда' },
    });

    const unitsById = new Map([
      ['parent-id', parent],
      ['fragment-id', fragment],
    ]);

    const text = buildRetrievalText(fragment, unitsById);
    expect(text).toContain('почёсывать');
    expect(text).toContain('15 секунд');
  });

  it('unit без родителя (parentRuleRef=null) не падает и не выдумывает контекст', () => {
    expect(() => buildRetrievalText(unit(), new Map())).not.toThrow();
  });

  it('parentRuleRef ссылается на unitId, отсутствующий в переданной карте, — не падает, просто без контекста родителя', () => {
    const fragment = unit({ parentRuleRef: 'нет-такого-unitId' });
    expect(() => buildRetrievalText(fragment, new Map())).not.toThrow();
  });
});

describe('buildRetrievalText — структурные условия и facets словами, не кодами', () => {
  it('numericConstraint попадает в текст читаемо (factKey + value + unit)', () => {
    const withConstraint = unit({
      numericConstraint: { factKey: 'максимум секунд подряд', value: 15, unit: 'секунда' },
    });
    const text = buildRetrievalText(withConstraint, new Map());
    expect(text).toContain('максимум секунд подряд');
    expect(text).toContain('15');
  });

  it('triggerCondition попадает в текст через понятные слова, не как JSON', () => {
    const withTrigger = unit({
      kind: 'EXCEPTION_RULE',
      triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] },
    });
    const text = buildRetrievalText(withTrigger, new Map());
    expect(text).not.toContain('{');
    expect(text.length).toBeGreaterThan(0);
  });

  it('service facet попадает МЕТКОЙ из SERVICE_CONCEPTS ("Апостиль в СПб"), не сырым кодом', () => {
    const withService = unit({
      kind: 'PRICE_RULE',
      facets: { scenario: 'apostille.zags.spb', service: 'apostille_spb' },
    });
    const text = buildRetrievalText(withService, new Map());
    expect(text).toContain('Апостиль в СПб');
  });
});
