import { describe, expect, it } from 'vitest';
import { TRIGGER_REASON_CODES } from '../reasons';
import {
  evaluateTrigger,
  triggerConditionSchema,
  type TriggerCondition,
  type TriggerVerdict,
} from '../trigger';
import { TRIGGER_FACT_KEYS } from '../trigger-facts';
import { buildQuery, fact, known } from './helpers';

/**
 * ВЛАДЕЛЕЦ РЕШЕНИЯ: `evaluateTrigger`.
 * ПОКРЫВАЕТ: активацию `triggerCondition` — truth table §4.1 п.2 (Stage B) и
 * §6 в части разделения двух классов сигналов.
 *
 * Здесь НЕТ ни одной осевой матрицы §3 и ни одного правила разрешения
 * конфликтов §4.1 п.1/п.3: у них другие владельцы.
 */

const IN_PUBLIC: TriggerCondition = { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] };
const WITH_CONSENT: TriggerCondition = { all: [{ fact: 'consentStatus', equals: 'EXPLICIT' }] };
const LIMITED_REACH: TriggerCondition = { all: [{ fact: 'reachability', equals: 'LIMITED' }] };
const HELPER_THERE: TriggerCondition = { all: [{ fact: 'helperPresent', equals: true }] };

describe('§4.1 п.2 — одно условие на один факт', () => {
  const cases: ReadonlyArray<{
    label: string;
    condition: TriggerCondition;
    triggerFacts: Parameters<typeof buildQuery>[0] extends undefined
      ? never
      : NonNullable<Parameters<typeof buildQuery>[0]>['triggerFacts'];
    expected: TriggerVerdict;
    expectedReason: string;
  }> = [
    {
      label: 'место публичное, условие «в общественном месте»',
      condition: IN_PUBLIC,
      triggerFacts: { privacyContext: fact('PUBLIC') },
      expected: 'ACTIVE',
      expectedReason: 'privacyContext_satisfied',
    },
    {
      label: 'место приватное — условие достоверно не выполнено',
      condition: IN_PUBLIC,
      triggerFacts: { privacyContext: fact('PRIVATE') },
      expected: 'INACTIVE',
      expectedReason: 'privacyContext_violated',
    },
    {
      label: 'места не назвали — неизвестно, а не «не выполнено»',
      condition: IN_PUBLIC,
      triggerFacts: {},
      expected: 'UNKNOWN',
      expectedReason: 'privacyContext_unknown',
    },
    {
      label: 'согласие явное',
      condition: WITH_CONSENT,
      triggerFacts: { consentStatus: fact('EXPLICIT') },
      expected: 'ACTIVE',
      expectedReason: 'consentStatus_satisfied',
    },
    {
      label: 'согласия нет',
      condition: WITH_CONSENT,
      triggerFacts: { consentStatus: fact('ABSENT') },
      expected: 'INACTIVE',
      expectedReason: 'consentStatus_violated',
    },
    {
      label: 'про согласие не сказали',
      condition: WITH_CONSENT,
      triggerFacts: {},
      expected: 'UNKNOWN',
      expectedReason: 'consentStatus_unknown',
    },
    {
      label: 'подвижность ограничена',
      condition: LIMITED_REACH,
      triggerFacts: { reachability: fact('LIMITED') },
      expected: 'ACTIVE',
      expectedReason: 'reachability_satisfied',
    },
    {
      label: 'подвижность обычная',
      condition: LIMITED_REACH,
      triggerFacts: { reachability: fact('NORMAL') },
      expected: 'INACTIVE',
      expectedReason: 'reachability_violated',
    },
    {
      label: 'про подвижность не сказали',
      condition: LIMITED_REACH,
      triggerFacts: {},
      expected: 'UNKNOWN',
      expectedReason: 'reachability_unknown',
    },
    {
      label: 'помощник рядом',
      condition: HELPER_THERE,
      triggerFacts: { helperPresent: fact(true) },
      expected: 'ACTIVE',
      expectedReason: 'helperPresent_satisfied',
    },
    {
      label: 'помощника нет',
      condition: HELPER_THERE,
      triggerFacts: { helperPresent: fact(false) },
      expected: 'INACTIVE',
      expectedReason: 'helperPresent_violated',
    },
    {
      label: 'про помощника не сказали',
      condition: HELPER_THERE,
      triggerFacts: {},
      expected: 'UNKNOWN',
      expectedReason: 'helperPresent_unknown',
    },
  ];

  it.each(cases)('$label → $expected', ({ condition, triggerFacts, expected, expectedReason }) => {
    const decision = evaluateTrigger(condition, buildQuery({ triggerFacts }));

    expect(decision.verdict).toBe(expected);
    expect(decision.reasons).toContain(expectedReason);
    expect(decision.clauseVerdicts).toHaveLength(condition.all.length);
  });

  it('UNKNOWN населяет missingFacts, а не missingFacets — это разные понятия', () => {
    const decision = evaluateTrigger(IN_PUBLIC, buildQuery());

    expect(decision.missingFacts).toEqual(['privacyContext']);
    expect(decision.requiresClarification).toBe(true);
    expect(decision).not.toHaveProperty('missingFacets');
  });
});

