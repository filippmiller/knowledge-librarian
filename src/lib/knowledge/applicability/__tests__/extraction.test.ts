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
    parentRuleRef: null,
    sourceSpan: VALID_SOURCE_SPAN,
    evidenceByField: { statement: VALID_SOURCE_SPAN, facets: VALID_SOURCE_SPAN },
    uncertainties: [],
    ...overrides,
  };
}

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
});
