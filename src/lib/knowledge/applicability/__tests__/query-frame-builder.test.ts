import { describe, expect, it } from 'vitest';
import {
  buildQueryFrame,
  type ConversationMessage,
  type RawQueryExtraction,
} from '../query-frame-builder';

/**
 * PR D acceptance criteria (Beads translation-r35 / plan §3 PR D):
 * - никогда не придумывает facet-значение, отсутствующее и в сообщении, и в истории;
 * - 'не апостиль, а легализация' -> exclude:[...], не глобальный флаг;
 * - композитный вопрос даёт >1 questionAspect;
 * - факт из истории не становится UNKNOWN, если отсутствует в последнем сообщении;
 * - конфликт текущего сообщения с историей попадает в ambiguities, текущее побеждает.
 */

/**
 * `text` — намеренно широкий, содержит буквально КАЖДУЮ цитату (`quote`),
 * используемую тестами ниже с этим `messageId` — pre-retrieval hardening,
 * Step 5: `buildQueryFrame` теперь требует, чтобы `quote` была настоящей
 * подстрокой текста referenced-сообщения (раньше проверялось только
 * непустое `quote`, дословность не проверялась вообще). Один общий фикстур
 * дешевле, чем переписывать text под каждый тест по отдельности.
 */
const CURRENT: ConversationMessage = {
  id: 'm2',
  role: 'user',
  text: [
    'сколько стоит апостиль в СПб?',
    'не апостиль',
    'легализация',
    'апостиль тоже',
    'перевод',
    'муж рядом',
    'она согласна',
    '???',
    'на улице',
    'дома',
    'апостиль на загс спб',
    'загс',
    'из России',
  ].join(' '),
};
const HISTORY_MSG: ConversationMessage = {
  id: 'm1',
  role: 'user',
  text: [
    'нужен апостиль на диплом',
    'свидетельство ЗАГС',
    'перевод',
    'апостиль в СПб',
    'в автобусе',
    'без согласия',
  ].join(' '),
};

function extraction(overrides: Partial<RawQueryExtraction> = {}): RawQueryExtraction {
  return {
    facetMentions: [],
    triggerFactMentions: [],
    questionAspects: ['PRICE'],
    ...overrides,
  };
}

describe('facet — никогда не придумывает значение', () => {
  it('без единого упоминания facet остаётся UNKNOWN', () => {
    const frame = buildQueryFrame(extraction(), [CURRENT]);
    expect(frame.facets.service).toEqual({ state: 'UNKNOWN' });
  });

  it('нераспознаваемый rawValue (нет в реестре) отбрасывается — UNKNOWN, а не выдуманное значение', () => {
    const frame = buildQueryFrame(
      extraction({
        facetMentions: [
          {
            facet: 'service',
            polarity: 'INCLUDE',
            rawValue: 'выдуманная_услуга',
            messageId: CURRENT.id,
            quote: 'выдуманная услуга',
          },
        ],
      }),
      [CURRENT]
    );
    expect(frame.facets.service).toEqual({ state: 'UNKNOWN' });
  });

  it('реальное, но НЕОДНОЗНАЧНОЕ слово ("апостиль" — есть apostille_spb/moscow/education) не резолвится сама по себе', () => {
    // SERVICE_CONCEPTS сознательно не даёт "апостиль" алиасом ни одному
    // конкретному id (concept-registry.ts) — угадать между тремя одинаково
    // правдоподобными было бы придумыванием, а не распознаванием.
    const frame = buildQueryFrame(
      extraction({
        facetMentions: [
          {
            facet: 'service',
            polarity: 'INCLUDE',
            rawValue: 'апостиль',
            messageId: CURRENT.id,
            quote: 'апостиль',
          },
        ],
      }),
      [CURRENT]
    );
    expect(frame.facets.service).toEqual({ state: 'UNKNOWN' });
  });
});

