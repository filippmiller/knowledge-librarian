import { describe, expect, it } from 'vitest';
import { gradeCase, type GradeContext, type ObservedCase } from '../case-grader';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';

/**
 * Найдено третьей адверсариальной проверкой (ChatGPT) поверх 869e4f9,
 * подтверждено чтением кода перед исправлением.
 *
 * Главная дыра: `EvidencePack` принимался от вызывающего кода отдельно от
 * `selectedUnitIds` — грейдер мог пройти retrieval/selection по одному набору
 * units, а `verifyAnswerClaims` проверял бы совсем другой (или сфабрикованный)
 * pack. Runner мог подложить под правильные unitId изменённые statement/quote/
 * numericConstraint, и множество идентификаторов совпадало бы, а содержание —
 * нет.
 *
 * Исправление: единственный источник истины на unitId — `GradeContext.units`
 * (реальные `PersistedKnowledgeUnit` + `sourceRuleId`). Evidence pack, числа И
 * правило теперь ВСЕ читаются из ОДНОГО и того же trusted-объекта на unitId —
 * runner больше не может рассинхронизировать их между собой, потому что они
 * физически являются полями одной записи.
 */

const span = (anchor: string, quote: string) => ({ anchor, quote });

function unit(id: string, overrides: Partial<PersistedKnowledgeUnit> = {}): PersistedKnowledgeUnit {
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
    ...overrides,
  };
}

const context = (
  entries: ReadonlyArray<{ id: string; sourceRuleId: number; unit?: Partial<PersistedKnowledgeUnit> }>
): GradeContext => ({
  units: new Map(
    entries.map(({ id, sourceRuleId, unit: overrides }) => [
      id,
      { unit: unit(id, overrides), sourceRuleId },
    ])
  ),
});

describe('evidence pack строится ГРЕЙДЕРОМ из trusted units, а не принимается от runner', () => {
  it('draft ссылается на unit, который НЕ был выбран — FAIL, даже если unit реален', () => {
    const ctx = context([
      { id: 'u4', sourceRuleId: 4 },
      { id: 'u9', sourceRuleId: 9, unit: { statement: 'Правило 9, к делу не относится.' } },
    ]);

    const verdict = gradeCase(
      { caseId: 'Q04', expectedRuleIds: [4], expectedDisposition: 'DIRECT_ANSWER' },
      {
        caseId: 'Q04',
        candidateUnitIds: ['u4', 'u9'],
        rerankedUnitIds: ['u4', 'u9'],
        selectedUnitIds: ['u4'],
        disposition: 'DIRECT_ANSWER',
        reasonCodes: [],
        draft: {
          text: 'Не дольше 15 секунд.',
          citedUnitIds: ['u9'], // цитирует НЕвыбранный unit
          answerSource: 'knowledge_base',
        },
      },
      ctx
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/u9/);
  });

  it('runner не может подложить фиктивный numericConstraint — число проверяется по ХРАНИМОМУ unit, не по словам runner', () => {
    const ctx = context([
      { id: 'u4', sourceRuleId: 4, unit: { numericConstraint: { factKey: 'k', value: 15, unit: 'seconds' } } },
    ]);

    const verdict = gradeCase(
      {
        caseId: 'Q04',
        expectedRuleIds: [4],
        expectedDisposition: 'DIRECT_ANSWER',
        requiredNumerics: [{ value: 999, unit: 'seconds' }], // runner ЗАЯВЛЯЕТ, что 999 покрыто
      },
      {
        caseId: 'Q04',
        candidateUnitIds: ['u4'],
        rerankedUnitIds: ['u4'],
        selectedUnitIds: ['u4'],
        disposition: 'DIRECT_ANSWER',
        reasonCodes: [],
        draft: {
          text: 'Не дольше 15 секунд.',
          citedUnitIds: ['u4'],
          answerSource: 'knowledge_base',
        },
      },
      ctx
    );

    // 999 не может быть покрыто, потому что реальный unit несёт 15, а не 999 —
    // никакого отдельного поля, где runner мог бы заявить обратное, больше нет.
    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toContain('999');
  });

  it('счастливый путь: реальные units дают PASS без caller-supplied pack', () => {
    const ctx = context([{ id: 'u4', sourceRuleId: 4 }]);

    const verdict = gradeCase(
      { caseId: 'Q04', expectedRuleIds: [4], expectedDisposition: 'DIRECT_ANSWER' },
      {
        caseId: 'Q04',
        candidateUnitIds: ['u4'],
        rerankedUnitIds: ['u4'],
        selectedUnitIds: ['u4'],
        disposition: 'DIRECT_ANSWER',
        reasonCodes: [],
        draft: {
          text: 'Не дольше 15 секунд.',
          citedUnitIds: ['u4'],
          answerSource: 'knowledge_base',
        },
      },
      ctx
    );

    expect(verdict.result).toBe('PASS');
  });
});

/**
 * Найдено четвёртым ревью (ChatGPT): `topK` был полем `GradeContext`, и
 * `topK=50` был валиден — правило на позиции 37 проходило бы retrieval gate
 * top-5. Вместо валидации внешнего значения ворота top-5 зашиты константой
 * `ACCEPTANCE_TOP_K` внутри модуля — `topK` больше не часть доверенной
 * поверхности вообще, и передать «неправильное» значение просто нельзя.
 */
describe('acceptance top-5 не настраивается снаружи', () => {
  it('шестое по рангу правило не спасает retrieval gate — жёстко зашитый top-5', () => {
    const others = Array.from({ length: 5 }, (_, i) => ({ id: `noise${i}`, sourceRuleId: 100 + i }));
    const ctx = context([...others, { id: 'u4', sourceRuleId: 4 }]);

    const verdict = gradeCase(
      { caseId: 'Q04', expectedRuleIds: [4], expectedDisposition: 'HOLD' },
      {
        caseId: 'Q04',
        candidateUnitIds: [...others.map((o) => o.id), 'u4'],
        rerankedUnitIds: [...others.map((o) => o.id), 'u4'], // правило 4 — на позиции 6
        selectedUnitIds: [],
        disposition: 'HOLD',
        reasonCodes: [],
      },
      ctx
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/retrieval/i);
  });
});
