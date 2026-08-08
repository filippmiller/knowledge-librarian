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
    extractionRef: 'u1',
    parentExtractionRef: null,
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

describe('assignIdentity — parentExtractionRef резолвится в unitId родителя через extractionRef (preflight C, translation-djc)', () => {
  it('регрессия translation-2n9: числовое ограничение ("не более 3 дней") ссылается на unitId родителя', () => {
    const parent = unit({
      extractionRef: 'p',
      statement: 'Раздражение кожи снимают в уединённом месте.',
      sourceSpan: { anchor: 'block-A', quote: 'уединённом месте' },
    });
    const fragment = unit({
      extractionRef: 'f',
      statement: 'Не более 3 дней подряд.',
      numericConstraint: { factKey: 'максимум суток', value: 3, unit: 'сутки' },
      parentExtractionRef: 'p',
      sourceSpan: { anchor: 'block-A', quote: 'Не более 3 дней подряд' },
    });
    const result = assignIdentity([parent, fragment], new Map([['block-A', BLOCK_A]]), 'rev-1');

    expect(result.units).toHaveLength(2);
    const persistedParent = result.units.find((u) => u.statement.includes('уединённом'))!;
    const persistedFragment = result.units.find((u) => u.statement.includes('3 дней'))!;
    expect(persistedFragment.parentRuleRef).toBe(persistedParent.unitId);
  });

  it('ОСНОВНАЯ регрессия preflight C: родитель + три числовых fragment ИЗ ОДНОГО БЛОКА (общий sourceSpan.anchor, как правило 4 фикстуры) — все резолвятся в один и тот же parent unitId, ни один не DANGLING', () => {
    const RULE4_BLOCK: SourceBlockLocation = {
      anchor: 'block-rule-4',
      text: 'Давление должно оставаться слабым. Не дольше 15 секунд. Пауза не менее 30 секунд. Не более трёх циклов.',
      sectionPath: 'rule.4',
      blockStart: 0,
      blockEnd: 105,
    };
    const parent = unit({
      extractionRef: 'p',
      statement: 'Давление должно оставаться слабым.',
      sourceSpan: { anchor: 'block-rule-4', quote: 'Давление должно оставаться слабым' },
    });
    const f15 = unit({
      extractionRef: 'f15',
      statement: 'Не дольше 15 секунд.',
      numericConstraint: { factKey: 'максимум секунд непрерывного почёсывания', value: 15, unit: 'секунда' },
      parentExtractionRef: 'p',
      sourceSpan: { anchor: 'block-rule-4', quote: 'Не дольше 15 секунд' },
    });
    const f30 = unit({
      extractionRef: 'f30',
      statement: 'Пауза не менее 30 секунд.',
      numericConstraint: { factKey: 'минимум секунд паузы', value: 30, unit: 'секунда' },
      parentExtractionRef: 'p',
      sourceSpan: { anchor: 'block-rule-4', quote: 'Пауза не менее 30 секунд' },
    });
    const f3 = unit({
      extractionRef: 'f3',
      statement: 'Не более трёх циклов.',
      numericConstraint: { factKey: 'максимум циклов за эпизод', value: 3, unit: 'цикл' },
      parentExtractionRef: 'p',
      sourceSpan: { anchor: 'block-rule-4', quote: 'Не более трёх циклов' },
    });

    const result = assignIdentity(
      [parent, f15, f30, f3],
      new Map([['block-rule-4', RULE4_BLOCK]]),
      'rev-1'
    );

    expect(result.unresolvedEvidence).toEqual([]);
    expect(result.ambiguousDuplicates).toEqual([]);
    expect(result.units).toHaveLength(4);

    const persistedParent = result.units.find((u) => u.statement.includes('оставаться слабым'))!;
    const fragments = result.units.filter((u) => u.statement !== persistedParent.statement);
    expect(fragments).toHaveLength(3);
    for (const f of fragments) {
      expect(f.parentRuleRef).toBe(persistedParent.unitId);
    }
    // extractionRef/parentExtractionRef не переживают persistence — план §3
    // preflight C: "extractionRef не является persistence identity".
    for (const u of result.units) {
      expect(u).not.toHaveProperty('extractionRef');
      expect(u).not.toHaveProperty('parentExtractionRef');
    }
  });

  it('родитель ЕЩЁ не извлечён (parentExtractionRef не резолвится ни в один extractionRef этого прогона) — parentRuleRef становится null, не мусорной строкой', () => {
    const orphanFragment = unit({
      extractionRef: 'f',
      statement: 'Не более 3 дней подряд.',
      parentExtractionRef: 'p-отсутствует',
      sourceSpan: { anchor: 'block-A', quote: 'Не более 3 дней подряд' },
    });
    const result = assignIdentity([orphanFragment], new Map([['block-A', BLOCK_A]]), 'rev-1');
    expect(result.units[0].parentRuleRef).toBeNull();
  });
});