describe('facet — значение из текущего сообщения', () => {
  it('известная услуга в текущем сообщении даёт KNOWN с evidence CURRENT_MESSAGE', () => {
    const frame = buildQueryFrame(
      extraction({
        facetMentions: [
          {
            facet: 'service',
            polarity: 'INCLUDE',
            // Каноничный id напрямую: модели даётся SERVICE_CONCEPTS как
            // контекст, и она вправе отдать id, когда уверена. Общее слово
            // «апостиль» намеренно НЕ алиас ни одной конкретной услуги в
            // реестре (apostille_spb/moscow/education неоднозначны) — это
            // проверяет соседний describe-блок с 'выдуманная_услуга'.
            rawValue: 'apostille_spb',
            messageId: CURRENT.id,
            quote: 'апостиль в СПб',
          },
        ],
      }),
      [CURRENT]
    );
    expect(frame.facets.service.state).toBe('KNOWN');
    if (frame.facets.service.state === 'KNOWN') {
      expect(frame.facets.service.include).toEqual(['apostille_spb']);
      expect(frame.facets.service.exclude).toEqual([]);
      expect(frame.facets.service.evidence).toEqual([
        { source: 'CURRENT_MESSAGE', messageId: CURRENT.id, quote: 'апостиль в СПб' },
      ]);
    }
  });
});

describe("'не апостиль, а легализация' — exclude пофасетно, не глобальный флаг", () => {
  it('EXCLUDE-упоминание попадает в exclude, INCLUDE — в include, на одной фасете', () => {
    const frame = buildQueryFrame(
      extraction({
        facetMentions: [
          {
            facet: 'service',
            polarity: 'EXCLUDE',
            rawValue: 'apostille_spb',
            messageId: CURRENT.id,
            quote: 'не апостиль',
          },
          {
            facet: 'service',
            polarity: 'INCLUDE',
            rawValue: 'консульская легализация',
            messageId: CURRENT.id,
            quote: 'легализация',
          },
        ],
      }),
      [CURRENT]
    );
    expect(frame.facets.service.state).toBe('KNOWN');
    if (frame.facets.service.state === 'KNOWN') {
      expect(frame.facets.service.include).toEqual(['consular_legalization']);
      expect(frame.facets.service.exclude).toEqual(['apostille_spb']);
    }
  });
});

describe('одно и то же значение как INCLUDE и EXCLUDE одновременно — самопротиворечие, не контракт', () => {
  it('одинаковый resolved-value с обеими полярностями в одном сообщении не должен оказаться сразу в include и в exclude', () => {
    // queryFacetStateSchema (query-frame.ts) явно запрещает пересечение
    // include/exclude — если это здесь не поймать, buildQueryFrame отдаёт
    // объект, который его же собственная схема не проходит.
    const frame = buildQueryFrame(
      extraction({
        facetMentions: [
          {
            facet: 'service',
            polarity: 'INCLUDE',
            rawValue: 'apostille_spb',
            messageId: CURRENT.id,
            quote: 'апостиль',
          },
          {
            facet: 'service',
            polarity: 'EXCLUDE',
            rawValue: 'apostille_spb',
            messageId: CURRENT.id,
            quote: 'не апостиль',
          },
        ],
      }),
      [CURRENT]
    );
    const service = frame.facets.service;
    if (service.state === 'KNOWN') {
      const overlap = service.exclude.filter((v) => service.include.includes(v));
      expect(overlap).toEqual([]);
    }
    expect(frame.ambiguities.some((a) => a.includes('service'))).toBe(true);
  });
});

