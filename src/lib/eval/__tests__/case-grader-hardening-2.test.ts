import { describe, expect, it } from 'vitest';
import { gradeCase, type GradeContext, type ObservedCase, type UnitProvenance } from '../case-grader';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';
import type { DraftAnswer } from '@/lib/knowledge/synthesis/draft-answer';

/**
 * Найдено второй адверсариальной проверкой (ChatGPT/o-series) поверх коммита
 * fde4026, подтверждено чтением кода и эмпирическим прогоном перед тем, как
 * поверить формулировкам ревью.
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

const expectation = {
  caseId: 'Q04',
  expectedRuleIds: [4],
  expectedDisposition: 'DIRECT_ANSWER' as const,
};

describe('caseId cross-check', () => {
  it('FAIL, если expectation и observed относятся к разным кейсам', () => {
    const verdict = gradeCase(expectation, observed({ caseId: 'Q07' }), context());

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/caseId/);
  });
});

describe('provenance-скан включает candidateUnitIds', () => {
  it('ловит неотображённый unit, попавший ТОЛЬКО в кандидаты', () => {
    const verdict = gradeCase(
      expectation,
      observed({ candidateUnitIds: ['ghost', 'u4a', 'u4b', 'u4c', 'u1', 'u5'] }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/trusted-карт/i);
    expect(verdict.reasons.join(' ')).toContain('ghost');
  });
});

describe('clarify-проверка через пересечение, а не размер множества', () => {
  const q01m1 = {
    caseId: 'Q01-M1',
    expectedRuleIds: [1, 5],
    expectedDisposition: 'HOLD' as const,
  };
  const ctx: GradeContext = {
      units: new Map<string, UnitProvenance>([
      ['b1', { unit: unit('b1'), sourceRuleId: 1 }],
      ['b5', { unit: unit('b5'), sourceRuleId: 5 }],
      ['b8', { unit: unit('b8'), sourceRuleId: 8 }],
    ]),
  };

  it('FAIL: выбрано ОДНО из конкурентов ПЛЮС посторонний unit — size=2, но intersection=1', () => {
    const verdict = gradeCase(
      q01m1,
      {
        caseId: 'Q01-M1',
        candidateUnitIds: ['b1', 'b5', 'b8'],
        rerankedUnitIds: ['b1', 'b5', 'b8'],
        selectedUnitIds: ['b1', 'b8'],
        disposition: 'HOLD',
        reasonCodes: [],
      },
      ctx
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/наугад/i);
  });

  /**
   * Найдено третьим ревью (ChatGPT): этот тест раньше проверял только
   * `.not.toMatch(/наугад/)`, а не итоговый вердикт — фикстура называлась
   * PASS, но `b8` отсутствовал в `candidates`/`reranked`, и trace-integrity
   * gate валил её по СОВСЕМ другой причине. Название теста лгало о том, что
   * он проверяет. Теперь `b8` присутствует на всех трёх этапах, и итоговый
   * `result` проверяется явно.
   */
  it('PASS: посторонний unit без конкурента среди выбранных — это не выбор наугад', () => {
    const verdict = gradeCase(
      q01m1,
      {
        caseId: 'Q01-M1',
        candidateUnitIds: ['b1', 'b5', 'b8'],
        rerankedUnitIds: ['b1', 'b5', 'b8'],
        selectedUnitIds: ['b8'],
        disposition: 'HOLD',
        reasonCodes: [],
      },
      ctx
    );

    expect(verdict.result).toBe('PASS');
    expect(verdict.reasons.join(' ')).not.toMatch(/наугад/i);
  });
});

describe('целостность trace: reranked ⊆ candidates, selected ⊆ reranked', () => {
  it('FAIL: selected содержит unit вне rerankedUnitIds', () => {
    const verdict = gradeCase(
      expectation,
      observed({
        selectedUnitIds: ['u4a', 'phantom'],
        draft: draftFrom(['u4a']),
      }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/целостность|trace/i);
  });

  it('FAIL: rerankedUnitIds содержит unit вне candidateUnitIds', () => {
    const verdict = gradeCase(
      expectation,
      observed({ rerankedUnitIds: ['u4a', 'u4b', 'u4c', 'u1', 'u5', 'sneaky'] }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/целостность|trace/i);
  });

  it('FAIL: дубль unitId внутри одного массива', () => {
    const verdict = gradeCase(
      expectation,
      observed({ rerankedUnitIds: ['u4a', 'u4a', 'u4b', 'u4c', 'u1', 'u5'] }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
  });
});

describe('verifyAnswerClaims вызывается ГРЕЙДЕРОМ против trusted evidence, а не переданного pack', () => {
  it('FAIL: draft ссылается на unit, который реален, но НЕ выбран', () => {
    const verdict = gradeCase(
      expectation,
      observed({
        draft: {
          text: 'Не дольше 15 секунд.',
          citedUnitIds: ['u4a', 'u5'], // u5 реален (есть в trusted units), но не выбран
          answerSource: 'knowledge_base',
        },
      }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/u5/);
  });

  it('FAIL: число в тексте не подтверждено trusted-содержанием выбранных units', () => {
    const verdict = gradeCase(
      expectation,
      observed({
        draft: {
          text: 'Не дольше 999 секунд.',
          citedUnitIds: ['u4a'],
          answerSource: 'knowledge_base',
        },
      }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toContain('999');
  });

  it('ожидался DIRECT_ANSWER, но observed.disposition — HOLD: явный провал, а не молчание', () => {
    const verdict = gradeCase(
      expectation,
      {
        caseId: 'Q04',
        candidateUnitIds: ['u4a', 'u4b', 'u4c', 'u1', 'u5'],
        rerankedUnitIds: ['u4a', 'u4b', 'u4c', 'u1', 'u5'],
        selectedUnitIds: [],
        disposition: 'HOLD',
        reasonCodes: [],
      },
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/синтезированного ответа нет/);
  });
});