describe('assignIdentity — защита от невалидных parentExtractionRef ДАЖЕ БЕЗ validateParentRefs (P0, translation-rbj, PR #76 review)', () => {
  // В реальном пайплайне extractKnowledgeUnits() всегда прогоняет units через
  // validateParentRefs() ПЕРЕД assignIdentity(), и та уже обнуляет невалидные
  // ссылки (см. extraction-parent-refs.ts). Но assignIdentity — экспортируемая
  // функция, и ничто на уровне типов не заставляет вызывающего сначала
  // провалидировать: "структура делает нарушение невозможным", а не "вызывающий
  // обязан помнить" — поэтому эта защита дублируется здесь как ВТОРОЙ,
  // независимый слой, не полагающийся на то, что validateParentRefs уже
  // отработала.

  it('duplicate extractionRef СЫРЫМИ (validateParentRefs не вызывалась): child получает parentRuleRef=null, не произвольного (last-write-wins) родителя', () => {
    const RULE4_BLOCK: SourceBlockLocation = {
      anchor: 'block-x',
      text: 'Кандидат 1. Кандидат 2. Потомок.',
      sectionPath: 'x',
      blockStart: 0,
      blockEnd: 32,
    };
    const p1 = unit({
      extractionRef: 'parent',
      statement: 'Кандидат 1.',
      sourceSpan: { anchor: 'block-x', quote: 'Кандидат 1' },
    });
    const p2 = unit({
      extractionRef: 'parent',
      statement: 'Кандидат 2.',
      sourceSpan: { anchor: 'block-x', quote: 'Кандидат 2' },
    });
    const child = unit({
      extractionRef: 'c',
      parentExtractionRef: 'parent',
      statement: 'Потомок.',
      sourceSpan: { anchor: 'block-x', quote: 'Потомок' },
    });

    const resultAB = assignIdentity([p1, p2, child], new Map([['block-x', RULE4_BLOCK]]), 'rev-1');
    const resultBA = assignIdentity([p2, p1, child], new Map([['block-x', RULE4_BLOCK]]), 'rev-1');

    const childAB = resultAB.units.find((u) => u.statement === 'Потомок.');
    const childBA = resultBA.units.find((u) => u.statement === 'Потомок.');

    expect(childAB?.parentRuleRef).toBeNull();
    expect(childBA?.parentRuleRef).toBeNull();
  });

  it('self-reference СЫРЫМИ (validateParentRefs не вызывалась): parentRuleRef никогда не равен собственному unitId', () => {
    const selfReferential = unit({
      extractionRef: 'u1',
      parentExtractionRef: 'u1',
    });
    const result = assignIdentity([selfReferential], new Map([['block-A', BLOCK_A]]), 'rev-1');
    expect(result.units).toHaveLength(1);
    expect(result.units[0].parentRuleRef).toBeNull();
    expect(result.units[0].parentRuleRef).not.toBe(result.units[0].unitId);
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
    const differentKind = unit({ kind: 'EXCEPTION_RULE', parentExtractionRef: 'p' });
    const result = assignIdentity([unit(), differentKind], new Map([['block-A', BLOCK_A]]), 'rev-1');
    expect(result.units).toHaveLength(2);
    expect(result.ambiguousDuplicates).toHaveLength(0);
  });
});