describe('факт из истории не становится UNKNOWN — регрессионный тест', () => {
  it('facet есть только в истории (не в текущем) -> KNOWN, evidence HISTORY', () => {
    const frame = buildQueryFrame(
      extraction({
        facetMentions: [
          {
            facet: 'documentType',
            polarity: 'INCLUDE',
            rawValue: 'загс',
            messageId: HISTORY_MSG.id,
            quote: 'свидетельство ЗАГС',
          },
        ],
      }),
      [HISTORY_MSG, CURRENT]
    );
    expect(frame.facets.documentType.state).toBe('KNOWN');
    if (frame.facets.documentType.state === 'KNOWN') {
      expect(frame.facets.documentType.include).toEqual(['zags']);
      expect(frame.facets.documentType.evidence[0]).toMatchObject({
        source: 'HISTORY',
        messageId: HISTORY_MSG.id,
      });
    }
  });
});

describe('additive vs replacement — история и текущее сообщение (pre-retrieval hardening, Step 6)', () => {
  it('текущее упоминает НОВОЕ значение facet, НЕ повторяя значение из истории -> ОБА сохраняются аддитивно, НЕ конфликт (буквальный пример плана: "нужен перевод" + "и апостиль тоже", текущее не переспрашивает перевод)', () => {
    // Раньше (до Step 6) это ошибочно считалось конфликтом: winning = current
    // ТОЛЬКО, когда current непусто, поэтому 'перевод' из истории тихо
    // терялся, а ambiguities получал ложное "текущее противоречит истории" —
    // хотя текущее сообщение вообще не высказывалось о переводе, только
    // ДОБАВИЛО апостиль.
    const frame = buildQueryFrame(
      extraction({
        facetMentions: [
          {
            facet: 'service',
            polarity: 'INCLUDE',
            rawValue: 'перевод',
            messageId: HISTORY_MSG.id,
            quote: 'перевод',
          },
          {
            facet: 'service',
            polarity: 'INCLUDE',
            rawValue: 'apostille_spb',
            messageId: CURRENT.id,
            quote: 'апостиль в СПб',
          },
        ],
      }),
      [HISTORY_MSG, CURRENT]
    );
    expect(frame.facets.service.state).toBe('KNOWN');
    if (frame.facets.service.state === 'KNOWN') {
      expect([...frame.facets.service.include].sort()).toEqual(['apostille_spb', 'translation']);
    }
    expect(frame.ambiguities).toEqual([]);
  });

  it('текущее ЯВНО исключает значение, известное из истории, и добавляет замену -> история НЕ выигрывает, значение исключено, не включено (буквальный пример плана: "нужен апостиль" + "нет, не апостиль, а легализация")', () => {
    // Настоящая замена — это явное EXCLUDE того же значения, не просто
    // "текущее сказало что-то другое". "always union history" здесь был бы
    // неверным фиксом: apostille_spb обязан оказаться в exclude, а не
    // остаться в include только потому что история его когда-то включала.
    const frame = buildQueryFrame(
      extraction({
        facetMentions: [
          {
            facet: 'service',
            polarity: 'INCLUDE',
            rawValue: 'apostille_spb',
            messageId: HISTORY_MSG.id,
            quote: 'апостиль в СПб',
          },
          {
            facet: 'service',
            polarity: 'EXCLUDE',
            rawValue: 'apostille_spb',
            messageId: CURRENT.id,
            quote: 'не апостиль',
          },
          {
            facet: 'service',
            polarity: 'INCLUDE',
            rawValue: 'консульская легализация',
            messageId: CURRENT.id,
            quote: 'легализация',
          },
        ],
      }),
      [HISTORY_MSG, CURRENT]
    );
    expect(frame.facets.service.state).toBe('KNOWN');
    if (frame.facets.service.state === 'KNOWN') {
      expect(frame.facets.service.include).not.toContain('apostille_spb');
      expect(frame.facets.service.exclude).toContain('apostille_spb');
      expect(frame.facets.service.include).toContain('consular_legalization');
    }
  });

  it('текущее сообщение ДОБАВЛЯЕТ значение поверх истории (не заменяет) — НЕ конфликт', () => {
    // История: "нужен перевод". Текущее: "и апостиль тоже нужен" — сохраняет
    // то, что уже было известно, и добавляет новое. Это накопление
    // информации, а не противоречие "апостиль ВМЕСТО перевода".
    const frame = buildQueryFrame(
      extraction({
        facetMentions: [
          {
            facet: 'service',
            polarity: 'INCLUDE',
            rawValue: 'перевод',
            messageId: HISTORY_MSG.id,
            quote: 'перевод',
          },
          {
            facet: 'service',
            polarity: 'INCLUDE',
            rawValue: 'перевод',
            messageId: CURRENT.id,
            quote: 'перевод',
          },
          {
            facet: 'service',
            polarity: 'INCLUDE',
            rawValue: 'apostille_spb',
            messageId: CURRENT.id,
            quote: 'апостиль тоже',
          },
        ],
      }),
      [HISTORY_MSG, CURRENT]
    );
    const service = frame.facets.service;
    expect(service.state).toBe('KNOWN');
    if (service.state === 'KNOWN') {
      expect([...service.include].sort()).toEqual(['apostille_spb', 'translation']);
    }
    expect(frame.ambiguities).toEqual([]);
  });

  it('одно и то же значение в истории и в текущем — НЕ конфликт', () => {
    const frame = buildQueryFrame(
      extraction({
        facetMentions: [
          {
            facet: 'service',
            polarity: 'INCLUDE',
            rawValue: 'apostille_spb',
            messageId: HISTORY_MSG.id,
            quote: 'апостиль в СПб',
          },
          {
            facet: 'service',
            polarity: 'INCLUDE',
            rawValue: 'apostille_spb',
            messageId: CURRENT.id,
            quote: 'апостиль',
          },
        ],
      }),
      [HISTORY_MSG, CURRENT]
    );
    expect(frame.facets.service).toMatchObject({ state: 'KNOWN', include: ['apostille_spb'] });
    expect(frame.ambiguities).toEqual([]);
  });
});

