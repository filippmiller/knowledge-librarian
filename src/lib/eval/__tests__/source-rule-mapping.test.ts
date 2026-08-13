import { describe, expect, it } from 'vitest';
import { resolveSourceRuleId } from '../source-rule-mapping';
import type { SourceRule } from '../source-rule-segmentation';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';

/**
 * Task 15 (benchmark grading) needs "unit -> source rule number" without a
 * committed review manifest (the evaluation path has no human review, so
 * review-manifest.ts's sourceRuleByUnitId doesn't exist here). Matching is
 * by DOCX text containment — the same class of evidence-grounded matching
 * `resolveEvidenceOffsets` already uses, never derived from the oracle.
 */

const span = (anchor: string, quote: string) => ({ anchor, quote });

function unit(overrides: Partial<PersistedKnowledgeUnit> = {}): PersistedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'заполнитель',
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    parentRuleRef: null,
    sourceSpan: span('anchor-1', 'заполнитель'),
    evidenceByField: { statement: span('anchor-1', 'заполнитель') },
    uncertainties: [],
    sourceBlockAnchor: 'block-1',
    unitId: 'u1',
    contentHash: 'hash-1',
    ...overrides,
  };
}

const RULES: SourceRule[] = [
  { sourceRuleId: 3, title: 'Допустимая техника', text: '3. Допустимая техника. Почесание выполняют подушечками двух или трёх пальцев.', paragraphIndex: 5 },
  { sourceRuleId: 9, title: 'Помощь другого человека', text: '9. Помощь другого человека. Другой человек может выполнить почесание только после ясного согласия того, кому помогают.', paragraphIndex: 12 },
];

describe('resolveSourceRuleId', () => {
  it('quote — подстрока текста ровно одного правила -> его sourceRuleId', () => {
    const result = resolveSourceRuleId(unit({ sourceSpan: span('a', 'подушечками двух или трёх пальцев') }), RULES);
    expect(result).toBe(3);
  });

  it('quote не встречается ни в одном правиле -> null (не гадаем)', () => {
    const result = resolveSourceRuleId(unit({ sourceSpan: span('a', 'этой фразы нет нигде') }), RULES);
    expect(result).toBeNull();
  });

  it('quote — подстрока ДВУХ разных правил (искусственно) -> null, неоднозначность не резолвится угадыванием', () => {
    const ambiguousRules: SourceRule[] = [
      { sourceRuleId: 1, title: 'A', text: 'общая фраза, встречающаяся дважды', paragraphIndex: 0 },
      { sourceRuleId: 2, title: 'B', text: 'общая фраза, встречающаяся дважды', paragraphIndex: 1 },
    ];
    const result = resolveSourceRuleId(unit({ sourceSpan: span('a', 'общая фраза') }), ambiguousRules);
    expect(result).toBeNull();
  });
});
