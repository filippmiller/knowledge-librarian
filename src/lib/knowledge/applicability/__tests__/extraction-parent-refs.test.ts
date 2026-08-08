import { describe, expect, it } from 'vitest';
import { validateParentRefs } from '../extraction-parent-refs';
import type { ExtractedKnowledgeUnit } from '../extraction';

/**
 * Preflight C (translation-djc, независимое ревью, план продолжения сессии
 * Aurora v2). Заменяет старую модель на `sourceSpan.anchor`: anchor называет
 * МЕСТО в документе, а не unit — при фрагментации ОДНОГО абзаца (реальный
 * случай правила 4 фикстуры: родитель + "15 секунд" + "30 секунд" + "3
 * цикла") у всех единиц ОДИН И ТОТ ЖЕ anchor, и anchor-ссылка физически не
 * может сказать, какой из НЕСКОЛЬКИХ unit'ов на этом anchor — родитель;
 * старый код либо принимал это за self-reference, либо (в identity-assignment)
 * не мог разрешить >1 кандидата.
 *
 * `extractionRef` — локальный уникальный ID unit'а В ПРЕДЕЛАХ ОДНОГО ответа
 * модели; `parentExtractionRef` ссылается на него, не на anchor.
 */

function unit(overrides: Partial<ExtractedKnowledgeUnit> = {}): ExtractedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'Раздражение кожи в уединённом месте.',
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    extractionRef: 'u1',
    parentExtractionRef: null,
    sourceSpan: { anchor: 'block-A', quote: 'раздражение кожи' },
    evidenceByField: {},
    uncertainties: [],
    ...overrides,
  };
}

describe('validateParentRefs — базовые случаи', () => {
  it('parentExtractionRef === null проходит без изменений', () => {
    const units = [unit()];
    expect(validateParentRefs(units)).toEqual(units);
  });

  it('parentExtractionRef, указывающий на extractionRef ДРУГОГО unit\'а этого же ответа, — валиден', () => {
    const parent = unit({ extractionRef: 'u1' });
    const fragment = unit({
      extractionRef: 'u2',
      statement: 'Не более 3 дней подряд.',
      parentExtractionRef: 'u1',
      sourceSpan: { anchor: 'block-A', quote: 'не более 3 дней подряд' },
    });
    const [, resultFragment] = validateParentRefs([parent, fragment]);
    expect(resultFragment.uncertainties).toEqual([]);
  });
});

describe('validateParentRefs — ОСНОВНОЙ regression: несколько units делят один sourceSpan.anchor (правило 4)', () => {
  it('родитель + три числовых fragment из ОДНОГО абзаца — все резолвятся однозначно, ни один не считается self-reference', () => {
    const SHARED_ANCHOR = 'block-rule-4';
    const parent = unit({
      extractionRef: 'u1',
      statement: 'Давление должно оставаться слабым.',
      sourceSpan: { anchor: SHARED_ANCHOR, quote: 'Давление должно оставаться слабым' },
    });
    const f15 = unit({
      extractionRef: 'u2',
      statement: 'Не дольше 15 секунд.',
      numericConstraint: { factKey: 'максимум секунд непрерывного почёсывания', value: 15, unit: 'секунда' },
      parentExtractionRef: 'u1',
      sourceSpan: { anchor: SHARED_ANCHOR, quote: 'не дольше 15 секунд' },
    });
    const f30 = unit({
      extractionRef: 'u3',
      statement: 'Пауза не менее 30 секунд.',
      numericConstraint: { factKey: 'минимум секунд паузы', value: 30, unit: 'секунда' },
      parentExtractionRef: 'u1',
      sourceSpan: { anchor: SHARED_ANCHOR, quote: 'пауза не менее 30 секунд' },
    });
    const f3 = unit({
      extractionRef: 'u4',
      statement: 'Не более трёх циклов.',
      numericConstraint: { factKey: 'максимум циклов за эпизод', value: 3, unit: 'цикл' },
      parentExtractionRef: 'u1',
      sourceSpan: { anchor: SHARED_ANCHOR, quote: 'не более трёх таких циклов' },
    });

    const result = validateParentRefs([parent, f15, f30, f3]);

    // Ни один unit не получил DANGLING_PARENT_REF — старая модель на anchor
    // здесь ломалась (все четыре делят anchor => "самоссылка").
    for (const u of result) {
      expect(u.uncertainties).toEqual([]);
    }
    expect(result.map((u) => u.parentExtractionRef)).toEqual([null, 'u1', 'u1', 'u1']);
  });
});

describe('validateParentRefs — самоссылка (extractionRef === parentExtractionRef)', () => {
  it('unit, сославшийся на СВОЙ СОБСТВЕННЫЙ extractionRef, — не валидный parent, а самопротиворечие', () => {
    const selfReferential = unit({ extractionRef: 'u1', parentExtractionRef: 'u1' });
    const [result] = validateParentRefs([selfReferential]);
    expect(result.uncertainties).toEqual([
      expect.objectContaining({ kind: 'DANGLING_PARENT_REF' }),
    ]);
  });

  it('самоссылка легальна для ДРУГОГО unit\'а на том же anchor (регрессия: anchor-based self-reference путал эти два случая)', () => {
    const SHARED_ANCHOR = 'block-A';
    const parent = unit({ extractionRef: 'u1', sourceSpan: { anchor: SHARED_ANCHOR, quote: 'X' } });
    const selfReferential = unit({
      extractionRef: 'u2',
      parentExtractionRef: 'u2',
      sourceSpan: { anchor: SHARED_ANCHOR, quote: 'Y' },
    });
    const [resultParent, resultSelf] = validateParentRefs([parent, selfReferential]);
    expect(resultParent.uncertainties).toEqual([]);
    expect(resultSelf.uncertainties).toEqual([
      expect.objectContaining({ kind: 'DANGLING_PARENT_REF' }),
    ]);
  });
});

