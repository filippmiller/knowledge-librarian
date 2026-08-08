import { describe, expect, it } from 'vitest';
import { assignIdentity, type SourceBlockLocation } from '../identity-assignment';
import type { ExtractedKnowledgeUnit } from '../extraction';

/**
 * PR F acceptance criteria — regression на unitId-стабильность и на
 * ambiguous-duplicate: "два unit'а с одинаковыми kind + evidence span —
 * ambiguous duplicate, требует review; им НЕ назначается случайный
 * LLM-ordinal, чтобы 'развести' их".
 */

const BLOCK_A: SourceBlockLocation = {
  anchor: 'block-A',
  text: 'Раздражение кожи снимают в уединённом месте. Не более 3 дней подряд.',
  sectionPath: 'section.1',
  blockStart: 1000,
  blockEnd: 1070,
};

function unit(overrides: Partial<ExtractedKnowledgeUnit> = {}): ExtractedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'Раздражение кожи снимают в уединённом месте.',
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    parentRuleRef: null,
    sourceSpan: { anchor: 'block-A', quote: 'уединённом месте' },
    evidenceByField: { statement: { anchor: 'block-A', quote: 'уединённом месте' } },
    uncertainties: [],
    ...overrides,
  };
}

describe('assignIdentity — unitId стабилен между прогонами при перефразировке', () => {
  it('регрессия acceptance criterion: тот же anchor + span + kind, другой statement -> тот же unitId, другой contentHash', () => {
    const run1 = assignIdentity([unit()], new Map([['block-A', BLOCK_A]]), 'rev-1');
    const run2 = assignIdentity(
      [unit({ statement: 'Снимать раздражение следует в уединении.' })],
      new Map([['block-A', BLOCK_A]]),
      'rev-1'
    );

    expect(run1.units).toHaveLength(1);
    expect(run2.units).toHaveLength(1);
    expect(run2.units[0].unitId).toBe(run1.units[0].unitId);
    expect(run2.units[0].contentHash).not.toBe(run1.units[0].contentHash);
  });

  it('sourceBlockAnchor приходит из sectionPath/blockStart/blockEnd блока, не из caller-метки unit.sourceSpan.anchor', () => {
    const result = assignIdentity([unit()], new Map([['block-A', BLOCK_A]]), 'rev-1');
    expect(result.units[0].sourceBlockAnchor).not.toBe('block-A');
    expect(result.units[0].sourceBlockAnchor).toHaveLength(16);
  });
});

describe('assignIdentity — evidence не резолвится дословно', () => {
  it('quote, которого нет в тексте блока, — unit уходит в unresolvedEvidence, не в units', () => {
    const result = assignIdentity(
      [unit({ sourceSpan: { anchor: 'block-A', quote: 'этого текста нет в блоке' } })],
      new Map([['block-A', BLOCK_A]]),
      'rev-1'
    );
    expect(result.units).toHaveLength(0);
    expect(result.unresolvedEvidence).toHaveLength(1);
  });

  it('anchor, которого нет среди известных блоков, — тоже unresolvedEvidence', () => {
    const result = assignIdentity(
      [unit({ sourceSpan: { anchor: 'block-ЧУЖОЙ', quote: 'уединённом месте' } })],
      new Map([['block-A', BLOCK_A]]),
      'rev-1'
    );
    expect(result.units).toHaveLength(0);
    expect(result.unresolvedEvidence).toHaveLength(1);
  });
});

