import { describe, expect, it } from 'vitest';
import { FACET_KEYS } from '../facets';
import {
  queryFrameSchema,
  UNKNOWN_QUERY_FACETS,
  UNKNOWN_TRIGGER_FACTS,
  type QueryFrame,
} from '../query-frame';
import {
  isTriggerFactKey,
  TRIGGER_FACT_KEYS,
  TRIGGER_FACT_REGISTRY,
  type TriggerFactKey,
} from '../trigger-facts';

const EVIDENCE = [{ source: 'CURRENT_MESSAGE', quote: 'нужен апостиль на диплом' }];

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    concepts: ['apostille'],
    facets: { ...UNKNOWN_QUERY_FACETS },
    triggerFacts: { ...UNKNOWN_TRIGGER_FACTS },
    questionAspects: ['PROCEDURE'],
    ambiguities: [],
    ...overrides,
  };
}

function isValid(input: unknown): boolean {
  return queryFrameSchema.safeParse(input).success;
}

describe('QueryFrame — форма контракта', () => {
  it('минимальный кадр «сигнала нет» валиден', () => {
    expect(isValid(frame())).toBe(true);
  });

  it('не содержит ни negation, ни missingRequiredFacets', () => {
    const fields = Object.keys(queryFrameSchema.shape);
    expect(fields).not.toContain('negation');
    expect(fields).not.toContain('missingRequiredFacets');
    expect(fields.sort()).toEqual(
      ['ambiguities', 'concepts', 'facets', 'questionAspects', 'triggerFacts'].sort()
    );
  });

  it('оба удалённых поля отвергаются, а не молча игнорируются', () => {
    // missingRequiredFacets вычисляет evaluateScope (PR B2) по requiredFacets
    // конкретного kind — у вопроса нет kind, поэтому в кадре его быть не может.
    expect(isValid(frame({ missingRequiredFacets: ['scenario'] }))).toBe(false);
    expect(isValid(frame({ negation: true }))).toBe(false);
  });

  it('отрицание живёт пофасетно, в exclude, а не одним глобальным флагом', () => {
    expect(
      isValid(
        frame({
          facets: {
            ...UNKNOWN_QUERY_FACETS,
            service: {
              state: 'KNOWN',
              include: ['legalization'],
              exclude: ['apostille'],
              evidence: EVIDENCE,
            },
          },
        })
      )
    ).toBe(true);
  });
});

describe('UNKNOWN имеет ровно одно представление', () => {
  it.each([...FACET_KEYS])('фасета %s обязана присутствовать явно', (key) => {
    const facets: Record<string, unknown> = { ...UNKNOWN_QUERY_FACETS };
    delete facets[key];
    // Пропущенный ключ был бы вторым способом сказать UNKNOWN: у вопроса нет
    // kind, значит нет и NOT_APPLICABLE, значит отсутствию нечего означать.
    expect(isValid(frame({ facets }))).toBe(false);
  });

  it.each([...TRIGGER_FACT_KEYS])('триггер-факт %s обязан присутствовать явно', (key) => {
    const triggerFacts: Record<string, unknown> = { ...UNKNOWN_TRIGGER_FACTS };
    delete triggerFacts[key];
    expect(isValid(frame({ triggerFacts }))).toBe(false);
  });

  it('KNOWN без единого значения — это UNKNOWN, записанный вторым способом', () => {
    expect(
      isValid(
        frame({
          facets: {
            ...UNKNOWN_QUERY_FACETS,
            scenario: { state: 'KNOWN', include: [], exclude: [], evidence: EVIDENCE },
          },
        })
      )
    ).toBe(false);
  });

  it('KNOWN без свидетельств не принимается', () => {
    expect(
      isValid(
        frame({
          facets: {
            ...UNKNOWN_QUERY_FACETS,
            scenario: { state: 'KNOWN', include: ['apostille'], exclude: [], evidence: [] },
          },
        })
      )
    ).toBe(false);
  });

  it('значение-строка "UNKNOWN" не является значением ни одного триггер-факта', () => {
    for (const key of TRIGGER_FACT_KEYS) {
      expect(TRIGGER_FACT_REGISTRY[key].valueSchema.safeParse('UNKNOWN').success).toBe(false);
    }
  });

  it('состояние UNKNOWN не несёт полезной нагрузки', () => {
    expect(
      isValid(
        frame({
          facets: {
            ...UNKNOWN_QUERY_FACETS,
            scenario: { state: 'UNKNOWN', include: ['apostille'] },
          },
        })
      )
    ).toBe(false);
  });
});

