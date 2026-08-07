import { z } from 'zod';
import { FACET_REGISTRY, type FacetKey, type FacetValueOf } from './facets';
import { applicableFacetsOf, knowledgeUnitKindSchema, type KnowledgeUnitKind } from './kinds';
import type { NumericConstraint } from './resolution';
import { nonBlankString } from './text';
import { triggerConditionSchema, type TriggerCondition } from './trigger';

/**
 * Контракт структурной экстракции (PR E, план §3, Beads translation-ypp).
 *
 * Заменяет `ExtractedRuleStream` (`src/lib/ai/knowledge-extractor-stream.ts`,
 * `{ruleCode,title,body,confidence,sourceSpan}`) — у той схемы нет
 * структурного поля условия применимости вообще, оно живёт прозой в `body`.
 * Живой баг (`translation-2n9`, синтетический прогон 2026-08-05): "не более 3
 * дней" оторвалось от "раздражение кожи", к которому относилось — фрагментация
 * без структурного `parentRuleRef` теряет родителя молча.
 */

/** Пре-LLM якорь исходного блока + дословная цитата. Якорь назначает вызывающий
 *  код (разбиение документа на блоки — не задача этого модуля); экстрактор
 *  только ссылается на уже существующие якоря. */
export interface SourceSpan {
  readonly anchor: string;
  readonly quote: string;
}

export const sourceSpanSchema = z.strictObject({
  anchor: nonBlankString('anchor не может быть пустым'),
  quote: nonBlankString('quote обязана содержать текст источника, а не пробелы'),
});

/**
 * `NumericConstraint` — тип из `resolution.ts` (B2), не отдельная копия формы.
 * Governance (Stage C, truth table §4.1 п.3/§4.2) сравнивает эти значения
 * МЕЖДУ unit'ами одного `factKey` — извлекатель обязан говорить с ним на
 * одном языке. Форма НАМЕРЕННО проще, чем «оператор + диапазон»: направление
 * ограничения (максимум/минимум) уже закодировано словами `factKey`
 * («максимум секунд удержания»), отдельное поле-оператор здесь не решает
 * задачу governance, а добавляет второй способ сказать то же самое. Составной
 * лимит («15 секунд, потом пауза 30 секунд, не более 3 циклов» — Q04
 * фикстуры) — это ТРИ разных `factKey`, то есть три отдельных unit'а, не один
 * unit с тремя числами.
 */
export const numericConstraintSchema = z.strictObject({
  factKey: nonBlankString('factKey не может быть пустым'),
  value: z.number(),
  unit: nonBlankString('unit не может быть пустым'),
});

export const EXTRACTION_UNCERTAINTY_KINDS = [
  'UNRECOGNIZED_TRIGGER_CONDITION',
  'UNRECOGNIZED_NUMERIC_CONSTRAINT',
  'AMBIGUOUS_FACET',
  'DANGLING_PARENT_REF',
  'OTHER',
] as const;
export type ExtractionUncertaintyKind = (typeof EXTRACTION_UNCERTAINTY_KINDS)[number];

/**
 * Условие/значение, которое не удалось структурировать. Ничего не исчезает
 * молча (acceptance criterion PR E) — если распознавание не уверено, запись
 * попадает сюда явно, а не пропускается и не угадывается.
 */
export interface ExtractionUncertainty {
  readonly kind: ExtractionUncertaintyKind;
  readonly description: string;
  readonly quote: string;
}

export const extractionUncertaintySchema = z.strictObject({
  kind: z.enum(EXTRACTION_UNCERTAINTY_KINDS),
  description: nonBlankString('description не может быть пустым'),
  quote: nonBlankString('quote обязана содержать текст источника, а не пробелы'),
});

/**
 * `Partial<{[K in FacetKey]: FacetValueOf<K>}>` — RAW резолвленные значения,
 * БЕЗ обёртки UNKNOWN/GLOBAL/SCOPED (`FacetMap`/`ApplicabilityProfile.facets`,
 * profile.ts). Это другая стадия: `ApplicabilityProfile` — то, что закоммичено
 * и прошло ревью; `ExtractedFacetMap` — сырое извлечение до ревью и до
 * присвоения scope-семантики. Слияние двух типов заставило бы экстрактор
 * выдумывать reviewStatus/scope, которых на этой стадии ещё не существует.
 */
export type ExtractedFacetMap = { readonly [K in FacetKey]?: FacetValueOf<K> };

// Ключи поимённо, не циклом — та же причина, что в facets.ts: сборка из
// Object.entries стирает связь «ключ → тип значения».
export const extractedFacetMapSchema = z.strictObject({
  scenario: FACET_REGISTRY.scenario.valueSchema.optional(),
  service: FACET_REGISTRY.service.valueSchema.optional(),
  documentType: FACET_REGISTRY.documentType.valueSchema.optional(),
  issuingCountry: FACET_REGISTRY.issuingCountry.valueSchema.optional(),
  destinationCountry: FACET_REGISTRY.destinationCountry.valueSchema.optional(),
  documentForm: FACET_REGISTRY.documentForm.valueSchema.optional(),
  languageFrom: FACET_REGISTRY.languageFrom.valueSchema.optional(),
  languageTo: FACET_REGISTRY.languageTo.valueSchema.optional(),
  deliveryCity: FACET_REGISTRY.deliveryCity.valueSchema.optional(),
  partner: FACET_REGISTRY.partner.valueSchema.optional(),
});

