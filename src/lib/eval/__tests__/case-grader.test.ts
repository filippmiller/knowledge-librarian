import { describe, expect, it } from 'vitest';
import { gradeCase, type GradeContext, type ObservedCase } from '../case-grader';

/**
 * Ворота плана §0.4, сведённые в один вердикт по кейсу.
 *
 * Порядок проверок — не оформление, а суть. Retrieval gate идёт ПЕРВЫМ, потому
 * что «успех не может быть засчитан по красивому финальному ответу»: если
 * ожидаемая группа правил не попала в reranked top-5, кейс провален независимо
 * от текста. Точно так же `answerSource === 'general_ai'` — автоматический
 * провал, даже если текст совпал с ожидаемым (§0.3 №4).
 */

const context = (overrides: Partial<GradeContext> = {}): GradeContext => ({
  topK: 5,
  sourceRuleByUnitId: new Map([
    ['u4a', 4],
    ['u4b', 4],
    ['u4c', 4],
    ['u1', 1],
    ['u5', 5],
  ]),
  numericsByUnitId: new Map([
    ['u4a', [{ value: 15, unit: 'seconds' }]],
    ['u4b', [{ value: 30, unit: 'seconds' }]],
    ['u4c', [{ value: 3, unit: 'cycles' }]],
  ]),
  ...overrides,
});

const observed = (overrides: Partial<ObservedCase> = {}): ObservedCase => ({
  caseId: 'Q04',
  candidateUnitIds: ['u4a', 'u4b', 'u4c', 'u1'],
  rerankedUnitIds: ['u4a', 'u4b', 'u4c', 'u1', 'u5'],
  selectedUnitIds: ['u4a', 'u4b', 'u4c'],
  disposition: 'DIRECT_ANSWER',
  answerSource: 'knowledge_base',
  verification: { verified: true, violations: [] },
  reasonCodes: [],
  ...overrides,
});

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
      observed({ rerankedUnitIds: ['u1', 'u5', 'u1', 'u5', 'u1', 'u4a'] }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/retrieval/i);
  });

  it('провал retrieval сообщается, даже если ответ безупречен', () => {
    const verdict = gradeCase(expectation, observed({ rerankedUnitIds: ['u1', 'u5'] }), context());

    expect(verdict.result).toBe('FAIL');
  });
});

describe('gradeCase — источник ответа', () => {
  it('general_ai — автоматический FAIL при верном тексте и найденном правиле', () => {
    const verdict = gradeCase(expectation, observed({ answerSource: 'general_ai' }), context());

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/general_ai/);
  });

  it('deterministic_guardrail не считается ответом из базы знаний', () => {
    const verdict = gradeCase(
      expectation,
      observed({ answerSource: 'deterministic_guardrail' }),
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
        verification: {
          verified: false,
          violations: [{ code: 'unsupported_number', detail: 'число 7 не подтверждено' }],
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

  it('PASS, когда выбранные units покрывают все три числа СОВМЕСТНО', () => {
    expect(gradeCase(withNumerics, observed(), context()).result).toBe('PASS');
  });

  it('FAIL на одном осколке — покрыто 15, но не 30 и не 3 цикла', () => {
    const verdict = gradeCase(withNumerics, observed({ selectedUnitIds: ['u4a'] }), context());

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toContain('30');
    expect(verdict.reasons.join(' ')).toContain('3');
  });

  it('единица учитывается: 3 секунды не закрывают требование 3 цикла', () => {
    const verdict = gradeCase(
      withNumerics,
      observed(),
      context({
        numericsByUnitId: new Map([
          ['u4a', [{ value: 15, unit: 'seconds' }]],
          ['u4b', [{ value: 30, unit: 'seconds' }]],
          ['u4c', [{ value: 3, unit: 'seconds' }]],
        ]),
      })
    );

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

  const ctx = context({
    sourceRuleByUnitId: new Map([
      ['a1', 1],
      ['a3', 3],
      ['a5', 5],
    ]),
    numericsByUnitId: new Map(),
  });

  const base = observed({
    caseId: 'Q05-N1',
    candidateUnitIds: ['a1', 'a3', 'a5'],
    rerankedUnitIds: ['a1', 'a3', 'a5'],
    selectedUnitIds: ['a1', 'a3'],
  });

  it('PASS: узкое исключение найдено кандидатом, но НЕ выбрано', () => {
    expect(gradeCase(q05n1, base, ctx).result).toBe('PASS');
  });

  it('FAIL: запрещённое правило попало в выбранные', () => {
    const verdict = gradeCase(q05n1, { ...base, selectedUnitIds: ['a1', 'a3', 'a5'] }, ctx);

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/5/);
  });

  it('FAIL: конкурирующее правило вообще не стало кандидатом — система промолчала, а не рассудила', () => {
    const verdict = gradeCase(
      q05n1,
      { ...base, candidateUnitIds: ['a1', 'a3'], rerankedUnitIds: ['a1', 'a3'] },
      ctx
    );

    expect(verdict.result).toBe('FAIL');
  });

  it('FAIL: обязательное правило не выбрано', () => {
    const verdict = gradeCase(q05n1, { ...base, selectedUnitIds: ['a1'] }, ctx);

    expect(verdict.result).toBe('FAIL');
  });

  it('FAIL: HOLD там, где ожидался прямой ответ', () => {
    const verdict = gradeCase(q05n1, { ...base, disposition: 'HOLD' }, ctx);

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
  const ctx = context({
    sourceRuleByUnitId: new Map([
      ['b1', 1],
      ['b5', 5],
    ]),
    numericsByUnitId: new Map(),
  });
  const base = observed({
    caseId: 'Q01-M1',
    candidateUnitIds: ['b1', 'b5'],
    rerankedUnitIds: ['b1', 'b5'],
    selectedUnitIds: [],
    disposition: 'HOLD',
  });

  it('PASS: оба конкурирующих правила найдены, система переспросила', () => {
    expect(gradeCase(q01m1, base, ctx).result).toBe('PASS');
  });

  it('FAIL: выбрано одно из двух наугад вместо уточнения', () => {
    const verdict = gradeCase(
      q01m1,
      { ...base, disposition: 'DIRECT_ANSWER', selectedUnitIds: ['b1'] },
      ctx
    );

    expect(verdict.result).toBe('FAIL');
  });

  it('HOLD не требует ни цитат, ни подтверждения чисел — отвечать нечем', () => {
    const verdict = gradeCase(
      q01m1,
      {
        ...base,
        verification: {
          verified: false,
          violations: [{ code: 'uncited_answer', detail: 'нет цитат' }],
        },
      },
      ctx
    );

    expect(verdict.result).toBe('PASS');
  });
});