describe('validateParentRefs — parentExtractionRef, не разрешившийся ни во что', () => {
  it('ссылка на несуществующий extractionRef — не теряется молча: остаётся на месте + явная uncertainty', () => {
    const orphan = unit({
      extractionRef: 'u1',
      statement: 'Не более 3 дней подряд.',
      parentExtractionRef: 'R-17-несуществующий',
      sourceSpan: { anchor: 'block-B', quote: 'не более 3 дней подряд' },
    });
    const [result] = validateParentRefs([orphan]);
    expect(result.parentExtractionRef).toBe('R-17-несуществующий');
    expect(result.uncertainties).toEqual([
      {
        kind: 'DANGLING_PARENT_REF',
        description: expect.stringContaining('R-17-несуществующий'),
        quote: 'не более 3 дней подряд',
      },
    ]);
  });
});

describe('validateParentRefs — циклы', () => {
  it('A -> B -> A — оба участника цикла получают DANGLING_PARENT_REF', () => {
    const a = unit({ extractionRef: 'a', parentExtractionRef: 'b', sourceSpan: { anchor: 'x', quote: 'A' } });
    const b = unit({ extractionRef: 'b', parentExtractionRef: 'a', sourceSpan: { anchor: 'x', quote: 'B' } });
    const [resultA, resultB] = validateParentRefs([a, b]);
    expect(resultA.uncertainties).toEqual([expect.objectContaining({ kind: 'DANGLING_PARENT_REF' })]);
    expect(resultB.uncertainties).toEqual([expect.objectContaining({ kind: 'DANGLING_PARENT_REF' })]);
  });

  it('A -> B -> C -> A — цикл длиной 3 тоже обнаруживается', () => {
    const a = unit({ extractionRef: 'a', parentExtractionRef: 'c', sourceSpan: { anchor: 'x', quote: 'A' } });
    const b = unit({ extractionRef: 'b', parentExtractionRef: 'a', sourceSpan: { anchor: 'x', quote: 'B' } });
    const c = unit({ extractionRef: 'c', parentExtractionRef: 'b', sourceSpan: { anchor: 'x', quote: 'C' } });
    const result = validateParentRefs([a, b, c]);
    for (const u of result) {
      expect(u.uncertainties).toEqual([expect.objectContaining({ kind: 'DANGLING_PARENT_REF' })]);
    }
  });

  it('длинная НЕциклическая цепочка (A -> B -> C -> null) НЕ считается циклом', () => {
    const a = unit({ extractionRef: 'a', parentExtractionRef: 'b', sourceSpan: { anchor: 'x', quote: 'A' } });
    const b = unit({ extractionRef: 'b', parentExtractionRef: 'c', sourceSpan: { anchor: 'x', quote: 'B' } });
    const c = unit({ extractionRef: 'c', parentExtractionRef: null, sourceSpan: { anchor: 'x', quote: 'C' } });
    const result = validateParentRefs([a, b, c]);
    for (const u of result) {
      expect(u.uncertainties).toEqual([]);
    }
  });
});

describe('validateParentRefs — уникальность extractionRef', () => {
  it('два unit\'а с одинаковым extractionRef — оба получают DUPLICATE_EXTRACTION_REF, значение не теряется', () => {
    const first = unit({ extractionRef: 'dup', statement: 'Первый.' });
    const second = unit({ extractionRef: 'dup', statement: 'Второй.' });
    const [resultFirst, resultSecond] = validateParentRefs([first, second]);
    expect(resultFirst.extractionRef).toBe('dup');
    expect(resultSecond.extractionRef).toBe('dup');
    expect(resultFirst.uncertainties).toEqual([
      expect.objectContaining({ kind: 'DUPLICATE_EXTRACTION_REF' }),
    ]);
    expect(resultSecond.uncertainties).toEqual([
      expect.objectContaining({ kind: 'DUPLICATE_EXTRACTION_REF' }),
    ]);
  });

  it('уникальные extractionRef не получают DUPLICATE_EXTRACTION_REF', () => {
    const result = validateParentRefs([unit({ extractionRef: 'u1' }), unit({ extractionRef: 'u2' })]);
    expect(result.every((u) => u.uncertainties.length === 0)).toBe(true);
  });
});

describe('validateParentRefs — существующие uncertainties сохраняются', () => {
  it('новая uncertainty добавляется, а не заменяет предыдущие', () => {
    const orphan = unit({
      extractionRef: 'u1',
      parentExtractionRef: 'нигде-нет',
      uncertainties: [{ kind: 'OTHER', description: 'предыдущая находка', quote: 'x' }],
    });
    const [result] = validateParentRefs([orphan]);
    expect(result.uncertainties).toHaveLength(2);
    expect(result.uncertainties[0]).toMatchObject({ kind: 'OTHER' });
    expect(result.uncertainties[1]).toMatchObject({ kind: 'DANGLING_PARENT_REF' });
  });
});