describe('triggerFacts — тот же приоритет источников, что и facets', () => {
  it('без упоминания -> UNKNOWN', () => {
    const frame = buildQueryFrame(extraction(), [CURRENT]);
    expect(frame.triggerFacts.helperPresent).toEqual({ state: 'UNKNOWN' });
  });

  it('только в истории -> KNOWN, evidence HISTORY, не становится UNKNOWN', () => {
    const frame = buildQueryFrame(
      extraction({
        triggerFactMentions: [
          {
            fact: 'privacyContext',
            rawValue: 'PUBLIC',
            messageId: HISTORY_MSG.id,
            quote: 'в автобусе',
          },
        ],
      }),
      [HISTORY_MSG, CURRENT]
    );
    expect(frame.triggerFacts.privacyContext).toMatchObject({
      state: 'KNOWN',
      value: 'PUBLIC',
      evidence: [{ source: 'HISTORY', messageId: HISTORY_MSG.id, quote: 'в автобусе' }],
    });
  });

  it('helperPresent: "true"/"false" текстом распознаётся в boolean', () => {
    const frame = buildQueryFrame(
      extraction({
        triggerFactMentions: [
          { fact: 'helperPresent', rawValue: 'true', messageId: CURRENT.id, quote: 'муж рядом' },
        ],
      }),
      [CURRENT]
    );
    expect(frame.triggerFacts.helperPresent).toMatchObject({ state: 'KNOWN', value: true });
  });

  it('конфликт текущего с историей по триггер-факту -> ambiguities, текущее побеждает', () => {
    const frame = buildQueryFrame(
      extraction({
        triggerFactMentions: [
          {
            fact: 'consentStatus',
            rawValue: 'ABSENT',
            messageId: HISTORY_MSG.id,
            quote: 'без согласия',
          },
          {
            fact: 'consentStatus',
            rawValue: 'EXPLICIT',
            messageId: CURRENT.id,
            quote: 'она согласна',
          },
        ],
      }),
      [HISTORY_MSG, CURRENT]
    );
    expect(frame.triggerFacts.consentStatus).toMatchObject({ state: 'KNOWN', value: 'EXPLICIT' });
    expect(frame.ambiguities.some((a) => a.includes('consentStatus'))).toBe(true);
  });

  it('нераспознаваемое значение триггер-факта отбрасывается — не выдумывается', () => {
    const frame = buildQueryFrame(
      extraction({
        triggerFactMentions: [
          {
            fact: 'reachability',
            rawValue: 'ЧТО-ТО НЕПОНЯТНОЕ',
            messageId: CURRENT.id,
            quote: '???',
          },
        ],
      }),
      [CURRENT]
    );
    expect(frame.triggerFacts.reachability).toEqual({ state: 'UNKNOWN' });
  });

  it('два противоречащих упоминания ОДНОГО факта в ОДНОМ текущем сообщении -> ambiguities, не тихий выбор', () => {
    const frame = buildQueryFrame(
      extraction({
        triggerFactMentions: [
          { fact: 'privacyContext', rawValue: 'PUBLIC', messageId: CURRENT.id, quote: 'на улице' },
          { fact: 'privacyContext', rawValue: 'PRIVATE', messageId: CURRENT.id, quote: 'дома' },
        ],
      }),
      [CURRENT]
    );
    expect(frame.triggerFacts.privacyContext.state).toBe('KNOWN');
    expect(frame.ambiguities.some((a) => a.includes('privacyContext'))).toBe(true);
  });
});

