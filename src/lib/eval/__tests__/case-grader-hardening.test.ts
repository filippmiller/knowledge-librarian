import { describe, expect, it } from 'vitest';
import { gradeCase, type GradeContext, type ObservedCase, type UnitProvenance } from '../case-grader';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';
import type { DraftAnswer } from '@/lib/knowledge/synthesis/draft-answer';

/**
 * Найдено независимым ревью Grok на срезе 5a. Каждый тест здесь — сценарий, в
 * котором СЛОМАННАЯ система проходила ворота, либо исправная — проваливала.
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

const draftFrom = (unitIds: readonly string[]): DraftAnswer => ({
  text: 'Не дольше 15 секунд, пауза 30 секунд, максимум 3 цикла.',
  citedUnitIds: [...unitIds],
  answerSource: 'knowledge_base',
});

const DEFAULT_UNITS: ReadonlyArray<[string, number, Partial<PersistedKnowledgeUnit>?]> = [
  ['u4a', 4, { numericConstraint: { factKey: 'k1', value: 15, unit: 'seconds' } }],
  ['u4b', 4, { numericConstraint: { factKey: 'k2', value: 30, unit: 'seconds' } }],
  ['u4c', 4, { numericConstraint: { factKey: 'k3', value: 3, unit: 'cycles' } }],
  ['u1', 1],
  ['u5', 5],
];

const context = (overrides: Partial<GradeContext> = {}): GradeContext => ({
  units: new Map<string, UnitProvenance>(
    DEFAULT_UNITS.map(([id, sourceRuleId, unitOverrides]) => [
      id,
      { unit: unit(id, unitOverrides), sourceRuleId },
    ])
  ),
  ...overrides,
});

const observed = (overrides: Partial<ObservedCase> = {}): ObservedCase =>
  ({
    caseId: 'Q04',
    candidateUnitIds: ['u4a', 'u4b', 'u4c', 'u1', 'u5'],
    rerankedUnitIds: ['u4a', 'u4b', 'u4c', 'u1', 'u5'],
    selectedUnitIds: ['u4a', 'u4b', 'u4c'],
    disposition: 'DIRECT_ANSWER',
    reasonCodes: [],
    draft: draftFrom(['u4a', 'u4b', 'u4c']),
    ...overrides,
  }) as ObservedCase;

describe('P7: verifyAnswerClaims не подтвердил ответ', () => {
  it('НЕ даёт бесплатный PASS — грейдер вызывает проверку сам, а не доверяет чужому вердикту', () => {
    const verdict = gradeCase(
      { caseId: 'Q04', expectedRuleIds: [4], expectedDisposition: 'DIRECT_ANSWER' },
      observed({
        draft: {
          text: 'Не дольше 15 секунд, пауза 30 секунд, максимум 3 цикла.',
          citedUnitIds: [], // без цитат — verifyAnswerClaims обязан провалить
          answerSource: 'knowledge_base',
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
      observed({ selectedUnitIds: ['u1'], draft: draftFrom(['u1']) }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/не выбран/i);
  });

  it('явно заданный requiredSelectedRuleIds имеет приоритет над умолчанием', () => {
    const ctx: GradeContext = {
          units: new Map<string, UnitProvenance>([
        ['u1', { unit: unit('u1'), sourceRuleId: 1 }],
        ['u5', { unit: unit('u5'), sourceRuleId: 5 }],
      ]),
    };

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
        draft: draftFrom(['u1']),
      }),
      ctx
    );

    expect(verdict.reasons.join(' ')).not.toMatch(/обязательные правила 3/);
  });
});

describe('F1: unitId вне trusted-карты', () => {
  it('сообщает о неотображённых units ОТДЕЛЬНО, а не как «правило не найдено»', () => {
    const verdict = gradeCase(
      { caseId: 'Q04', expectedRuleIds: [4], expectedDisposition: 'DIRECT_ANSWER' },
      observed({
        candidateUnitIds: ['ghost1', 'ghost2'],
        rerankedUnitIds: ['ghost1', 'ghost2'],
        selectedUnitIds: ['ghost1'],
        draft: draftFrom(['ghost1']),
      }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/trusted-карт/i);
  });
});

describe('P8: покрытие чисел считается по ВЫБРАННЫМ units, из trusted-источника', () => {
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
      observed({ selectedUnitIds: ['u4a'], draft: draftFrom(['u4a']) }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toContain('30');
  });
});

describe('F3: единицы сравниваются нормализованно', () => {
  it('«second» покрывает требование «seconds» — не ложный провал', () => {
    const ctx = context({
      units: new Map<string, UnitProvenance>([
        ['u4a', { unit: unit('u4a', { numericConstraint: { factKey: 'k', value: 15, unit: 'Second' } }), sourceRuleId: 4 }],
      ]),
    });

    const verdict = gradeCase(
      {
        caseId: 'Q04',
        expectedRuleIds: [4],
        expectedDisposition: 'DIRECT_ANSWER',
        requiredNumerics: [{ value: 15, unit: 'seconds' }],
      },
      observed({
        candidateUnitIds: ['u4a'],
        rerankedUnitIds: ['u4a'],
        selectedUnitIds: ['u4a'],
        draft: draftFrom(['u4a']),
      }),
      ctx
    );

    expect(verdict.result).toBe('PASS');
  });

  it('но «cycles» по-прежнему не покрывается «seconds»', () => {
    const ctx = context({
      units: new Map<string, UnitProvenance>([
        ['u4a', { unit: unit('u4a', { numericConstraint: { factKey: 'k', value: 3, unit: 'seconds' } }), sourceRuleId: 4 }],
      ]),
    });

    const verdict = gradeCase(
      {
        caseId: 'Q04',
        expectedRuleIds: [4],
        expectedDisposition: 'DIRECT_ANSWER',
        requiredNumerics: [{ value: 3, unit: 'cycles' }],
      },
      observed({
        candidateUnitIds: ['u4a'],
        rerankedUnitIds: ['u4a'],
        selectedUnitIds: ['u4a'],
        draft: draftFrom(['u4a']),
      }),
      ctx
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/не покрывают совместно/);
  });
});

describe('P5/(d): must_clarify не имеет права выбрать одного из конкурентов', () => {
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
    const ctx: GradeContext = {
          units: new Map<string, UnitProvenance>([
        ['u1', { unit: unit('u1'), sourceRuleId: 1 }],
        ['u5', { unit: unit('u5'), sourceRuleId: 5 }],
      ]),
    };

    const verdict = gradeCase(
      {
        caseId: 'Q01-M1',
        expectedRuleIds: [1, 5],
        expectedDisposition: 'HOLD',
        expectedMissingTriggerFacts: ['location_public_or_private'],
      },
      {
        caseId: 'Q01-M1',
        candidateUnitIds: ['u1', 'u5'],
        rerankedUnitIds: ['u1', 'u5'],
        selectedUnitIds: [],
        disposition: 'HOLD',
        reasonCodes: [],
        missingTriggerFacts: [],
      },
      ctx
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toContain('location_public_or_private');
  });

  it('PASS, когда недостающее условие названо', () => {
    const ctx: GradeContext = {
          units: new Map<string, UnitProvenance>([
        ['u1', { unit: unit('u1'), sourceRuleId: 1 }],
        ['u5', { unit: unit('u5'), sourceRuleId: 5 }],
      ]),
    };

    const verdict = gradeCase(
      {
        caseId: 'Q01-M1',
        expectedRuleIds: [1, 5],
        expectedDisposition: 'HOLD',
        expectedMissingTriggerFacts: ['location_public_or_private'],
      },
      {
        caseId: 'Q01-M1',
        candidateUnitIds: ['u1', 'u5'],
        rerankedUnitIds: ['u1', 'u5'],
        selectedUnitIds: [],
        disposition: 'HOLD',
        reasonCodes: [],
        missingTriggerFacts: ['location_public_or_private'],
      },
      ctx
    );

    expect(verdict.result).toBe('PASS');
  });
});

/**
 * Найдено вторым ревью (ChatGPT): исходный тест здесь проверял
 * `answerSource: 'general_ai'` на HOLD-кейсе. Убран сознательно, а не забыт —
 * `ObservedCase` теперь дискриминированное объединение по `disposition`:
 * у HOLD в принципе нет поля `draft`, состояние «HOLD с синтезированным
 * ответом» не типизируется. Проверять «источник ответа» там, где ответа не
 * существует по контракту, — проверка несуществующей поверхности. Когда H
 * обзаведётся синтезом clarification-текста, у него будет свой тип и своя
 * проверка источника.
 */
