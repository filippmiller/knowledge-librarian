import { describe, expect, it } from 'vitest';
import { verifyAnswerClaims } from '../verify-answer-claims';
import type { EvidencePack } from '../evidence-pack';
import type { DraftAnswer } from '../draft-answer';

/**
 * План §3 PR H: «каждое число в ответе сверяется с `numericConstraint`
 * соответствующего unit'а»; «unsupported claim → кейс FAIL»; §0.3 №4:
 * «правильный ответ, полученный general-AI fallback'ом без найденного knowledge
 * unit, засчитывается как FAIL, не как успех».
 *
 * Это ДЕТЕРМИНИРОВАННЫЕ ворота: они не спрашивают модель, обоснован ли ответ.
 */

const pack = (overrides: Partial<EvidencePack> = {}): EvidencePack => ({
  items: [
    {
      unitId: 'u1',
      kind: 'PROCEDURE_STEP',
      statement: 'Не дольше 15 секунд подряд.',
      citation: { anchor: 'a1', quote: 'не дольше 15 секунд' },
      numericConstraint: { factKey: 'max_seconds', value: 15, unit: 'seconds' },
    },
  ],
  numericFacts: [{ factKey: 'max_seconds', value: 15, unit: 'seconds' }],
  ...overrides,
});

const draft = (overrides: Partial<DraftAnswer> = {}): DraftAnswer => ({
  text: 'Не дольше 15 секунд подряд.',
  citedUnitIds: ['u1'],
  answerSource: 'knowledge_base',
  ...overrides,
});

describe('verifyAnswerClaims — числа', () => {
  it('число, подтверждённое numericConstraint, проходит', () => {
    expect(verifyAnswerClaims(draft(), pack()).verified).toBe(true);
  });

  it('ЛОВИТ число, которого нет ни в одном выбранном unit', () => {
    const result = verifyAnswerClaims(draft({ text: 'Не дольше 25 секунд подряд.' }), pack());

    expect(result.verified).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain('unsupported_number');
    expect(result.violations[0].detail).toContain('25');
  });

  it('ловит выдуманное число рядом с верным — частичная галлюцинация', () => {
    const result = verifyAnswerClaims(
      draft({ text: 'Не дольше 15 секунд, максимум 7 циклов.' }),
      pack()
    );

    expect(result.verified).toBe(false);
    expect(result.violations.some((v) => v.detail.includes('7'))).toBe(true);
  });

  it('не считает нарушением маркеры нумерованного списка', () => {
    const result = verifyAnswerClaims(
      draft({ text: '1. Не дольше 15 секунд.\n2) Затем пауза.' }),
      pack()
    );

    expect(result.verified).toBe(true);
  });

  it('принимает дробное число, подтверждённое источником', () => {
    const fractional = pack({
      items: [
        {
          unitId: 'u1',
          kind: 'PROCEDURE_STEP',
          statement: 'Не дольше 2,5 секунды.',
          citation: { anchor: 'a1', quote: 'не дольше 2,5 секунды' },
          numericConstraint: { factKey: 'max_seconds', value: 2.5, unit: 'seconds' },
        },
      ],
      numericFacts: [{ factKey: 'max_seconds', value: 2.5, unit: 'seconds' }],
    });

    const result = verifyAnswerClaims(draft({ text: 'Не дольше 2.5 секунды.' }), fractional);

    expect(result.verified).toBe(true);
  });

  it('ответ без чисел при пустом numericFacts — законен', () => {
    const result = verifyAnswerClaims(
      draft({ text: 'Перейдите в уединённое место.' }),
      pack({ numericFacts: [] })
    );

    expect(result.verified).toBe(true);
  });
});

/**
 * Найдено независимыми ревью (Grok §1.3/§2.2/§2.4, Codex #1–#3) на этом срезе.
 * Ворота сверялись с голым значением `numericConstraint`, поэтому:
 * путали единицы, были слепы к числительным словами, и наказывали ответ за
 * добросовестный пересказ statement'а, в котором чисел больше, чем ограничений.
 */
