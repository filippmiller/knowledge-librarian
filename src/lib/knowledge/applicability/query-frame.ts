import { z } from 'zod';
import {
  conceptIdSchema,
  FACET_KEYS,
  FACET_REGISTRY,
  type FacetKey,
  type FacetValueOf,
} from './facets';
import {
  TRIGGER_FACT_KEYS,
  TRIGGER_FACT_REGISTRY,
  type TriggerFactKey,
  type TriggerFactValueOf,
} from './trigger-facts';

/**
 * QueryFrame — те же измерения, снятые с вопроса пользователя.
 *
 * Два поля из предыдущей версии контракта убраны намеренно:
 *
 * - `negation: boolean` — один глобальный флаг не различал «нужен НЕ апостиль,
 *   а легализация» (отрицание значения фасеты) и «а оригинал не нужен?»
 *   (вопрос о требовании). Отрицание живёт пофасетно, в `exclude`.
 * - `missingRequiredFacets` — не факт вопроса, а результат сравнения вопроса с
 *   требованиями конкретного `kind`. Его вычисляет `evaluateScope` (PR B2) по
 *   `KNOWLEDGE_KIND_REGISTRY[kind].requiredFacets`; вычислять его ещё и в
 *   LLM-построителе значило бы завести вторую, рассинхронизированную копию
 *   одной логики.
 */

export const EVIDENCE_SOURCES = ['CURRENT_MESSAGE', 'HISTORY', 'DETERMINISTIC'] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

/**
 * Откуда взято значение. `messageId` осмысленен для истории; `quote` —
 * дословный фрагмент, по которому решение можно перепроверить в trace (PR H).
 */
export interface FacetEvidence {
  readonly source: EvidenceSource;
  readonly messageId?: string;
  readonly quote: string;
}

export const facetEvidenceSchema = z.strictObject({
  source: z.enum(EVIDENCE_SOURCES),
  messageId: z.string().min(1).optional(),
  quote: z.string().min(1),
});

/**
 * Состояние фасеты на стороне запроса.
 *
 * `KNOWN` обязан нести хотя бы одно значение (в `include` или в `exclude`) и
 * хотя бы одно свидетельство: «известно, но ничего не известно» — это второй
 * способ записать `UNKNOWN`, а «известно, но неизвестно откуда» неотличимо от
 * галлюцинации построителя.
 */
export type QueryFacetState<T> =
  | { readonly state: 'UNKNOWN' }
  | {
      readonly state: 'KNOWN';
      readonly include: readonly T[];
      readonly exclude: readonly T[];
      readonly evidence: readonly FacetEvidence[];
    };

export function queryFacetStateSchema<T>(valueSchema: z.ZodType<T>) {
  return z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('UNKNOWN') }),
    z
      .strictObject({
        state: z.literal('KNOWN'),
        include: z.array(valueSchema).readonly(),
        exclude: z.array(valueSchema).readonly(),
        evidence: z.array(facetEvidenceSchema).min(1).readonly(),
      })
      .superRefine((value, ctx) => {
        if (value.include.length === 0 && value.exclude.length === 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['include'],
            message: 'KNOWN без единого значения — это UNKNOWN, записанный вторым способом',
          });
        }
        const overlap = value.exclude.filter((item) => value.include.includes(item));
        if (overlap.length > 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['exclude'],
            message: `значение одновременно в include и exclude: ${overlap.join(', ')}`,
          });
        }
      }),
  ]);
}

/** Состояние триггер-факта: одно значение, не набор — факт либо есть, либо нет. */
export type QueryFactState<T> =
  | { readonly state: 'UNKNOWN' }
  | {
      readonly state: 'KNOWN';
      readonly value: T;
      readonly evidence: readonly FacetEvidence[];
    };

export function queryFactStateSchema<T>(valueSchema: z.ZodType<T>) {
  return z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('UNKNOWN') }),
    z.strictObject({
      state: z.literal('KNOWN'),
      value: valueSchema,
      evidence: z.array(facetEvidenceSchema).min(1).readonly(),
    }),
  ]);
}

export const QUESTION_ASPECTS = [
  'ELIGIBILITY',
  'REQUIREMENT',
  'PRICE',
  'PROCEDURE',
  'DELIVERY',
] as const;
export type QuestionAspect = (typeof QUESTION_ASPECTS)[number];

