import { describe, expect, it } from 'vitest';
import { gradeCase, type GradeContext, type ObservedCase } from '../case-grader';

/**
 * Найдено независимым ревью Grok на срезе 5a. Каждый тест здесь — сценарий, в
 * котором СЛОМАННАЯ система проходила ворота, либо исправная — проваливала.
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

describe('P7: verified=false с пустым списком нарушений', () => {
  it('НЕ даёт бесплатный PASS — провал проверки сам по себе причина', () => {
    const verdict = gradeCase(
      { caseId: 'Q04', expectedRuleIds: [4], expectedDisposition: 'DIRECT_ANSWER' },
      observed({ verification: { verified: false, violations: [] } }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
  });
});

describe('P1: выбор правил на позитивных кейсах', () => {
  it('ЛОВИТ систему, которая нашла правило 4, но ответила по правилу 1', () => {
    const verdict = gradeCase(
      { caseId: 'Q04', expectedRuleIds: [4], expectedDisposition: 'DIRECT_ANSWER' },
      observed({ selectedUnitIds: ['u1'] }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/не выбран/i);
  });

  it('явно заданный requiredSelectedRuleIds имеет приоритет над умолчанием', () => {
    const verdict = gradeCase(
      {
        caseId: 'Q05-N1',
        expectedRuleIds: [1, 3],
        expectedDisposition: 'DIRECT_ANSWER',
        requiredSelectedRuleIds: [1],
        forbiddenSelectedRuleIds: [5],
      },
      observed({
        candidateUnitIds: ['u1', 'u5'],
        rerankedUnitIds: ['u1', 'u5'],
        selectedUnitIds: ['u1'],
      }),
      context({
        sourceRuleByUnitId: new Map([
          ['u1', 1],
          ['u5', 5],
        ]),
      })
    );

    expect(verdict.reasons.join(' ')).not.toMatch(/обязательные правила 3/);
  });
});

describe('F1: unitId вне карты провенанса', () => {
  it('сообщает о неотображённых units ОТДЕЛЬНО, а не как «правило не найдено»', () => {
    const verdict = gradeCase(
      { caseId: 'Q04', expectedRuleIds: [4], expectedDisposition: 'DIRECT_ANSWER' },
      observed({ rerankedUnitIds: ['ghost1', 'ghost2'], selectedUnitIds: ['ghost1'] }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/провенанс|не отображ/i);
  });
});

describe('P8: покрытие чисел считается по ВЫБРАННЫМ units, а не со слов раннера', () => {
  const q04 = {
    caseId: 'Q04',
    expectedRuleIds: [4],
    expectedDisposition: 'DIRECT_ANSWER' as const,
    requiredNumerics: [
      { value: 15, unit: 'seconds' },
      { value: 30, unit: 'seconds' },
      { value: 3, unit: 'cycles' },
    ],
  };

  it('PASS, когда выбраны все три фрагмента', () => {
    expect(gradeCase(q04, observed(), context()).result).toBe('PASS');
  });

  it('FAIL на одном выбранном фрагменте — покрытие не берётся из воздуха', () => {
    const verdict = gradeCase(q04, observed({ selectedUnitIds: ['u4a'] }), context());

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toContain('30');
  });
});

describe('F3: единицы сравниваются нормализованно', () => {
  it('«second» покрывает требование «seconds» — не ложный провал', () => {
    const verdict = gradeCase(
      {
        caseId: 'Q04',
        expectedRuleIds: [4],
        expectedDisposition: 'DIRECT_ANSWER',
        requiredNumerics: [{ value: 15, unit: 'seconds' }],
      },
      observed({ selectedUnitIds: ['u4a'] }),
      context({ numericsByUnitId: new Map([['u4a', [{ value: 15, unit: 'Second' }]]]) })
    );

    expect(verdict.result).toBe('PASS');
  });

  it('но «cycles» по-прежнему не покрывается «seconds»', () => {
    const verdict = gradeCase(
      {
        caseId: 'Q04',
        expectedRuleIds: [4],
        expectedDisposition: 'DIRECT_ANSWER',
        requiredNumerics: [{ value: 3, unit: 'cycles' }],
      },
      observed({ selectedUnitIds: ['u4a'] }),
      context({ numericsByUnitId: new Map([['u4a', [{ value: 3, unit: 'seconds' }]]]) })
    );

    expect(verdict.result).toBe('FAIL');
  });
});

describe('P5/(d): must_clarify не имеет права выбрать одного из конкурентов', () => {
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
  });
  const base = observed({
    caseId: 'Q01-M1',
    candidateUnitIds: ['b1', 'b5'],
    rerankedUnitIds: ['b1', 'b5'],
    selectedUnitIds: [],
    disposition: 'HOLD',
  });

  it('PASS: оба конкурента найдены, ничего не выбрано, система переспросила', () => {
    expect(gradeCase(q01m1, base, ctx).result).toBe('PASS');
  });

  it('FAIL: HOLD объявлен, но выбран ровно один из двух конкурентов', () => {
    const verdict = gradeCase(q01m1, { ...base, selectedUnitIds: ['b1'] }, ctx);

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/наугад/i);
  });
});

describe('P6: недостающие trigger-факты проверяются, а не игнорируются', () => {
  it('FAIL, если система удержала ответ, но не назвала недостающее условие', () => {
    const verdict = gradeCase(
      {
        caseId: 'Q01-M1',
        expectedRuleIds: [1, 5],
        expectedDisposition: 'HOLD',
        expectedMissingTriggerFacts: ['location_public_or_private'],
      },
      observed({
        caseId: 'Q01-M1',
        candidateUnitIds: ['u1', 'u5'],
        rerankedUnitIds: ['u1', 'u5'],
        selectedUnitIds: [],
        disposition: 'HOLD',
        missingTriggerFacts: [],
      }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toContain('location_public_or_private');
  });

  it('PASS, когда недостающее условие названо', () => {
    const verdict = gradeCase(
      {
        caseId: 'Q01-M1',
        expectedRuleIds: [1, 5],
        expectedDisposition: 'HOLD',
        expectedMissingTriggerFacts: ['location_public_or_private'],
      },
      observed({
        caseId: 'Q01-M1',
        candidateUnitIds: ['u1', 'u5'],
        rerankedUnitIds: ['u1', 'u5'],
        selectedUnitIds: [],
        disposition: 'HOLD',
        missingTriggerFacts: ['location_public_or_private'],
      }),
      context()
    );

    expect(verdict.result).toBe('PASS');
  });
});

describe('(b): general_ai запрещён и на пути HOLD', () => {
  it('FAIL: уточняющий вопрос, сочинённый общей моделью, — не работа базы знаний', () => {
    const verdict = gradeCase(
      {
        caseId: 'Q01-M1',
        expectedRuleIds: [1, 5],
        expectedDisposition: 'HOLD',
      },
      observed({
        caseId: 'Q01-M1',
        candidateUnitIds: ['u1', 'u5'],
        rerankedUnitIds: ['u1', 'u5'],
        selectedUnitIds: [],
        disposition: 'HOLD',
        answerSource: 'general_ai',
      }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/general_ai/);
  });
});