describe('assignIdentity — parentRuleRef резолвится в unitId родителя, когда родитель тоже извлечён', () => {
  it('регрессия translation-2n9: числовое ограничение ("не более 3 дней") ссылается на unitId родителя, а не на сырой anchor', () => {
    const parent = unit({
      statement: 'Раздражение кожи снимают в уединённом месте.',
      sourceSpan: { anchor: 'block-A', quote: 'уединённом месте' },
    });
    const fragment = unit({
      statement: 'Не более 3 дней подряд.',
      numericConstraint: { factKey: 'максимум суток', value: 3, unit: 'сутки' },
      parentRuleRef: 'block-A', // ссылка на E-уровне — сырой anchor
      sourceSpan: { anchor: 'block-A', quote: 'Не более 3 дней подряд' },
    });
    const result = assignIdentity([parent, fragment], new Map([['block-A', BLOCK_A]]), 'rev-1');

    expect(result.units).toHaveLength(2);
    const persistedParent = result.units.find((u) => u.statement.includes('уединённом'))!;
    const persistedFragment = result.units.find((u) => u.statement.includes('3 дней'))!;
    expect(persistedFragment.parentRuleRef).toBe(persistedParent.unitId);
  });

  it('родитель ЕЩЁ не извлечён (только документный anchor) — parentRuleRef остаётся сырым anchor, как и предписывает план', () => {
    const orphanFragment = unit({
      statement: 'Не более 3 дней подряд.',
      parentRuleRef: 'block-A',
      sourceSpan: { anchor: 'block-A', quote: 'Не более 3 дней подряд' },
    });
    const result = assignIdentity([orphanFragment], new Map([['block-A', BLOCK_A]]), 'rev-1');
    expect(result.units[0].parentRuleRef).toBe('block-A');
  });

  it('несколько unit\'ов делят anchor родителя (неоднозначно, кто именно родитель) — parentRuleRef НЕ резолвится, остаётся сырым', () => {
    const candidate1 = unit({
      statement: 'Кандидат 1.',
      sourceSpan: { anchor: 'block-A', quote: 'уединённом месте' },
    });
    const candidate2 = unit({
      statement: 'Кандидат 2.',
      sourceSpan: { anchor: 'block-A', quote: 'Не более 3 дней подряд' },
    });
    const fragment = unit({
      statement: 'Фрагмент.',
      parentRuleRef: 'block-A',
      sourceSpan: { anchor: 'block-A', quote: 'Раздражение кожи' },
    });
    // Три РАЗНЫХ evidence span на одном anchor — ни один unitId не
    // схлопывается (не ambiguous duplicate); проверяем именно
    // множественность anchor-претендентов на роль родителя.
    const result = assignIdentity(
      [candidate1, candidate2, fragment],
      new Map([['block-A', BLOCK_A]]),
      'rev-1'
    );
    const persistedFragment = result.units.find((u) => u.statement === 'Фрагмент.');
    expect(persistedFragment?.parentRuleRef).toBe('block-A');
  });
});

describe('assignIdentity — ambiguous duplicate: одинаковый kind + evidence span', () => {
  it('два unit\'а, схлопнувшиеся в один unitId, — оба уходят в ambiguousDuplicates, ни один не получает случайный ordinal', () => {
    const first = unit({ statement: 'Формулировка А.' });
    const second = unit({ statement: 'Формулировка Б.' }); // тот же kind + тот же evidence span
    const result = assignIdentity([first, second], new Map([['block-A', BLOCK_A]]), 'rev-1');

    expect(result.units).toHaveLength(0);
    expect(result.ambiguousDuplicates).toHaveLength(1);
    expect(result.ambiguousDuplicates[0].unitId).toBe(
      assignIdentity([first], new Map([['block-A', BLOCK_A]]), 'rev-1').units[0].unitId
    );
    expect(result.ambiguousDuplicates[0].units).toHaveLength(2);
  });

  it('разный evidence span (та же фраза встретилась бы дважды) — НЕ дубликат, оба проходят', () => {
    const withSecondSpan = unit({
      statement: 'Другое правило.',
      sourceSpan: { anchor: 'block-A', quote: 'Не более 3 дней подряд' },
    });
    const result = assignIdentity([unit(), withSecondSpan], new Map([['block-A', BLOCK_A]]), 'rev-1');
    expect(result.units).toHaveLength(2);
    expect(result.ambiguousDuplicates).toHaveLength(0);
  });

  it('разный kind на том же evidence span — НЕ дубликат (unitId включает kind)', () => {
    const differentKind = unit({ kind: 'EXCEPTION_RULE', parentRuleRef: 'p' });
    const result = assignIdentity([unit(), differentKind], new Map([['block-A', BLOCK_A]]), 'rev-1');
    expect(result.units).toHaveLength(2);
    expect(result.ambiguousDuplicates).toHaveLength(0);
  });
});