describe('messageId не из разговора — упоминание не учитывается', () => {
  it('facet-упоминание с чужим messageId отбрасывается, не притворяется историей', () => {
    const frame = buildQueryFrame(
      extraction({
        facetMentions: [
          {
            facet: 'service',
            polarity: 'INCLUDE',
            rawValue: 'apostille_spb',
            messageId: 'm-999-не-существует',
            quote: 'апостиль',
          },
        ],
      }),
      [HISTORY_MSG, CURRENT]
    );
    expect(frame.facets.service).toEqual({ state: 'UNKNOWN' });
  });
});

describe('buildQueryFrame — trust boundary: messageId и quote (pre-retrieval hardening, Step 5)', () => {
  it('пустой (пробельный) message.id — бросает', () => {
    const messages: ConversationMessage[] = [{ id: '   ', role: 'user', text: 'нужен перевод' }];
    expect(() => buildQueryFrame(extraction(), messages)).toThrow(/id/i);
  });

  it('дубль message.id в разговоре — бросает (сообщения неразличимы)', () => {
    const messages: ConversationMessage[] = [
      { id: 'dup', role: 'user', text: 'нужен перевод' },
      { id: 'dup', role: 'user', text: 'и апостиль тоже' },
    ];
    expect(() => buildQueryFrame(extraction(), messages)).toThrow(/id/i);
  });

  it('quote — НЕ дословная подстрока текста referenced-сообщения (сфабрикованная цитата) с РЕАЛЬНЫМ messageId -> mention отбрасывается, не доезжает до QueryFrame', () => {
    const frame = buildQueryFrame(
      extraction({
        facetMentions: [
          {
            facet: 'service',
            polarity: 'INCLUDE',
            rawValue: 'apostille_spb',
            messageId: CURRENT.id,
            quote: 'этой фразы нет в сообщении вообще',
          },
        ],
      }),
      [CURRENT]
    );
    expect(frame.facets.service).toEqual({ state: 'UNKNOWN' });
  });

  it('quote — дословная подстрока -> mention принимается как раньше (regression guard: quote-проверка не ломает легитимные упоминания)', () => {
    const frame = buildQueryFrame(
      extraction({
        facetMentions: [
          {
            facet: 'service',
            polarity: 'INCLUDE',
            rawValue: 'apostille_spb',
            messageId: CURRENT.id,
            quote: 'апостиль в СПб',
          },
        ],
      }),
      [CURRENT]
    );
    expect(frame.facets.service.state).toBe('KNOWN');
  });

  it('та же защита для triggerFactMentions — сфабрикованная цитата отбрасывается', () => {
    const frame = buildQueryFrame(
      extraction({
        triggerFactMentions: [
          {
            fact: 'helperPresent',
            rawValue: 'true',
            messageId: CURRENT.id,
            quote: 'выдуманная цитата, которой нет в тексте',
          },
        ],
      }),
      [CURRENT]
    );
    expect(frame.triggerFacts.helperPresent).toEqual({ state: 'UNKNOWN' });
  });
});

