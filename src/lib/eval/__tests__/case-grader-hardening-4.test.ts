import { describe, expect, it } from 'vitest';
import { gradeCase, type GradeContext, type ObservedCase, type UnitProvenance } from '../case-grader';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';

/**
 * Найдено четвёртой адверсариальной проверкой (ChatGPT) поверх 932cd8d,
 * подтверждено воспроизведением исключения перед исправлением.
 *
 * Свойство, которое обязано выполняться: любой некорректный trace превращается
 * в детерминированный CaseVerdict с result='FAIL', но НИКОГДА не валит весь
 * прогон исключением — один повреждённый кейс не должен обрывать оценку
 * остальных 15.
 */

const span = (anchor: string, quote: string) => ({ anchor, quote });

function unit(id: string): PersistedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'Не дольше 15 секунд подряд.',
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    parentRuleRef: null,
    sourceSpan: span(`a-${id}`, 'не дольше 15 секунд'),
    evidenceByField: { statement: span(`a-${id}`, 'не дольше 15 секунд') },
    uncertainties: [],
    sourceBlockAnchor: `block-${id}`,
    unitId: id,
    contentHash: `hash-${id}`,
  };
}

const context = (): GradeContext => ({
  units: new Map<string, UnitProvenance>([['u4', { unit: unit('u4'), sourceRuleId: 4 }]]),
});

const expectation = { caseId: 'Q04', expectedRuleIds: [4], expectedDisposition: 'DIRECT_ANSWER' as const };

describe('поломанный selected trace не валит прогон исключением', () => {
  it('DIRECT_ANSWER с пустым selectedUnitIds → FAIL, а не throw', () => {
    const observed: ObservedCase = {
      caseId: 'Q04',
      candidateUnitIds: ['u4'],
      rerankedUnitIds: ['u4'],
      selectedUnitIds: [],
      disposition: 'DIRECT_ANSWER',
      reasonCodes: [],
      draft: { text: 'Не дольше 15 секунд.', citedUnitIds: [], answerSource: 'knowledge_base' },
    };

    expect(() => gradeCase(expectation, observed, context())).not.toThrow();
    expect(gradeCase(expectation, observed, context()).result).toBe('FAIL');
  });

  it('DIRECT_ANSWER с дублем в selectedUnitIds → FAIL, а не throw', () => {
    const observed: ObservedCase = {
      caseId: 'Q04',
      candidateUnitIds: ['u4'],
      rerankedUnitIds: ['u4'],
      selectedUnitIds: ['u4', 'u4'],
      disposition: 'DIRECT_ANSWER',
      reasonCodes: [],
      draft: { text: 'Не дольше 15 секунд.', citedUnitIds: ['u4'], answerSource: 'knowledge_base' },
    };

    expect(() => gradeCase(expectation, observed, context())).not.toThrow();
    expect(gradeCase(expectation, observed, context()).result).toBe('FAIL');
  });
});