describe('§4.1 п.2 — конъюнкция нескольких фактов', () => {
  const HELPER_WITH_CONSENT: TriggerCondition = {
    all: [
      { fact: 'helperPresent', equals: true },
      { fact: 'consentStatus', equals: 'EXPLICIT' },
    ],
  };

  it('оба выполнены → ACTIVE', () => {
    const decision = evaluateTrigger(
      HELPER_WITH_CONSENT,
      buildQuery({ triggerFacts: { helperPresent: fact(true), consentStatus: fact('EXPLICIT') } })
    );

    expect(decision.verdict).toBe('ACTIVE');
    expect(decision.satisfiedFacts).toEqual(['helperPresent', 'consentStatus']);
    expect(decision.missingFacts).toEqual([]);
  });

  it('один нарушен → INACTIVE, независимо от второго', () => {
    const decision = evaluateTrigger(
      HELPER_WITH_CONSENT,
      buildQuery({ triggerFacts: { helperPresent: fact(true), consentStatus: fact('ABSENT') } })
    );

    expect(decision.verdict).toBe('INACTIVE');
    expect(decision.violatedFacts).toEqual(['consentStatus']);
  });

  it('достоверно нарушенный факт перевешивает неизвестный — конъюнкция уже ложна', () => {
    const decision = evaluateTrigger(
      HELPER_WITH_CONSENT,
      buildQuery({ triggerFacts: { consentStatus: fact('ABSENT') } })
    );

    expect(decision.verdict).toBe('INACTIVE');
    expect(decision.violatedFacts).toEqual(['consentStatus']);
    expect(decision.missingFacts).toEqual(['helperPresent']);
  });

  it('один выполнен, второй неизвестен → UNKNOWN, а не ACTIVE', () => {
    const decision = evaluateTrigger(
      HELPER_WITH_CONSENT,
      buildQuery({ triggerFacts: { helperPresent: fact(true) } })
    );

    expect(decision.verdict).toBe('UNKNOWN');
    expect(decision.missingFacts).toEqual(['consentStatus']);
  });
});

describe('§6 — решение принимается ТОЛЬКО по triggerFacts', () => {
  /**
   * Живой пример §6: «прихватило в автобусе» — признак публичного места для
   * `triggerCondition`, а НЕ geography-фасета. Если evaluator подглядывает в
   * `facets`, эти две пары решений разойдутся.
   */
  it.each([
    { label: 'факт известен и совпал', triggerFacts: { privacyContext: fact('PUBLIC' as const) } },
    { label: 'факт известен и не совпал', triggerFacts: { privacyContext: fact('PRIVATE' as const) } },
    { label: 'факт неизвестен', triggerFacts: {} },
  ])('$label: facets не влияют на решение', ({ triggerFacts }) => {
    const withoutFacets = buildQuery({ triggerFacts });
    const withFacets = buildQuery({
      triggerFacts,
      facets: {
        deliveryCity: known(['spb']),
        scenario: known(['apostille.zags.spb']),
        documentForm: known(['ORIGINAL']),
      },
      concepts: ['apostille.zags'],
      questionAspects: ['DELIVERY'],
      ambiguities: ['место названо только в истории'],
    });

    expect(evaluateTrigger(IN_PUBLIC, withFacets)).toEqual(evaluateTrigger(IN_PUBLIC, withoutFacets));
  });

  it('никакая комбинация facets не активирует условие при неизвестном триггер-факте', () => {
    const decision = evaluateTrigger(
      IN_PUBLIC,
      buildQuery({ facets: { deliveryCity: known(['spb']), scenario: known(['apostille']) } })
    );

    expect(decision.verdict).toBe('UNKNOWN');
    expect(decision.verdict).not.toBe('ACTIVE');
    expect(decision.verdict).not.toBe('INACTIVE');
  });
});

