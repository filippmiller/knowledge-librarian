import { describe, expect, it } from 'vitest';
import { gradeCase, type GradeContext, type ObservedCase } from '../case-grader';
import type { EvidencePack } from '@/lib/knowledge/synthesis/evidence-pack';

/**
 * Найдено второй адверсариальной проверкой (ChatGPT/o-series) поверх коммита
 * fde4026, подтверждено чтением кода и эмпирическим прогоном перед тем, как
 * поверить формулировкам ревью.
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
    statement: 'Не дольше 15 секунд подряд.',
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
      observed({ candidateUnitIds: ['ghost', 'u4a', 'u4b', 'u4c', 'u1'] }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/провенанс/i);
    expect(verdict.reasons.join(' ')).toContain('ghost');
  });
});

describe('clarify-проверка через пересечение, а не размер множества', () => {
  const q01m1 = {
    caseId: 'Q01-M1',
    expectedRuleIds: [1, 5],
    expectedDisposition: 'HOLD' as const,
  };
  const ctx = context({
    sourceRuleByUnitId: new Map([
      ['b1', 1],
      ['b5', 5],
      ['b8', 8],
    ]),
  });

  it('FAIL: выбрано ОДНО из конкурентов ПЛЮС посторонний unit — size=2, но intersection=1', () => {
    const verdict = gradeCase(
      q01m1,
      observed({
        caseId: 'Q01-M1',
        candidateUnitIds: ['b1', 'b5'],
        rerankedUnitIds: ['b1', 'b5'],
        selectedUnitIds: ['b1', 'b8'],
        disposition: 'HOLD',
        answer: undefined,
      }),
      ctx
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/наугад/i);
  });

  it('PASS: посторонний unit без конкурента среди выбранных — это не выбор наугад', () => {
    const verdict = gradeCase(
      q01m1,
      observed({
        caseId: 'Q01-M1',
        candidateUnitIds: ['b1', 'b5'],
        rerankedUnitIds: ['b1', 'b5'],
        selectedUnitIds: ['b8'],
        disposition: 'HOLD',
        answer: undefined,
      }),
      ctx
    );

    expect(verdict.reasons.join(' ')).not.toMatch(/наугад/i);
  });
});

describe('целостность trace: reranked ⊆ candidates ⊆ хранит выбранное', () => {
  it('FAIL: selected содержит unit вне rerankedUnitIds', () => {
    const verdict = gradeCase(
      expectation,
      observed({
        selectedUnitIds: ['u4a', 'phantom'],
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
    expect(verdict.reasons.join(' ')).toMatch(/целостность|trace/i);
  });

  it('FAIL: rerankedUnitIds содержит unit вне candidateUnitIds', () => {
    const verdict = gradeCase(
      expectation,
      observed({ rerankedUnitIds: ['u4a', 'u4b', 'u4c', 'u1', 'sneaky'] }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/целостность|trace/i);
  });

  it('FAIL: дубль unitId внутри одного массива', () => {
    const verdict = gradeCase(
      expectation,
      observed({ rerankedUnitIds: ['u4a', 'u4a', 'u4b', 'u4c', 'u1'] }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
  });
});

describe('verifyAnswerClaims вызывается ГРЕЙДЕРОМ, а не принимается на веру', () => {
  it('FAIL: draft ссылается на unit вне переданного evidence pack — грейдер это видит сам', () => {
    const verdict = gradeCase(
      expectation,
      observed({
        answer: {
          draft: {
            text: 'Не дольше 15 секунд.',
            citedUnitIds: ['u4a', 'НЕ_В_PACK'],
            answerSource: 'knowledge_base',
          },
          evidencePack: evidencePack(['u4a']),
        },
      }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/НЕ_В_PACK/);
  });

  it('FAIL: число в тексте не подтверждено evidence pack — грейдер сам это вычисляет', () => {
    const verdict = gradeCase(
      expectation,
      observed({
        answer: {
          draft: {
            text: 'Не дольше 999 секунд.',
            citedUnitIds: ['u4a'],
            answerSource: 'knowledge_base',
          },
          evidencePack: evidencePack(['u4a']),
        },
      }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toContain('999');
  });

  it('ожидался DIRECT_ANSWER, но answer отсутствует — явный провал, а не молчание', () => {
    const verdict = gradeCase(
      expectation,
      observed({ answer: undefined, rerankedUnitIds: ['u4a', 'u4b', 'u4c', 'u1'] }),
      context()
    );

    expect(verdict.result).toBe('FAIL');
    expect(verdict.reasons.join(' ')).toMatch(/синтезированного ответа нет/);
  });
});
