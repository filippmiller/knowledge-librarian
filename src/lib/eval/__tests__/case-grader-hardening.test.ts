import { describe, expect, it } from 'vitest';
import { gradeCase, type GradeContext, type ObservedCase } from '../case-grader';
import type { EvidencePack } from '@/lib/knowledge/synthesis/evidence-pack';

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

const evidencePack = (unitIds: readonly string[]): EvidencePack => ({
  items: unitIds.map((unitId) => ({
    unitId,
    kind: 'PROCEDURE_STEP',
    statement: 'Не дольше 15 секунд подряд, пауза 30 секунд, максимум 3 цикла.',
    citation: { anchor: `a-${unitId}`, quote: 'не дольше 15 секунд' },
    numericConstraint: null,
  })),
  numericFacts: [],
});

const observed = (overrides: Partial<ObservedCase> = {}): ObservedCase => ({
  caseId: 'Q04',
  candidateUnitIds: ['u4a', 'u4b', 'u4c', 'u1', 'u5'],
  rerankedUnitIds: ['u4a', 'u4b', 'u4c', 'u1', 'u5'],
  selectedUnitIds: ['u4a', 'u4b', 'u4c'],
  disposition: 'DIRECT_ANSWER',
  reasonCodes: [],
  answer: {
    draft: {
      text: 'Не дольше 15 секунд, пауза 30 секунд, максимум 3 цикла.',
      citedUnitIds: ['u4a', 'u4b', 'u4c'],
      answerSource: 'knowledge_base',
    },
    evidencePack: evidencePack(['u4a', 'u4b', 'u4c']),
  },
  ...overrides,
});

describe('P7: verifyAnswerClaims не подтвердил ответ', () => {
  it('НЕ даёт бесплатный PASS — грейдер вызывает проверку сам, а не доверяет чужому вердикту', () => {
    const verdict = gradeCase(
      { caseId: 'Q04', expectedRuleIds: [4], expectedDisposition: 'DIRECT_ANSWER' },
      observed({
        answer: {
          draft: {
            text: 'Не дольше 15 секунд, пауза 30 секунд, максимум 3 цикла.',
            citedUnitIds: [], // без цитат — verifyAnswerClaims обязан провалить
            answerSource: 'knowledge_base',
          },
          evidencePack: evidencePack(['u4a', 'u4b', 'u4c']),
        },
      }),
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
        caseId: 'Q05-N1',
        candidateUnitIds: ['u1', 'u5'],
        rerankedUnitIds: ['u1', 'u5'],
        selectedUnitIds: ['u1'],
        answer: {
          draft: {
            text: 'Не дольше 15 секунд.',
            citedUnitIds: ['u1'],
            answerSource: 'knowledge_base',
          },
          evidencePack: evidencePack(['u1']),
        },
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
      observed({
        candidateUnitIds: ['ghost1', 'ghost2'],
        rerankedUnitIds: ['ghost1', 'ghost2'],
        selectedUnitIds: ['ghost1'],
        answer: {
          draft: {
            text: 'Ответ.',
            citedUnitIds: ['ghost1'],
            answerSource: 'knowledge_base',
          },
          evidencePack: evidencePack(['ghost1']),
        },
      }),
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
    const verdict = gradeCase(
      q04,
      observed({
        selectedUnitIds: ['u4a'],
        answer: {
          draft: {
            text: 'Не дольше 15 секунд.',
            citedUnitIds: ['u4a'],
            answerSource: 'knowledge_base',
          },
          evidencePack: evidencePack(['u4a']),
        },
      }),
      context()
    );

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
      observed({
        selectedUnitIds: ['u4a'],
        answer: {
          draft: {
            text: 'Не дольше 15 секунд.',
            citedUnitIds: ['u4a'],
            answerSource: 'knowledge_base',
          },
          evidencePack: evidencePack(['u4a']),
        },
      }),
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
      observed({
        selectedUnitIds: ['u4a'],
        answer: {
          draft: {
            text: 'Не дольше 15 секунд.',
            citedUnitIds: ['u4a'],
            answerSource: 'knowledge_base',
          },
          evidencePack: evidencePack(['u4a']),
        },
      }),
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
    answer: undefined,
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
        answer: undefined,
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
        answer: undefined,
      }),
      context()
    );

    expect(verdict.result).toBe('PASS');
  });
});

/**
 * Найдено вторым ревью (ChatGPT): исходный тест здесь проверял
 * `answerSource: 'general_ai'` на HOLD-кейсе. Убран сознательно, а не забыт —
 * `buildEvidencePack` отказывается работать при disposition, отличном от
 * `ANSWER` (см. evidence-pack.ts), поэтому в этой архитектуре у HOLD нет
 * DraftAnswer вообще: клarification-текст ещё не синтезируется через тот же
 * путь. Проверять «источник ответа» там, где ответа не существует по
 * контракту, — проверка несуществующей поверхности. Когда H обзаведётся
 * синтезом clarification-текста, эта проверка вернётся вместе с ним.
 */