type Assert<T extends true> = T;
type _ExtractedFacetMapSchemaMatches = Assert<
  z.infer<typeof extractedFacetMapSchema> extends ExtractedFacetMap ? true : false
>;
type _ExtractedFacetMapTypeMatches = Assert<
  ExtractedFacetMap extends z.infer<typeof extractedFacetMapSchema> ? true : false
>;

export interface ExtractedKnowledgeUnit {
  readonly kind: KnowledgeUnitKind;
  /** Само утверждение — ЧТО правило говорит, не только к чему применимо. */
  readonly statement: string;
  readonly title?: string;
  readonly facets: ExtractedFacetMap;
  /** `TriggerCondition` из `trigger.ts` (B2) — тот же тип, которым
   *  `evaluateTrigger` реально пользуется, не отдельная копия формы. */
  readonly triggerCondition: TriggerCondition | null;
  readonly numericConstraint: NumericConstraint | null;
  /** Якорь source span РОДИТЕЛЬСКОГО unit'а при фрагментации, иначе `null`.
   *  НЕ эфемерная метка прогона («R-17») — обязана разрешаться в реальный
   *  anchor из этого же прогона извлечения (проверяется вне схемы, см.
   *  `validateParentRefs` в `extraction-parent-refs.ts`). */
  readonly parentRuleRef: string | null;
  readonly sourceSpan: SourceSpan;
  readonly evidenceByField: Readonly<Record<string, SourceSpan>>;
  readonly uncertainties: readonly ExtractionUncertainty[];
}

export const extractedKnowledgeUnitSchema = z
  .strictObject({
    kind: knowledgeUnitKindSchema,
    statement: nonBlankString('statement не может быть пустым'),
    title: nonBlankString('title не может быть пустым').optional(),
    facets: extractedFacetMapSchema,
    triggerCondition: triggerConditionSchema.nullable(),
    numericConstraint: numericConstraintSchema.nullable(),
    parentRuleRef: nonBlankString('parentRuleRef не может быть пустой строкой').nullable(),
    sourceSpan: sourceSpanSchema,
    evidenceByField: z.record(z.string(), sourceSpanSchema),
    uncertainties: z.array(extractionUncertaintySchema).readonly(),
  })
  .superRefine((unit, ctx) => {
    // Та же дисциплина, что `applicabilityProfileSchema` (profile.ts) уже
    // применяет к закоммиченному профилю — здесь на СЫРОМ извлечении: unit не
    // может нести фасету, неприменимую к его `kind` (TERM_DEFINITION,
    // applicableFacets=[], не может иметь scenario). В отличие от профиля,
    // extraction НЕ требует присутствия ВСЕХ применимых фасет — экстрактор
    // мог что-то не найти, и это легально; требование "все обязательные
    // заполнены" проверяется позже, на коммите (F), не здесь.
    const applicable = new Set(applicableFacetsOf(unit.kind));
    for (const key of Object.keys(unit.facets)) {
      if (!applicable.has(key as FacetKey)) {
        ctx.addIssue({
          code: 'custom',
          path: ['facets', key],
          message: `фасета "${key}" неприменима к ${unit.kind} (KNOWLEDGE_KIND_REGISTRY.applicableFacets)`,
        });
      }
    }

    // Acceptance criterion PR E: "evidenceByField минимум для
    // statement/facets/triggerCondition/numericConstraint" — не пожелание, а
    // требование. `statement` всегда непуст, значит его evidence обязана
    // существовать всегда; остальные три — только когда соответствующее поле
    // само заполнено (facets непуст / triggerCondition не null /
    // numericConstraint не null). Лишние ключи в evidenceByField не
    // запрещены — минимум, а не точное соответствие.
    if (!('statement' in unit.evidenceByField)) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidenceByField', 'statement'],
        message: 'evidenceByField обязана подтверждать statement — оно всегда заполнено',
      });
    }
    if (Object.keys(unit.facets).length > 0 && !('facets' in unit.evidenceByField)) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidenceByField', 'facets'],
        message: 'facets непуст — evidenceByField обязана содержать подтверждение "facets"',
      });
    }
    if (unit.triggerCondition !== null && !('triggerCondition' in unit.evidenceByField)) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidenceByField', 'triggerCondition'],
        message: 'triggerCondition задан — evidenceByField обязана содержать подтверждение "triggerCondition"',
      });
    }
    if (unit.numericConstraint !== null && !('numericConstraint' in unit.evidenceByField)) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidenceByField', 'numericConstraint'],
        message: 'numericConstraint задан — evidenceByField обязана содержать подтверждение "numericConstraint"',
      });
    }
  });

type _ExtractedUnitSchemaMatches = Assert<
  z.infer<typeof extractedKnowledgeUnitSchema> extends ExtractedKnowledgeUnit ? true : false
>;
type _ExtractedUnitTypeMatches = Assert<
  ExtractedKnowledgeUnit extends z.infer<typeof extractedKnowledgeUnitSchema> ? true : false
>;
