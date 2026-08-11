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

describe('buildRetrievalText — полнота: facets БЕЗ ConceptVocabulary (scenario, documentForm) не теряются (pre-retrieval hardening, Step 4)', () => {
  it('scenario — единственный семантический контекст statement — сохраняется в retrievalText человекочитаемой меткой (регрессия: facetsText молча пропускает facet без ConceptVocabulary)', () => {
    const genericUnit = unit({
      statement: 'Требуется оригинал документа.',
      facets: { scenario: 'apostille.zags.spb' },
    });
    const text = buildRetrievalText(genericUnit, new Map());
    expect(text).toContain('Апостиль в КЗАГС Санкт-Петербурга');
  });

  it('documentForm попадает в retrievalText читаемым словом, не кодом ORIGINAL/SCAN/COPY', () => {
    const text = buildRetrievalText(unit({ facets: { documentForm: 'SCAN' } }), new Map());
    expect(text).toContain('скан');
    expect(text).not.toContain('SCAN');
  });

  it('неизвестный scenario key — не падает, просто без метки (защита от рассинхронизации с реестром)', () => {
    expect(() => buildRetrievalText(unit({ facets: { scenario: 'нет-такого-сценария' } }), new Map())).not.toThrow();
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

describe('buildRetrievalText — Fix 2 (2026-08-11): контекст соседей по sourceBlockAnchor, когда общего родителя больше нет', () => {
  /**
   * Точная форма реального регресса (goal-shift benchmark): пять units
   * "правила 4" (лимит непрерывного почёсывания / пауза между циклами /
   * лимит циклов за эпизод) раньше были детьми ВЫДУМАННОГО родителя, чей
   * statement `buildRetrievalText` инъецировал в каждого ребёнка. Дисциплина
   * новой экстракции перестала выдумывать такого родителя (`parentRuleRef`
   * этих пяти units — `null`), и вместе с ним пропал единственный источник
   * контекста, связывающего "лимит 15 секунд" с "почёсыванием" как таковым.
   * Данные ниже — ДОСЛОВНО из `scripts/fixtures/semantic-rule-extraction-
   * test-pack/frozen-extraction/extraction-artifact.json`, unitId'ы и
   * `sourceBlockAnchor: 'd9e946dfcdcb3d2a'` подтверждены перед кодированием
   * (все 5 units этого блока делят этот анкор, `parentRuleRef: null` у всех).
   */
  const ANCHOR = 'd9e946dfcdcb3d2a';

  const pressureUnit = unit({
    unitId: '0b046081cc537a39',
    statement: 'Давление во время почёсывания должно оставаться слабым и не оставлять следов на коже/поверхности.',
    sourceBlockAnchor: ANCHOR,
    sourceSpan: { anchor: 'b8', quote: 'Давление должно оставаться слабым и не оставлять следов.' },
  });
  const fifteenSecondUnit = unit({
    unitId: 'b722091ca8e373e6',
    statement: 'Непрерывное почёсывание допускается вести не дольше установленного лимита времени, прежде чем сделать паузу.',
    numericConstraint: { factKey: 'продолжительность непрерывного почёсывания', value: 15, unit: 'seconds' },
    sourceBlockAnchor: ANCHOR,
    sourceSpan: { anchor: 'b8', quote: 'Непрерывное почёсывание допускается не дольше 15 секунд' },
  });
  const pauseUnit = unit({
    unitId: '9d27f1e2ad2f0378',
    statement: 'После окончания непрерывного почёсывания требуется сделать паузу минимальной длительности, прежде чем продолжать.',
    numericConstraint: { factKey: 'минимальная длительность паузы между циклами почёсывания', value: 30, unit: 'seconds' },
    sourceBlockAnchor: ANCHOR,
    sourceSpan: { anchor: 'b8', quote: 'после чего требуется пауза не менее 30 секунд' },
  });
  const cycleCapUnit = unit({
    unitId: '3e1de43a83fd230f',
    statement: 'В рамках одного эпизода разрешено выполнить ограниченное число циклов почёсывания (цикл почёсывания + пауза).',
    numericConstraint: { factKey: 'максимальное количество циклов почёсывания за один эпизод', value: 3, unit: 'cycles' },
    sourceBlockAnchor: ANCHOR,
    sourceSpan: { anchor: 'b8', quote: 'За один эпизод разрешено не более трёх таких циклов' },
  });
  const noOverrideUnit = unit({
    unitId: 'b3bfb5117f87274a',
    statement: 'Ограничение по количеству циклов и их длительности не отменяется даже при наличии желания продолжить почёсывание сверх установленного лимита.',
    sourceBlockAnchor: ANCHOR,
    sourceSpan: { anchor: 'b8', quote: 'желание продолжить не отменяет ограничение' },
  });

  const unitsById = new Map(
    [pressureUnit, fifteenSecondUnit, pauseUnit, cycleCapUnit, noOverrideUnit].map((u) => [u.unitId, u])
  );

  it('15-секундный фрагмент получает контекст всех 4 соседей по блоку (родителя больше нет)', () => {
    const text = buildRetrievalText(fifteenSecondUnit, unitsById);

    expect(text).toContain('Давление во время почёсывания должно оставаться слабым');
    expect(text).toContain('ограниченное число циклов почёсывания');
    expect(text).toContain('требуется сделать паузу минимальной длительности');
    expect(text).toContain('желание продолжить почёсывание сверх установленного лимита');
    // Собственные данные (число из structured-поля и дословная цитата) не
    // теряются — они и раньше не зависели от родителя.
    expect(text).toContain('15 секунд');
    expect(text).toContain('15 seconds');
  });

  it('не задваивает собственный statement фрагмента', () => {
    const text = buildRetrievalText(fifteenSecondUnit, unitsById);
    const ownStatement =
      'Непрерывное почёсывание допускается вести не дольше установленного лимита времени, прежде чем сделать паузу.';
    expect(text.split(ownStatement).length - 1).toBe(1);
  });

  it('детерминирован: повторный вызов и другой порядок вставки в unitsById дают тот же текст', () => {
    const first = buildRetrievalText(fifteenSecondUnit, unitsById);
    const second = buildRetrievalText(fifteenSecondUnit, unitsById);
    expect(first).toBe(second);

    const reorderedMap = new Map(
      [noOverrideUnit, cycleCapUnit, pauseUnit, fifteenSecondUnit, pressureUnit].map((u) => [u.unitId, u])
    );
    expect(buildRetrievalText(fifteenSecondUnit, reorderedMap)).toBe(first);
  });

  it('граница соблюдена: шестой сосед сверх реальной пятёрки не растягивает текст', () => {
    // unitId нарочно лексикографически ПОСЛЕДНИЙ ('z' > любой hex-символ 0-9/a-f)
    // — граница (сортировка по unitId, первые 4) должна отсечь именно его, а
    // не один из 4 настоящих соседей блока.
    const extraSibling = unit({
      unitId: 'zzzzzzzzzzzzzzzz',
      statement: 'Совершенно отдельное по смыслу примечание, добавленное шестым в тот же блок.',
      sourceBlockAnchor: ANCHOR,
    });
    const biggerMap = new Map(unitsById);
    biggerMap.set(extraSibling.unitId, extraSibling);

    const text = buildRetrievalText(fifteenSecondUnit, biggerMap);

    expect(text).not.toContain('Совершенно отдельное по смыслу примечание');
    expect(text).toContain('Давление во время почёсывания должно оставаться слабым');
    expect(text).toContain('ограниченное число циклов почёсывания');
    expect(text).toContain('требуется сделать паузу минимальной длительности');
    expect(text).toContain('желание продолжить почёсывание сверх установленного лимита');
  });
});

describe('buildRetrievalText — Fix 2: сосуществует с цепочкой parentRuleRef, не задваивает родителя', () => {
  it('когда родитель есть И сосед по блоку тоже есть — оба контекста добавляются, родитель не задвоен', () => {
    const ANCHOR = 'shared-block';
    const parent = unit({
      unitId: 'parent-id',
      statement: 'Зудящий участок кожи разрешается почёсывать подушечками пальцев.',
      sourceSpan: { anchor: 'block-2', quote: 'почёсывать подушечками пальцев' },
      sourceBlockAnchor: ANCHOR,
    });
    const fragment = unit({
      unitId: 'fragment-id',
      parentRuleRef: 'parent-id',
      statement: 'Не более 15 секунд подряд, затем пауза минимум 30 секунд.',
      numericConstraint: { factKey: 'максимум секунд подряд', value: 15, unit: 'секунда' },
      sourceBlockAnchor: ANCHOR,
    });
    const otherSibling = unit({
      unitId: 'sibling-id',
      statement: 'Дополнительное уточнение про положение руки во время почёсывания.',
      sourceBlockAnchor: ANCHOR,
    });

    const unitsById = new Map([parent, fragment, otherSibling].map((u) => [u.unitId, u]));

    const text = buildRetrievalText(fragment, unitsById);

    // Существующее поведение цепочки родителя (регрессия Q04) не сломано.
    expect(text).toContain('почёсывать подушечками пальцев');
    expect(text).toContain('15 секунд');
    // Новое: контекст соседа по блоку (НЕ родителя) тоже присутствует.
    expect(text).toContain('положение руки во время почёсывания');
    // Родитель не задвоен, хотя формально он тоже «сосед по блоку».
    const parentStatement = 'Зудящий участок кожи разрешается почёсывать подушечками пальцев.';
    expect(text.split(parentStatement).length - 1).toBe(1);
  });

  it('unitsById без соседей (только родитель резолвится) — ведёт себя ровно как до Fix 2', () => {
    const parent = unit({
      unitId: 'parent-id',
      statement: 'Зудящий участок кожи разрешается почёсывать подушечками пальцев.',
      sourceSpan: { anchor: 'block-2', quote: 'почёсывать подушечками пальцев' },
      sourceBlockAnchor: 'parent-block',
    });
    const fragment = unit({
      unitId: 'fragment-id',
      parentRuleRef: 'parent-id',
      statement: 'Не более 15 секунд подряд, затем пауза минимум 30 секунд.',
      sourceBlockAnchor: 'fragment-block',
    });
    const unitsById = new Map([parent, fragment].map((u) => [u.unitId, u]));

    const text = buildRetrievalText(fragment, unitsById);

    expect(text).toContain('почёсывать подушечками пальцев');
    expect(text).toContain('15 секунд');
  });
});
