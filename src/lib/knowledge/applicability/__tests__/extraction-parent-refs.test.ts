import { describe, expect, it } from 'vitest';
import { validateParentRefs } from '../extraction-parent-refs';
import type { ExtractedKnowledgeUnit } from '../extraction';

/**
 * Регрессия на реальный баг (translation-2n9, синтетический прогон
 * 2026-08-05): "не более 3 дней" оторвалось от "раздражение кожи", к которому
 * относилось. Здесь — структурная гарантия: parentRuleRef, не разрешившийся
 * ни в один известный анкер документа, ни в sourceSpan другого unit'а этого же
 * прогона, не теряется молча — он остаётся на месте (для аудита) и
 * сопровождается явной uncertainty, а не тихо считается валидным или тихо
 * обнуляется.
 */

function unit(overrides: Partial<ExtractedKnowledgeUnit> = {}): ExtractedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'Раздражение кожи в уединённом месте.',
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    parentRuleRef: null,
    sourceSpan: { anchor: 'block-A', quote: 'раздражение кожи' },
    evidenceByField: {},
    uncertainties: [],
    ...overrides,
  };
}

describe('validateParentRefs', () => {
  it('parentRuleRef === null проходит без изменений', () => {
    const units = [unit()];
    expect(validateParentRefs(units, ['block-A'])).toEqual(units);
  });

  it('parentRuleRef, указывающий на исходный анкер документа, — валиден, uncertainty не добавляется', () => {
    const fragment = unit({
      statement: 'Не более 3 дней подряд.',
      numericConstraint: { factKey: 'максимум суток непрерывного раздражения', value: 3, unit: 'сутки' },
      parentRuleRef: 'block-A',
      sourceSpan: { anchor: 'block-B', quote: 'не более 3 дней подряд' },
    });
    const [, resultFragment] = validateParentRefs([unit(), fragment], ['block-A', 'block-B']);
    expect(resultFragment.uncertainties).toEqual([]);
  });

  it('parentRuleRef, указывающий на sourceSpan.anchor ДРУГОГО unit\'а этого же прогона, — валиден', () => {
    const parent = unit({ sourceSpan: { anchor: 'block-A', quote: 'раздражение кожи' } });
    const fragment = unit({
      statement: 'Не более 3 дней подряд.',
      parentRuleRef: 'block-A',
      sourceSpan: { anchor: 'block-A-numeric', quote: 'не более 3 дней подряд' },
    });
    const [, resultFragment] = validateParentRefs([parent, fragment], ['block-A']);
    expect(resultFragment.uncertainties).toEqual([]);
  });

  it('parentRuleRef, не разрешившийся НИ во что, — это ровно исторический баг: остаётся на месте + явная uncertainty', () => {
    const orphan = unit({
      statement: 'Не более 3 дней подряд.',
      numericConstraint: { factKey: 'максимум суток непрерывного раздражения', value: 3, unit: 'сутки' },
      // Эфемерная метка прогона вроде "R-17" — ровно то, что запрещает
      // acceptance criterion, и ровно то, что случилось в реальном баге.
      parentRuleRef: 'R-17-несуществующий-якорь',
      sourceSpan: { anchor: 'block-B', quote: 'не более 3 дней подряд' },
    });
    const [result] = validateParentRefs([orphan], ['block-A', 'block-B']);
    // Значение НЕ теряется — сохранено для ручного ревью (F).
    expect(result.parentRuleRef).toBe('R-17-несуществующий-якорь');
    expect(result.uncertainties).toEqual([
      {
        kind: 'DANGLING_PARENT_REF',
        description: expect.stringContaining('R-17-несуществующий-якорь'),
        quote: 'не более 3 дней подряд',
      },
    ]);
  });

  it('unit, сославшийся на СВОЙ СОБСТВЕННЫЙ anchor как на родителя, — не валидный parent, а самопротиворечие', () => {
    const selfReferential = unit({
      parentRuleRef: 'block-A',
      sourceSpan: { anchor: 'block-A', quote: 'раздражение кожи' },
    });
    const [result] = validateParentRefs([selfReferential], ['block-A']);
    expect(result.uncertainties).toEqual([
      expect.objectContaining({ kind: 'DANGLING_PARENT_REF' }),
    ]);
  });

  it('существующие uncertainties сохраняются, новая добавляется, а не заменяет их', () => {
    const orphan = unit({
      parentRuleRef: 'нигде-нет',
      uncertainties: [{ kind: 'OTHER', description: 'предыдущая находка', quote: 'x' }],
    });
    const [result] = validateParentRefs([orphan], []);
    expect(result.uncertainties).toHaveLength(2);
    expect(result.uncertainties[0]).toMatchObject({ kind: 'OTHER' });
    expect(result.uncertainties[1]).toMatchObject({ kind: 'DANGLING_PARENT_REF' });
  });
});