describe('учебная фикстура — четыре сценария, ради которых поле triggerFacts и появилось', () => {
  it('Q05: «прихватило в автобусе» → исключение общественного места активно', () => {
    expect(
      evaluateTrigger(IN_PUBLIC, buildQuery({ triggerFacts: { privacyContext: fact('PUBLIC') } }))
        .verdict
    ).toBe('ACTIVE');
  });

  it('Q05-N1: «я дома один в ванной» → то же исключение НЕ действует', () => {
    const decision = evaluateTrigger(
      IN_PUBLIC,
      buildQuery({ triggerFacts: { privacyContext: fact('PRIVATE') } })
    );

    expect(decision.verdict).toBe('INACTIVE');
    expect(decision.reasons).toContain('privacyContext_violated');
  });

  it('Q05-M1: «что делать, если чешется» → места нет, вердикт UNKNOWN, а не выбор наугад', () => {
    const decision = evaluateTrigger(IN_PUBLIC, buildQuery());

    expect(decision.verdict).toBe('UNKNOWN');
    expect(decision.missingFacts).toEqual(['privacyContext']);
    expect(decision.requiresClarification).toBe(true);
  });

  it('Q09-N1: «раз она раньше не возражала» → текущего согласия нет, правило не применяется', () => {
    const decision = evaluateTrigger(
      WITH_CONSENT,
      buildQuery({ triggerFacts: { consentStatus: fact('ABSENT') } })
    );

    expect(decision.verdict).toBe('INACTIVE');
    expect(decision.violatedFacts).toEqual(['consentStatus']);
  });

  it('Q10 vs Q10-N1: ограниченная подвижность включает послабление, обычная — нет', () => {
    expect(
      evaluateTrigger(LIMITED_REACH, buildQuery({ triggerFacts: { reachability: fact('LIMITED') } }))
        .verdict
    ).toBe('ACTIVE');
    expect(
      evaluateTrigger(LIMITED_REACH, buildQuery({ triggerFacts: { reachability: fact('NORMAL') } }))
        .verdict
    ).toBe('INACTIVE');
  });
});

describe('контракт TriggerCondition', () => {
  it('условие выражено в терминах реестра триггер-фактов, а не свободным текстом', () => {
    for (const key of TRIGGER_FACT_KEYS) {
      const sample =
        key === 'privacyContext'
          ? 'PUBLIC'
          : key === 'consentStatus'
            ? 'EXPLICIT'
            : key === 'reachability'
              ? 'LIMITED'
              : true;
      expect(triggerConditionSchema.safeParse({ all: [{ fact: key, equals: sample }] }).success).toBe(
        true
      );
    }
  });

  it('пустое условие запрещено — исключение, активное всегда, перестаёт быть исключением', () => {
    expect(triggerConditionSchema.safeParse({ all: [] }).success).toBe(false);
  });

  it('пустое условие не активируется даже в обход схемы — вакуумная истина закрыта явно', () => {
    // Находка кросс-ревью: конъюнкция пустого списка истинна вакуумно, и
    // evaluateTrigger возвращал ACTIVE. Схема — не единственная линия обороны:
    // функция экспортируется, а тип `readonly TriggerClause[]` пустой массив
    // разрешает. Fail-closed в UNKNOWN, чтобы исключение удерживалось.
    const decision = evaluateTrigger({ all: [] }, buildQuery());

    expect(decision.verdict).toBe('UNKNOWN');
    expect(decision.verdict).not.toBe('ACTIVE');
    expect(decision.reasons).toEqual(['trigger_condition_empty']);
    // Спрашивать нечего: пробел в данных, а не в вопросе.
    expect(decision.missingFacts).toEqual([]);
    expect(decision.requiresClarification).toBe(false);
  });

  it('дубль факта запрещён — это либо копия, либо противоречие', () => {
    expect(
      triggerConditionSchema.safeParse({
        all: [
          { fact: 'privacyContext', equals: 'PUBLIC' },
          { fact: 'privacyContext', equals: 'PRIVATE' },
        ],
      }).success
    ).toBe(false);
  });

  it('факт вне реестра и значение вне enum — ошибка, а не тихий no-op', () => {
    expect(
      triggerConditionSchema.safeParse({ all: [{ fact: 'weather', equals: 'RAIN' }] }).success
    ).toBe(false);
    expect(
      triggerConditionSchema.safeParse({ all: [{ fact: 'privacyContext', equals: 'HOME' }] }).success
    ).toBe(false);
    // `UNKNOWN` не значение, а состояние: второго способа сказать «не знаем» нет.
    expect(
      triggerConditionSchema.safeParse({ all: [{ fact: 'privacyContext', equals: 'UNKNOWN' }] })
        .success
    ).toBe(false);
  });
});

describe('решение объясняет себя', () => {
  it('на каждое условие приходится ровно один код, и все коды — из реестра', () => {
    const decision = evaluateTrigger(
      {
        all: [
          { fact: 'privacyContext', equals: 'PUBLIC' },
          { fact: 'helperPresent', equals: true },
          { fact: 'reachability', equals: 'LIMITED' },
        ],
      },
      buildQuery({ triggerFacts: { privacyContext: fact('PUBLIC'), helperPresent: fact(false) } })
    );

    expect(decision.reasons).toHaveLength(3);
    for (const entry of decision.clauseVerdicts) {
      expect(entry.reason).toBe(`${entry.fact}_${entry.situation}`);
      expect(TRIGGER_REASON_CODES).toContain(entry.reason);
    }
    expect(decision.verdict).toBe('INACTIVE');
  });
});
