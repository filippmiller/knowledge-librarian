import { describe, expect, it } from 'vitest';
import { gradeCase, type CaseExpectation, type GradeContext, type ObservedCase, type UnitProvenance } from '../case-grader';
import { RULE_9_EVIDENCE_GROUP } from '../evidence-groups';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';

/**
 * pre-retrieval hardening, Step 8 — closes the gap case-grader.ts's own
 * header comment names explicitly: "Если экстракция раздробит правило 9
 * (согласие/перчатки/остановка) на несколько units и будет выбран только
 * один фрагмент, sourceRuleId всё равно засчитает правило целиком."
 */

const span = (anchor: string, quote: string) => ({ anchor, quote });

function unit(overrides: Partial<PersistedKnowledgeUnit>): PersistedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'заполнитель',
    facets: {},
    triggerCondition: { all: [{ fact: 'helperPresent', equals: true }] },
    numericConstraint: null,
    parentRuleRef: null,
    sourceSpan: span('anchor-r9', 'заполнитель'),
    evidenceByField: { statement: span('anchor-r9', 'заполнитель') },
    uncertainties: [],
    sourceBlockAnchor: 'block-r9',
    unitId: 'placeholder',
    contentHash: 'hash-placeholder',
    ...overrides,
  };
}

const CONSENT = unit({ unitId: 'consent', statement: 'После ясного согласия того, кому помогают.' });
const GLOVES = unit({ unitId: 'gloves', statement: 'Помощник обязан надеть чистые одноразовые перчатки.' });
const STOP = unit({ unitId: 'stop', statement: 'Помощник обязан немедленно остановиться по первой просьбе.' });

function context(): GradeContext {
  return {
    units: new Map<string, UnitProvenance>([
      ['consent', { unit: CONSENT, sourceRuleId: 9 }],
      ['gloves', { unit: GLOVES, sourceRuleId: 9 }],
      ['stop', { unit: STOP, sourceRuleId: 9 }],
    ]),
  };
}

const expectation = (): CaseExpectation => ({
  caseId: 'Q09',
  expectedRuleIds: [9],
  expectedDisposition: 'DIRECT_ANSWER',
  requiredEvidenceGroups: [RULE_9_EVIDENCE_GROUP],
});

function observed(selectedUnitIds: readonly string[]): ObservedCase {
  return {
    caseId: 'Q09',
    candidateUnitIds: ['consent', 'gloves', 'stop'],
    rerankedUnitIds: ['consent', 'gloves', 'stop'],
    selectedUnitIds,
    disposition: 'DIRECT_ANSWER',
    reasonCodes: [],
    draft: {
      text: 'После ясного согласия того, кому помогают. Помощник обязан надеть чистые одноразовые перчатки. Помощник обязан немедленно остановиться по первой просьбе.',
      citedUnitIds: [...selectedUnitIds],
      answerSource: 'knowledge_base',
    },
  };
}

describe('gradeCase — requiredEvidenceGroups закрывает multi-clause gap для правила 9', () => {
  it('выбран только ОДИН фрагмент (согласие) из трёх обязательных -> FAIL, sourceRuleId=9 больше не засчитывает правило целиком за один фрагмент', () => {
    const verdict = gradeCase(expectation(), observed(['consent']), context());
    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.some((r) => r.includes('перчат') || r.toLowerCase().includes('evidence'))).toBe(true);
  });

  it('выбраны ВСЕ три фрагмента -> PASS', () => {
    const verdict = gradeCase(expectation(), observed(['consent', 'gloves', 'stop']), context());
    expect(verdict.result).toBe('PASS');
  });

  it('requiredEvidenceGroups не задан (undefined) -> старое поведение не меняется, координата не проверяется', () => {
    const bareExpectation: CaseExpectation = {
      caseId: 'Q09',
      expectedRuleIds: [9],
      expectedDisposition: 'DIRECT_ANSWER',
    };
    const verdict = gradeCase(bareExpectation, observed(['consent']), context());
    expect(verdict.result).toBe('PASS');
  });
});
