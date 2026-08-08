import { describe, expect, it } from 'vitest';
import { gradeCase, type GradeContext, type ObservedCase, type UnitProvenance } from '../case-grader';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';
import type { DraftAnswer } from '@/lib/knowledge/synthesis/draft-answer';

/**
 * Ворота плана §0.4, сведённые в один вердикт по кейсу.
 *
 * Порядок проверок — не оформление, а суть. Целостность trace проверяется
 * первой, retrieval gate — следующим: «успех не может быть засчитан по
 * красивому финальному ответу», если ожидаемая группа правил не попала в
 * reranked top-5, кейс провален независимо от текста. Точно так же
 * `answerSource === 'general_ai'` — автоматический провал, даже если текст
 * совпал с ожидаемым (§0.3 №4).
 */

const span = (anchor: string, quote: string) => ({ anchor, quote });

function unit(id: string, overrides: Partial<PersistedKnowledgeUnit> = {}): PersistedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'Не дольше 15 секунд подряд, пауза 30 секунд, максимум 3 цикла.',
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
    ...overrides,
  };
}

const UNIT_RULES: Record<string, number> = { u4a: 4, u4b: 4, u4c: 4, u1: 1, u5: 5 };

const context = (overrides: Partial<GradeContext> = {}): GradeContext => ({
  units: new Map(
    Object.entries(UNIT_RULES).map(([id, sourceRuleId]): [string, UnitProvenance] => [
      id,
      { unit: unit(id), sourceRuleId },
    ])
  ),
  ...overrides,
});

const draftFrom = (unitIds: readonly string[]): DraftAnswer => ({
  text: 'Не дольше 15 секунд, пауза 30 секунд, максимум 3 цикла.',
  citedUnitIds: [...unitIds],
  answerSource: 'knowledge_base',
});

const observed = (overrides: Partial<ObservedCase> = {}): ObservedCase => ({
  caseId: 'Q04',
  candidateUnitIds: ['u4a', 'u4b', 'u4c', 'u1', 'u5'],
  rerankedUnitIds: ['u4a', 'u4b', 'u4c', 'u1', 'u5'],
  selectedUnitIds: ['u4a', 'u4b', 'u4c'],
  disposition: 'DIRECT_ANSWER',
  reasonCodes: [],
  draft: draftFrom(['u4a', 'u4b', 'u4c']),
  ...overrides,
} as ObservedCase);

const expectation = {
  caseId: 'Q04',
  expectedRuleIds: [4],
  expectedDisposition: 'DIRECT_ANSWER' as const,
};

describe('gradeCase — retrieval gate идёт первым', () => {
  it('PASS, когда ожидаемое правило в top-K и всё остальное в порядке', () => {
    expect(gradeCase(expectation, observed(), context()).result).toBe('PASS');
  });

  it('FAIL, если ожидаемое правило вне top-K — текст ответа не спасает', () => {
    const verdict = gradeCase(
      expectation,
      observed({
        candidateUnitIds: ['u1', 'u5', 'u4a'],
        rerankedUnitIds: ['u1', 'u5'],
        selectedUnitIds: [],
        disposition: 'HOLD',
      } as Partial<ObservedCase>),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/retrieval/i);
  });

  it('провал retrieval сообщается, даже если ответ безупречен', () => {
    const verdict = gradeCase(
      expectation,
      observed({
        candidateUnitIds: ['u1', 'u5'],
        rerankedUnitIds: ['u1', 'u5'],
        selectedUnitIds: [],
        disposition: 'HOLD',
      } as Partial<ObservedCase>),
      context()
    );

    expect(verdict.result).toBe('FAIL');
  });
});