describe('триггер-факты — отдельный реестр, не фасеты', () => {
  it('ключи триггер-фактов не являются фасетами и наоборот', () => {
    expect([...TRIGGER_FACT_KEYS]).toEqual([
      'privacyContext',
      'consentStatus',
      'reachability',
      'helperPresent',
    ]);
    for (const key of TRIGGER_FACT_KEYS) {
      expect(FACET_KEYS as readonly string[]).not.toContain(key);
    }
    for (const key of FACET_KEYS) {
      expect(isTriggerFactKey(key)).toBe(false);
    }
  });

  it('«в автобусе» — публичное место, а не город доставки', () => {
    const parsed = queryFrameSchema.safeParse(
      frame({
        triggerFacts: {
          ...UNKNOWN_TRIGGER_FACTS,
          privacyContext: {
            state: 'KNOWN',
            value: 'PUBLIC',
            evidence: [{ source: 'CURRENT_MESSAGE', quote: 'прихватило в автобусе' }],
          },
        },
      })
    );
    expect(parsed.success).toBe(true);
    // Геооси остались без сигнала — ситуационный факт их не заполняет.
    expect(parsed.data?.facets.deliveryCity).toEqual({ state: 'UNKNOWN' });
  });

  it.each([
    ['privacyContext', 'PRIVATE', 'AT_HOME'],
    ['consentStatus', 'EXPLICIT', 'MAYBE'],
    ['reachability', 'LIMITED', 'SLOW'],
  ] as const)('%s принимает только объявленные значения', (key, good, bad) => {
    const factFrame = (value: unknown) =>
      isValid(
        frame({
          triggerFacts: {
            ...UNKNOWN_TRIGGER_FACTS,
            [key as TriggerFactKey]: { state: 'KNOWN', value, evidence: EVIDENCE },
          },
        })
      );
    expect(factFrame(good)).toBe(true);
    expect(factFrame(bad)).toBe(false);
  });

  it('helperPresent — булев факт, а не строка', () => {
    const factFrame = (value: unknown) =>
      isValid(
        frame({
          triggerFacts: {
            ...UNKNOWN_TRIGGER_FACTS,
            helperPresent: { state: 'KNOWN', value, evidence: EVIDENCE },
          },
        })
      );
    expect(factFrame(true)).toBe(true);
    expect(factFrame('true')).toBe(false);
  });

  it('неизвестный ключ триггер-факта отвергается', () => {
    expect(
      isValid(
        frame({
          triggerFacts: {
            ...UNKNOWN_TRIGGER_FACTS,
            onABus: { state: 'KNOWN', value: true, evidence: EVIDENCE },
          },
        })
      )
    ).toBe(false);
  });
});

describe('прочие поля кадра', () => {
  it('неизвестный ключ фасеты отвергается', () => {
    expect(isValid(frame({ facets: { ...UNKNOWN_QUERY_FACETS, issuerCountry: { state: 'UNKNOWN' } } })))
      .toBe(false);
  });

  it('questionAspects — закрытый список', () => {
    expect(isValid(frame({ questionAspects: ['PRICE', 'REQUIREMENT'] }))).toBe(true);
    expect(isValid(frame({ questionAspects: ['SMALLTALK'] }))).toBe(false);
  });

  it('разобранный кадр присваивается объявленному интерфейсу', () => {
    const parsed = queryFrameSchema.parse(frame());
    const typed: QueryFrame = parsed;
    expect(typed.facets.scenario).toEqual({ state: 'UNKNOWN' });
    expect(typed.triggerFacts.helperPresent).toEqual({ state: 'UNKNOWN' });
  });
});