describe('questionAspects — композитный вопрос даёт больше одного aspect', () => {
  it('передаёт все aspects из извлечения, без дублей', () => {
    const frame = buildQueryFrame(
      extraction({ questionAspects: ['PRICE', 'REQUIREMENT', 'PRICE'] }),
      [CURRENT]
    );
    expect([...frame.questionAspects].sort()).toEqual(['PRICE', 'REQUIREMENT']);
  });
});

describe('concepts — объединение резолвленных значений concept-фасет', () => {
  it('service и documentType, оба известные, попадают в concepts без дублей', () => {
    const frame = buildQueryFrame(
      extraction({
        facetMentions: [
          {
            facet: 'service',
            polarity: 'INCLUDE',
            rawValue: 'apostille_spb',
            messageId: CURRENT.id,
            quote: 'апостиль',
          },
          {
            facet: 'documentType',
            polarity: 'INCLUDE',
            rawValue: 'загс',
            messageId: CURRENT.id,
            quote: 'загс',
          },
        ],
      }),
      [CURRENT]
    );
    expect([...frame.concepts].sort()).toEqual(['apostille_spb', 'zags']);
  });

  it('scenario (не concept-словарь) не попадает в concepts', () => {
    const frame = buildQueryFrame(
      extraction({
        facetMentions: [
          {
            facet: 'scenario',
            polarity: 'INCLUDE',
            rawValue: 'apostille.zags.spb',
            messageId: CURRENT.id,
            quote: 'апостиль на загс спб',
          },
        ],
      }),
      [CURRENT]
    );
    expect(frame.concepts).toEqual([]);
  });

  it('страновой код (ЗАГЛАВНЫМИ, COUNTRY_CONCEPTS) НЕ попадает в concepts — сломал бы queryFrameSchema (conceptIdSchema требует lowercase)', () => {
    const frame = buildQueryFrame(
      extraction({
        facetMentions: [
          {
            facet: 'issuingCountry',
            polarity: 'INCLUDE',
            rawValue: 'RU',
            messageId: CURRENT.id,
            quote: 'из России',
          },
        ],
      }),
      [CURRENT]
    );
    expect(frame.facets.issuingCountry).toMatchObject({ state: 'KNOWN', include: ['RU'] });
    expect(frame.concepts).toEqual([]);
  });

  it('EXCLUDE-значение не попадает в concepts — отрицание не делает значение концептом интереса', () => {
    const frame = buildQueryFrame(
      extraction({
        facetMentions: [
          {
            facet: 'service',
            polarity: 'EXCLUDE',
            rawValue: 'apostille_spb',
            messageId: CURRENT.id,
            quote: 'не апостиль',
          },
          {
            facet: 'service',
            polarity: 'INCLUDE',
            rawValue: 'консульская легализация',
            messageId: CURRENT.id,
            quote: 'легализация',
          },
        ],
      }),
      [CURRENT]
    );
    expect(frame.concepts).toEqual(['consular_legalization']);
  });
});

describe('пустая история — работает как единственное сообщение', () => {
  it('messages из одного текущего сообщения — валидно', () => {
    const frame = buildQueryFrame(extraction(), [CURRENT]);
    expect(frame.facets.scenario).toEqual({ state: 'UNKNOWN' });
  });

  it('пустой массив messages — ошибка: у QueryFrame обязано быть текущее сообщение', () => {
    expect(() => buildQueryFrame(extraction(), [])).toThrow();
  });
});
