import { describe, expect, it } from 'vitest';
import {
  extractedKnowledgeUnitSchema,
  numericConstraintSchema,
  sourceSpanSchema,
} from '../extraction';

/**
 * PR E acceptance criteria (Beads translation-ypp / plan §3 PR E):
 * - statement непуст для каждого unit'а;
 * - facets типобезопасны (key-specific mapped type, не Record<FacetKey,FacetValue>);
 * - evidenceByField минимум для statement/facets/triggerCondition/numericConstraint.
 */

const VALID_SOURCE_SPAN = { anchor: 'block-3', quote: 'не более 3 дней подряд' };

function validUnit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'Раздражение кожи проходит не более чем за 3 дня подряд.',
    facets: { scenario: 'apostille.zags.spb' },
    triggerCondition: null,
    numericConstraint: null,
    extractionRef: 'u1',
    parentExtractionRef: null,
    sourceSpan: VALID_SOURCE_SPAN,
    evidenceByField: { statement: VALID_SOURCE_SPAN, facets: VALID_SOURCE_SPAN },
    uncertainties: [],
    ...overrides,
  };
}

describe('uncertainties — ключ ПРОПУЩЕН целиком (не []), тот же класс LLM-выдачи, что уже нормализован для triggerCondition/numericConstraint', () => {
  // Живой прогон против openai/gpt-4o (goal-shift benchmark, 2026-08-09):
  // модель СИСТЕМАТИЧЕСКИ (6 из 6 попыток) не включала ключ uncertainties в
  // JSON вовсе, хотя промпт требует его всегда (даже пустым массивом).
  // triggerCondition/numericConstraint уже получили `.nullish().transform(v
  // => v ?? null)` за ровно то же поведение — uncertainties отставал.
  it('unit без ключа uncertainties -> валиден, uncertainties становится []', () => {
    const { uncertainties: _omitted, ...withoutUncertainties } = validUnit();
    const parsed = extractedKnowledgeUnitSchema.safeParse(withoutUncertainties);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.uncertainties).toEqual([]);
  });

  it('unit с uncertainties: null -> тоже валиден, становится []', () => {
    const parsed = extractedKnowledgeUnitSchema.safeParse(validUnit({ uncertainties: null }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.uncertainties).toEqual([]);
  });

  it('unit с реальными uncertainties — не подменяются пустым массивом', () => {
    const real = [{ kind: 'OTHER' as const, description: 'находка', quote: 'x' }];
    const parsed = extractedKnowledgeUnitSchema.safeParse(validUnit({ uncertainties: real }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.uncertainties).toEqual(real);
  });
});

describe('facets — значение null (не {}), тот же класс LLM-выдачи (goal-shift benchmark, 2026-08-09, openai/gpt-4o: facets: null на первой попытке)', () => {
  it('unit с facets: null -> валиден, facets становится {}', () => {
    const parsed = extractedKnowledgeUnitSchema.safeParse(validUnit({ facets: null }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.facets).toEqual({});
  });

  it('unit с реальными facets — не подменяются пустым объектом', () => {
    const real = { scenario: 'apostille.zags.spb' };
    const parsed = extractedKnowledgeUnitSchema.safeParse(validUnit({ facets: real }));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.facets).toEqual(real);
  });
});

describe('sourceSpanSchema', () => {
  it('принимает непустые anchor и quote', () => {
    expect(sourceSpanSchema.safeParse(VALID_SOURCE_SPAN).success).toBe(true);
  });

  it.each(['', ' ', '\t'])('отвергает пустой по смыслу anchor (%j)', (blank) => {
    expect(sourceSpanSchema.safeParse({ ...VALID_SOURCE_SPAN, anchor: blank }).success).toBe(
      false
    );
  });

  it.each(['', ' '])('отвергает пустую по смыслу quote (%j)', (blank) => {
    expect(sourceSpanSchema.safeParse({ ...VALID_SOURCE_SPAN, quote: blank }).success).toBe(
      false
    );
  });
});

describe('numericConstraintSchema — форма из resolution.ts (B2), не отдельная копия', () => {
  it('factKey/value/unit — валидная форма', () => {
    expect(
      numericConstraintSchema.safeParse({
        factKey: 'максимум суток непрерывного раздражения',
        value: 3,
        unit: 'сутки',
      }).success
    ).toBe(true);
  });

  it.each(['', ' '])('пустой по смыслу factKey (%j) отвергается', (blank) => {
    expect(
      numericConstraintSchema.safeParse({ factKey: blank, value: 3, unit: 'сутки' }).success
    ).toBe(false);
  });

  it('лишнее поле (например, operator из другого дизайна) отвергается — strictObject', () => {
    expect(
      numericConstraintSchema.safeParse({
        factKey: 'x',
        value: 3,
        unit: 'сутки',
        operator: 'AT_MOST',
      }).success
    ).toBe(false);
  });
});

describe('extractedKnowledgeUnitSchema — statement непуст', () => {
  it('валидный unit проходит', () => {
    expect(extractedKnowledgeUnitSchema.safeParse(validUnit()).success).toBe(true);
  });

  it.each(['', '   '])('пустой по смыслу statement (%j) отвергается', (blank) => {
    expect(extractedKnowledgeUnitSchema.safeParse(validUnit({ statement: blank })).success).toBe(
      false
    );
  });
});

describe('extractedKnowledgeUnitSchema — facets типобезопасны (key-specific)', () => {
  it('значение НЕ того типа для ключа отвергается (documentForm получает id страны)', () => {
    const result = extractedKnowledgeUnitSchema.safeParse(
      validUnit({ facets: { documentForm: 'RU' } })
    );
    expect(result.success).toBe(false);
  });

  it('неизвестный ключ фасеты отвергается — strictObject, не молчаливое игнорирование', () => {
    const result = extractedKnowledgeUnitSchema.safeParse(
      validUnit({ facets: { issuerCountry: 'RU' } })
    );
    expect(result.success).toBe(false);
  });

  it('реальный service-концепт на своей оси проходит', () => {
    const result = extractedKnowledgeUnitSchema.safeParse(
      validUnit({ kind: 'PRICE_RULE', facets: { scenario: 'apostille.zags.spb', service: 'apostille_spb' } })
    );
    expect(result.success).toBe(true);
  });

  it('facet, НЕприменимая к kind, отвергается — TERM_DEFINITION не может нести scenario (KNOWLEDGE_KIND_REGISTRY.applicableFacets=[])', () => {
    const result = extractedKnowledgeUnitSchema.safeParse(
      validUnit({ kind: 'TERM_DEFINITION', facets: { scenario: 'apostille.zags.spb' } })
    );
    expect(result.success).toBe(false);
  });

  it('TERM_DEFINITION без единой фасеты — валиден', () => {
    const result = extractedKnowledgeUnitSchema.safeParse(
      validUnit({ kind: 'TERM_DEFINITION', facets: {} })
    );
    expect(result.success).toBe(true);
  });

  it('PRICE_RULE со service — применимая фасета проходит; PROCEDURE_STEP со service — неприменимая отвергается', () => {
    expect(
      extractedKnowledgeUnitSchema.safeParse(
        validUnit({ kind: 'PROCEDURE_STEP', facets: { scenario: 'apostille.zags.spb', service: 'apostille_spb' } })
      ).success
    ).toBe(false);
  });
});

describe('extractedKnowledgeUnitSchema — evidenceByField, минимум по acceptance criteria PR E', () => {
  it('без evidenceByField.statement отвергается — statement всегда непуст, значит evidence обязана существовать', () => {
    // Изолированно от facets-проверки: facets здесь пуст, чтобы сработала
    // РОВНО проверка statement, а не любая из двух одновременно (маскировка
    // мутации — см. work-log этой сессии, "confirm the mutation applied").
    const result = extractedKnowledgeUnitSchema.safeParse(
      validUnit({ kind: 'TERM_DEFINITION', facets: {}, evidenceByField: {} })
    );
    expect(result.success).toBe(false);
  });

  it('facets непуст, но evidenceByField.facets отсутствует — отвергается', () => {
    const result = extractedKnowledgeUnitSchema.safeParse(
      validUnit({ evidenceByField: { statement: VALID_SOURCE_SPAN } })
    );
    expect(result.success).toBe(false);
  });

  it('facets пуст ({}) — evidenceByField.facets не требуется', () => {
    const result = extractedKnowledgeUnitSchema.safeParse(
      validUnit({
        kind: 'TERM_DEFINITION',
        facets: {},
        evidenceByField: { statement: VALID_SOURCE_SPAN },
      })
    );
    expect(result.success).toBe(true);
  });

  it('triggerCondition непуст, но evidenceByField.triggerCondition отсутствует — отвергается', () => {
    const result = extractedKnowledgeUnitSchema.safeParse(
      validUnit({
        kind: 'EXCEPTION_RULE',
        triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] },
      })
    );
    expect(result.success).toBe(false);
  });

  it('numericConstraint непуст, но evidenceByField.numericConstraint отсутствует — отвергается', () => {
    const result = extractedKnowledgeUnitSchema.safeParse(
      validUnit({ numericConstraint: { factKey: 'x', value: 3, unit: 'сутки' } })
    );
    expect(result.success).toBe(false);
  });

  it('все четыре структурных поля заполнены и все подтверждены evidence — валидно', () => {
    const result = extractedKnowledgeUnitSchema.safeParse(
      validUnit({
        kind: 'EXCEPTION_RULE',
        triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] },
        numericConstraint: { factKey: 'x', value: 3, unit: 'сутки' },
        evidenceByField: {
          statement: VALID_SOURCE_SPAN,
          facets: VALID_SOURCE_SPAN,
          triggerCondition: VALID_SOURCE_SPAN,
          numericConstraint: VALID_SOURCE_SPAN,
        },
      })
    );
    expect(result.success).toBe(true);
  });

  it('evidenceByField с пустой quote отвергается', () => {
    const result = extractedKnowledgeUnitSchema.safeParse(
      validUnit({ evidenceByField: { statement: { anchor: 'block-3', quote: '   ' }, facets: VALID_SOURCE_SPAN } })
    );
    expect(result.success).toBe(false);
  });
});