describe('gradeCase — источник ответа', () => {
  it('general_ai — автоматический FAIL при верном тексте и найденном правиле', () => {
    const verdict = gradeCase(
      expectation,
      observed({ draft: { ...draftFrom(['u4a', 'u4b', 'u4c']), answerSource: 'general_ai' } }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/general_ai/);
  });

  it('deterministic_guardrail не считается ответом из базы знаний', () => {
    const verdict = gradeCase(
      expectation,
      observed({
        draft: { ...draftFrom(['u4a', 'u4b', 'u4c']), answerSource: 'deterministic_guardrail' },
      }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
  });
});

describe('gradeCase — непроверенные утверждения', () => {
  it('FAIL, если verifyAnswerClaims не подтвердил ответ', () => {
    const verdict = gradeCase(
      expectation,
      observed({
        draft: {
          text: 'Не дольше 7 циклов.',
          citedUnitIds: ['u4a', 'u4b', 'u4c'],
          answerSource: 'knowledge_base',
        },
      }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toContain('7');
  });
});

describe('gradeCase — совместное покрытие чисел (Q04)', () => {
  const withNumerics = {
    ...expectation,
    requiredNumerics: [
      { value: 15, unit: 'seconds' },
      { value: 30, unit: 'seconds' },
      { value: 3, unit: 'cycles' },
    ],
  };

  const numericContext = context({
    units: new Map<string, UnitProvenance>([
      ['u4a', { unit: unit('u4a', { numericConstraint: { factKey: 'k1', value: 15, unit: 'seconds' } }), sourceRuleId: 4 }],
      ['u4b', { unit: unit('u4b', { numericConstraint: { factKey: 'k2', value: 30, unit: 'seconds' } }), sourceRuleId: 4 }],
      ['u4c', { unit: unit('u4c', { numericConstraint: { factKey: 'k3', value: 3, unit: 'cycles' } }), sourceRuleId: 4 }],
      ['u1', { unit: unit('u1'), sourceRuleId: 1 }],
      ['u5', { unit: unit('u5'), sourceRuleId: 5 }],
    ]),
  });

  it('PASS, когда выбранные units покрывают все три числа СОВМЕСТНО', () => {
    expect(gradeCase(withNumerics, observed(), numericContext).result).toBe('PASS');
  });

  it('FAIL на одном осколке — покрыто 15, но не 30 и не 3 цикла', () => {
    const verdict = gradeCase(
      withNumerics,
      observed({ selectedUnitIds: ['u4a'], draft: draftFrom(['u4a']) }),
      numericContext
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toContain('30');
    expect(verdict.reasons.join(' ')).toContain('3');
  });

  it('единица учитывается: 3 секунды не закрывают требование 3 цикла', () => {
    const mismatched = context({
      units: new Map<string, UnitProvenance>([
        ['u4a', { unit: unit('u4a', { numericConstraint: { factKey: 'k1', value: 15, unit: 'seconds' } }), sourceRuleId: 4 }],
        ['u4b', { unit: unit('u4b', { numericConstraint: { factKey: 'k2', value: 30, unit: 'seconds' } }), sourceRuleId: 4 }],
        ['u4c', { unit: unit('u4c', { numericConstraint: { factKey: 'k3', value: 3, unit: 'seconds' } }), sourceRuleId: 4 }],
      ]),
    });

    const verdict = gradeCase(withNumerics, observed(), mismatched);

    expect(verdict.result).toBe('FAIL');
  });
});

describe('gradeCase — negative-кейсы', () => {
  const q05n1 = {
    caseId: 'Q05-N1',
    expectedRuleIds: [1, 3],
    expectedDisposition: 'DIRECT_ANSWER' as const,
    requiredCandidateRuleIds: [1, 3, 5],
    requiredSelectedRuleIds: [1, 3],
    forbiddenSelectedRuleIds: [5],
  };

  const ctx: GradeContext = {
      units: new Map<string, UnitProvenance>([
      ['a1', { unit: unit('a1'), sourceRuleId: 1 }],
      ['a3', { unit: unit('a3'), sourceRuleId: 3 }],
      ['a5', { unit: unit('a5'), sourceRuleId: 5 }],
    ]),
  };

  const base = observed({
    caseId: 'Q05-N1',
    candidateUnitIds: ['a1', 'a3', 'a5'],
    rerankedUnitIds: ['a1', 'a3', 'a5'],
    selectedUnitIds: ['a1', 'a3'],
    draft: draftFrom(['a1', 'a3']),
  });

  it('PASS: узкое исключение найдено кандидатом, но НЕ выбрано', () => {
    expect(gradeCase(q05n1, base, ctx).result).toBe('PASS');
  });

  it('FAIL: запрещённое правило попало в выбранные', () => {
    const verdict = gradeCase(
      q05n1,
      { ...base, selectedUnitIds: ['a1', 'a3', 'a5'], draft: draftFrom(['a1', 'a3', 'a5']) } as ObservedCase,
      ctx
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/5/);
  });

  it('FAIL: конкурирующее правило вообще не стало кандидатом — система промолчала, а не рассудила', () => {
    const verdict = gradeCase(
      q05n1,
      { ...base, candidateUnitIds: ['a1', 'a3'], rerankedUnitIds: ['a1', 'a3'] } as ObservedCase,
      ctx
    );

    expect(verdict.result).toBe('FAIL');
  });

  it('FAIL: обязательное правило не выбрано', () => {
    const verdict = gradeCase(
      q05n1,
      { ...base, selectedUnitIds: ['a1'], draft: draftFrom(['a1']) } as ObservedCase,
      ctx
    );

    expect(verdict.result).toBe('FAIL');
  });

  it('FAIL: HOLD там, где ожидался прямой ответ', () => {
    const verdict = gradeCase(
      q05n1,
      { ...base, disposition: 'HOLD' } as ObservedCase,
      ctx
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/disposition/i);
  });
});

describe('gradeCase — must_clarify', () => {
  const q01m1 = {
    caseId: 'Q01-M1',
    expectedRuleIds: [1, 5],
    expectedDisposition: 'HOLD' as const,
    requiredCandidateRuleIds: [1, 5],
  };
  const ctx: GradeContext = {
      units: new Map<string, UnitProvenance>([
      ['b1', { unit: unit('b1'), sourceRuleId: 1 }],
      ['b5', { unit: unit('b5'), sourceRuleId: 5 }],
    ]),
  };
  const base: ObservedCase = {
    caseId: 'Q01-M1',
    candidateUnitIds: ['b1', 'b5'],
    rerankedUnitIds: ['b1', 'b5'],
    selectedUnitIds: [],
    disposition: 'HOLD',
    reasonCodes: [],
  };

  it('PASS: оба конкурирующих правила найдены, система переспросила', () => {
    expect(gradeCase(q01m1, base, ctx).result).toBe('PASS');
  });

  it('FAIL: выбрано одно из двух наугад вместо уточнения', () => {
    const verdict = gradeCase(
      q01m1,
      {
        caseId: 'Q01-M1',
        candidateUnitIds: ['b1', 'b5'],
        rerankedUnitIds: ['b1', 'b5'],
        selectedUnitIds: ['b1'],
        disposition: 'DIRECT_ANSWER',
        reasonCodes: [],
        draft: draftFrom(['b1']),
      },
      ctx
    );

    expect(verdict.result).toBe('FAIL');
  });

  it('HOLD не может нести синтезированный ответ — не типизируется, поэтому проверять нечего', () => {
    expect(gradeCase(q01m1, base, ctx).result).toBe('PASS');
  });
});