/**
 * Ключи присутствуют ВСЕ и всегда — в отличие от профиля, где отсутствие ключа
 * несёт смысл NOT_APPLICABLE.
 *
 * У вопроса нет `kind`, значит нет и понятия «неприменимая ось»: пропущенный
 * ключ мог бы значить только «сигнала нет», то есть был бы вторым способом
 * записать `UNKNOWN`. Truth table §6 требует прямо противоположного —
 * возвращать `UNKNOWN` явно, а не пропускать поле, иначе инвариант §1
 * нарушается на стороне запроса ровно так же, как сегодня на стороне профиля.
 * (Набросок плана рисовал эти карты частичными; здесь выигрывает truth table.)
 */
export type QueryFacetMap = { readonly [K in FacetKey]: QueryFacetState<FacetValueOf<K>> };
export type QueryFactMap = {
  readonly [K in TriggerFactKey]: QueryFactState<TriggerFactValueOf<K>>;
};

export interface QueryFrame {
  /** Канонические Concept ID (Задача 2.2). */
  readonly concepts: readonly string[];
  readonly facets: QueryFacetMap;
  readonly triggerFacts: QueryFactMap;
  /** Композитный вопрос («сколько стоит и нужен ли оригинал?») несёт несколько. */
  readonly questionAspects: readonly QuestionAspect[];
  /** В том числе конфликт текущего сообщения с историей — не молчаливый override. */
  readonly ambiguities: readonly string[];
}

// Ключи перечислены поимённо по той же причине, что и в `facets.ts`: сборка
// циклом стирает связь «ключ → тип значения». Совпадение с реестрами проверяет тест.
export const queryFacetMapSchema = z.strictObject({
  scenario: queryFacetStateSchema(FACET_REGISTRY.scenario.valueSchema),
  service: queryFacetStateSchema(FACET_REGISTRY.service.valueSchema),
  documentType: queryFacetStateSchema(FACET_REGISTRY.documentType.valueSchema),
  issuingCountry: queryFacetStateSchema(FACET_REGISTRY.issuingCountry.valueSchema),
  destinationCountry: queryFacetStateSchema(FACET_REGISTRY.destinationCountry.valueSchema),
  documentForm: queryFacetStateSchema(FACET_REGISTRY.documentForm.valueSchema),
  languageFrom: queryFacetStateSchema(FACET_REGISTRY.languageFrom.valueSchema),
  languageTo: queryFacetStateSchema(FACET_REGISTRY.languageTo.valueSchema),
  deliveryCity: queryFacetStateSchema(FACET_REGISTRY.deliveryCity.valueSchema),
  partner: queryFacetStateSchema(FACET_REGISTRY.partner.valueSchema),
});

export const queryFactMapSchema = z.strictObject({
  privacyContext: queryFactStateSchema(TRIGGER_FACT_REGISTRY.privacyContext.valueSchema),
  consentStatus: queryFactStateSchema(TRIGGER_FACT_REGISTRY.consentStatus.valueSchema),
  reachability: queryFactStateSchema(TRIGGER_FACT_REGISTRY.reachability.valueSchema),
  helperPresent: queryFactStateSchema(TRIGGER_FACT_REGISTRY.helperPresent.valueSchema),
});

type Assert<T extends true> = T;

/** Схемы карт и объявленные типы обязаны описывать одно и то же. */
type _QueryFacetMapMatches = Assert<
  z.infer<typeof queryFacetMapSchema> extends QueryFacetMap ? true : false
>;
type _QueryFactMapMatches = Assert<
  z.infer<typeof queryFactMapSchema> extends QueryFactMap ? true : false
>;

export const queryFrameSchema = z.strictObject({
  concepts: z.array(conceptIdSchema).readonly(),
  facets: queryFacetMapSchema,
  triggerFacts: queryFactMapSchema,
  questionAspects: z.array(z.enum(QUESTION_ASPECTS)).readonly(),
  ambiguities: z.array(z.string().min(1)).readonly(),
});

/**
 * Заготовки «сигнала нет ни по одной оси» — чтобы обязательность всех ключей не
 * толкала вызывающий код изобретать частичные карты.
 */
export const UNKNOWN_QUERY_FACETS: QueryFacetMap = Object.freeze(
  Object.fromEntries(FACET_KEYS.map((key) => [key, Object.freeze({ state: 'UNKNOWN' as const })]))
) as QueryFacetMap;

export const UNKNOWN_TRIGGER_FACTS: QueryFactMap = Object.freeze(
  Object.fromEntries(
    TRIGGER_FACT_KEYS.map((key) => [key, Object.freeze({ state: 'UNKNOWN' as const })])
  )
) as QueryFactMap;