describe('extractedKnowledgeUnitSchema — triggerCondition/numericConstraint по умолчанию null, не выдуманы', () => {
  it('оба null — валидно (PROCEDURE_STEP без числового условия)', () => {
    expect(extractedKnowledgeUnitSchema.safeParse(validUnit()).success).toBe(true);
  });

  it('triggerCondition в терминах TriggerFactKey (переиспользует trigger.ts из B2)', () => {
    const result = extractedKnowledgeUnitSchema.safeParse(
      validUnit({
        kind: 'EXCEPTION_RULE',
        triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] },
        evidenceByField: { statement: VALID_SOURCE_SPAN, facets: VALID_SOURCE_SPAN, triggerCondition: VALID_SOURCE_SPAN },
      })
    );
    expect(result.success).toBe(true);
  });

  it('triggerCondition свободным текстом отвергается — не в терминах TriggerFactKey', () => {
    const result = extractedKnowledgeUnitSchema.safeParse(
      validUnit({ triggerCondition: { description: 'в общественном месте' } })
    );
    expect(result.success).toBe(false);
  });

  it('РЕАЛЬНЫЙ живой прогон (claude-haiku-4-5, scratchpad/run1-log.txt, воспроизведено 2 из 3 попыток): triggerCondition/numericConstraint ПРОПУЩЕНЫ ключом целиком (не null), а не выдуманы — нормализуются в null, а не отвергаются', () => {
    const { triggerCondition: _t, ...withoutTrigger } = validUnit();
    const triggerResult = extractedKnowledgeUnitSchema.safeParse(withoutTrigger);
    expect(triggerResult.success).toBe(true);
    if (triggerResult.success) expect(triggerResult.data.triggerCondition).toBeNull();

    const { numericConstraint: _n, ...withoutNumeric } = validUnit();
    const numericResult = extractedKnowledgeUnitSchema.safeParse(withoutNumeric);
    expect(numericResult.success).toBe(true);
    if (numericResult.success) expect(numericResult.data.numericConstraint).toBeNull();
  });
});