describe('verifyAnswerClaims — заземление по паре (единица, значение)', () => {
  it('ЛОВИТ подмену единицы при верном числе', () => {
    const result = verifyAnswerClaims(draft({ text: 'Не дольше 15 минут подряд.' }), pack());

    expect(result.verified).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain('unsupported_number');
  });

  it('ЛОВИТ галлюцинацию, выраженную числительным словом', () => {
    const result = verifyAnswerClaims(draft({ text: 'Не дольше двадцати секунд.' }), pack());

    expect(result.verified).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain('unsupported_number');
  });

  it('принимает верное число, названное словом', () => {
    const result = verifyAnswerClaims(draft({ text: 'Не дольше пятнадцати секунд.' }), pack());

    expect(result.verified).toBe(true);
  });

  it('не наказывает за добросовестный пересказ statement с несколькими числами', () => {
    const multi = pack({
      items: [
        {
          unitId: 'u1',
          kind: 'PROCEDURE_STEP',
          statement:
            'Непрерывное почёсывание допускается не дольше 15 секунд, после чего требуется пауза не менее 30 секунд.',
          citation: { anchor: 'a1', quote: 'не дольше 15 секунд' },
          numericConstraint: { factKey: 'max_seconds', value: 15, unit: 'seconds' },
        },
      ],
      numericFacts: [{ factKey: 'max_seconds', value: 15, unit: 'seconds' }],
    });

    const result = verifyAnswerClaims(
      draft({ text: 'Не дольше 15 секунд, затем пауза 30 секунд.' }),
      multi
    );

    expect(result.verified).toBe(true);
  });

  it('не считает утверждением дату, время и номер пункта', () => {
    const result = verifyAnswerClaims(
      draft({ text: 'Согласно пункту 4.2 от 07.08.2026, в 15:30 — не дольше 15 секунд.' }),
      pack()
    );

    expect(result.verified).toBe(true);
  });
});

describe('verifyAnswerClaims — цитаты', () => {
  it('ловит цитату на unit, которого нет в evidence pack', () => {
    const result = verifyAnswerClaims(draft({ citedUnitIds: ['u1', 'u404'] }), pack());

    expect(result.verified).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain('unknown_citation');
    expect(result.violations.some((v) => v.detail.includes('u404'))).toBe(true);
  });

  it('ловит ответ вообще без цитат', () => {
    const result = verifyAnswerClaims(draft({ citedUnitIds: [] }), pack());

    expect(result.verified).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain('uncited_answer');
  });
});

describe('verifyAnswerClaims — источник ответа (ворота §0.3 №4)', () => {
  it('general_ai — автоматический провал, даже если текст верен', () => {
    const result = verifyAnswerClaims(draft({ answerSource: 'general_ai' }), pack());

    expect(result.verified).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain('forbidden_answer_source');
  });

  it('deterministic_guardrail тоже не является ответом из базы знаний', () => {
    const result = verifyAnswerClaims(draft({ answerSource: 'deterministic_guardrail' }), pack());

    expect(result.verified).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain('forbidden_answer_source');
  });

  it('knowledge_base проходит', () => {
    expect(verifyAnswerClaims(draft(), pack()).verified).toBe(true);
  });
});

describe('verifyAnswerClaims — отчётность', () => {
  it('сообщает ВСЕ нарушения сразу, а не первое', () => {
    const result = verifyAnswerClaims(
      draft({ text: 'Ровно 99 секунд.', citedUnitIds: [], answerSource: 'general_ai' }),
      pack()
    );

    expect(new Set(result.violations.map((v) => v.code))).toEqual(
      new Set(['unsupported_number', 'uncited_answer', 'forbidden_answer_source'])
    );
  });

  it('пустой текст ответа — нарушение, а не молчаливый успех', () => {
    const result = verifyAnswerClaims(draft({ text: '   ' }), pack());

    expect(result.verified).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain('empty_answer');
  });
});