describe('extractedKnowledgeUnitSchema — extractionRef/parentExtractionRef (preflight C, translation-djc)', () => {
  it('extractionRef обязателен — без него отвергается', () => {
    const { extractionRef: _drop, ...withoutRef } = validUnit();
    expect(extractedKnowledgeUnitSchema.safeParse(withoutRef).success).toBe(false);
  });

  it.each(['', '  '])('пустой по смыслу extractionRef (%j) отвергается', (blank) => {
    expect(extractedKnowledgeUnitSchema.safeParse(validUnit({ extractionRef: blank })).success).toBe(
      false
    );
  });

  it('parentExtractionRef: null — валидно (unit самостоятелен)', () => {
    expect(
      extractedKnowledgeUnitSchema.safeParse(validUnit({ parentExtractionRef: null })).success
    ).toBe(true);
  });

  it('parentExtractionRef непустой строкой — валидно', () => {
    expect(
      extractedKnowledgeUnitSchema.safeParse(validUnit({ parentExtractionRef: 'u0' })).success
    ).toBe(true);
  });

  it.each(['', '  '])('пустая по смыслу parentExtractionRef (%j) отвергается', (blank) => {
    expect(
      extractedKnowledgeUnitSchema.safeParse(validUnit({ parentExtractionRef: blank })).success
    ).toBe(false);
  });

  it('старое поле parentRuleRef на новой схеме отвергается — strictObject, не тихо игнорируется', () => {
    const { extractionRef: _drop, parentExtractionRef: _drop2, ...withoutNewFields } = validUnit();
    const result = extractedKnowledgeUnitSchema.safeParse({
      ...withoutNewFields,
      parentRuleRef: null,
    });
    expect(result.success).toBe(false);
  });
});
