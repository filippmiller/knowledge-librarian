import { z } from 'zod';
// Реестр сценариев — уже существующий источник истины v1; контракт сверяется с
// ним, а не заводит вторую копию списка. Модуль чисто декларативный (в нём
// только type-only импорт Prisma), никакого обращения к БД он не приносит.
import { getScenario } from '@/lib/knowledge/scenarios';
import {
  CITY_CONCEPTS,
  COUNTRY_CONCEPTS,
  DOCUMENT_TYPE_CONCEPTS,
  LANGUAGE_CONCEPTS,
  PARTNER_CONCEPTS,
  SERVICE_CONCEPTS,
} from './concept-registry';
import { isKnownConcept } from './concepts';
import { isoTimestampSchema, reviewerIdSchema } from './review';

/**
 * Реестр фасет применимости — единственный источник истины по допустимым осям.
 *
 * Почему реестр, а не `Record<string, FacetValue>`: свободная карта строк
 * вырождается в EAV, где `issuingCountry`, `issuerCountry` и `issuingContry`
 * одинаково валидны для компилятора и одинаково молча игнорируются в рантайме.
 * Ключи фиксированы здесь, значение каждого ключа имеет СВОЙ тип
 * (`FacetValueOf<K>`), и всё остальное в модуле выводится из этого объекта.
 *
 * Каталог из десяти ключей — рабочая гипотеза плана
 * (`docs/plans/2026-08-06-hardening-and-domain-contract-plan.md` §4.1), а не
 * иллюстрация: расширяет его пилот (Задача 2.3) правкой этого файла, а не
 * произвольный вызывающий код своим строковым ключом.
 */

/**
 * Ключ сценария — существующий узел дерева сценариев (`SCENARIOS` в
 * `src/lib/knowledge/scenarios.ts`), а не просто строка нужной формы.
 *
 * Формы мало: `apostille.zags.sbp` (опечатка в `spb`) синтаксически безупречен
 * и никогда ни с чем не совпадёт — профиль опубликуется и молча выпадет из
 * выдачи. Это ровно тот баг, ради которого КЛЮЧИ фасет сверяются с реестром;
 * оставить ЗНАЧЕНИЯ несверяемыми значило бы воспроизвести его этажом ниже.
 *
 * Допустим любой существующий узел, включая нелистовой: truth table §3.1 прямо
 * разрешает профилю быть предком сценария запроса (`apostille` применим ко всем
 * процедурам апостиля). Запрещён только несуществующий путь.
 */
const scenarioKeySchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*)*$/,
    'ключ сценария — dot-notation в нижнем регистре, напр. "apostille.zags.spb"'
  )
  .refine((key) => getScenario(key) !== undefined, {
    message: 'такого сценария нет в SCENARIOS (src/lib/knowledge/scenarios.ts)',
  });

/**
 * Идентификатор концепта — форма, общая для `service` и `documentType`.
 * Значение сверяется с конкретным словарём (`SERVICE_CONCEPTS` /
 * `DOCUMENT_TYPE_CONCEPTS`, Задача 2.2, `concept-registry.ts`) НИЖЕ, отдельной
 * схемой на каждую ось — эта форма сама по себе намеренно не проверяет
 * членство: `service` и `documentType` живут в РАЗНЫХ словарях, и общая
 * форматная схема не должна незаметно принять код одного там, где нужен код
 * другого.
 * Синтаксическое совпадение кодов — НЕ то же, что совпадение концептов
 * (truth table §3.4); сопоставление синонимов — `resolveConceptAlias`
 * (`concepts.ts`), используется на пути извлечения (PR E), а не здесь.
 */
export const conceptIdSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:[_.][a-z0-9]+)*$/,
    'идентификатор концепта — slug в нижнем регистре, напр. "apostille.zags"'
  );

const serviceIdSchema = conceptIdSchema.refine((id) => isKnownConcept(SERVICE_CONCEPTS, id), {
  message: 'такой услуги нет в SERVICE_CONCEPTS (concept-registry.ts)',
});

const documentTypeIdSchema = conceptIdSchema.refine(
  (id) => isKnownConcept(DOCUMENT_TYPE_CONCEPTS, id),
  { message: 'такого типа документа нет в DOCUMENT_TYPE_CONCEPTS (concept-registry.ts)' }
);

/** Страна — ISO-3166-1 alpha-2, верхний регистр; сверяется с COUNTRY_CONCEPTS
 *  (Задача 2.2) — намеренно минимальным, растёт пилотом по факту документов. */
const countryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, 'код страны — ISO-3166-1 alpha-2, напр. "RU"')
  .refine((code) => isKnownConcept(COUNTRY_CONCEPTS, code), {
    message: 'такой страны нет в COUNTRY_CONCEPTS (concept-registry.ts)',
  });

/** Язык — ISO-639 (плюс несколько кодов вне 639-1 для языков без стабильного
 *  двухбуквенного — см. комментарий в concept-registry.ts), нижний регистр;
 *  сверяется с LANGUAGE_CONCEPTS. */
const languageCodeSchema = z
  .string()
  .regex(/^[a-z]{2,3}$/, 'код языка — ISO-639, напр. "ru"')
  .refine((code) => isKnownConcept(LANGUAGE_CONCEPTS, code), {
    message: 'такого языка нет в LANGUAGE_CONCEPTS (concept-registry.ts)',
  });

/** Город доставки — slug в нижнем регистре: `spb`, `lo`; сверяется с
 *  CITY_CONCEPTS. */
const cityCodeSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, 'код города — slug в нижнем регистре, напр. "spb"')
  .refine((code) => isKnownConcept(CITY_CONCEPTS, code), {
    message: 'такого города нет в CITY_CONCEPTS (concept-registry.ts)',
  });

/** Партнёр — slug в нижнем регистре; PARTNER_CONCEPTS пуст сегодня, поэтому
 *  эта схема отвергает любое значение, пока пилот не внесёт первого
 *  подтверждённого партнёра — это ожидаемое поведение, не недоделка. */
const partnerIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/, 'идентификатор партнёра — slug в нижнем регистре')
  .refine((id) => isKnownConcept(PARTNER_CONCEPTS, id), {
    message: 'такого партнёра нет в PARTNER_CONCEPTS (concept-registry.ts) — пока не подтверждён',
  });

/**
 * Форма документа. Закрытый список: план (§4.1) называет ровно
 * оригинал/скан/копию. Расширение каталога — решение пилота, а не свободная
 * строка на месте вызова.
 */
const documentFormSchema = z.enum(['ORIGINAL', 'SCAN', 'COPY']);

interface FacetDefinition {
  /** Тип значения ЭТОГО ключа. Именно он делает карту фасет не-EAV. */
  readonly valueSchema: z.ZodType;
  /** Зачем ось существует — попадает в сообщения валидации и в trace (PR H). */
  readonly description: string;
}

export const FACET_REGISTRY = {
  scenario: {
    valueSchema: scenarioKeySchema,
    description: 'к какой процедуре относится знание (truth table §3.1)',
  },
  service: {
    valueSchema: serviceIdSchema,
    description: 'к какой услуге относится знание (truth table §3.4)',
  },
  documentType: {
    valueSchema: documentTypeIdSchema,
    description: 'тип документа: свидетельство, диплом, доверенность',
  },
  issuingCountry: {
    valueSchema: countryCodeSchema,
    description: 'страна выдачи документа',
  },
  destinationCountry: {
    valueSchema: countryCodeSchema,
    description: 'страна, для которой готовится документ',
  },
  documentForm: {
    valueSchema: documentFormSchema,
    description: 'оригинал / скан / копия',
  },
  languageFrom: {
    valueSchema: languageCodeSchema,
    description: 'язык оригинала',
  },
  languageTo: {
    valueSchema: languageCodeSchema,
    description: 'язык перевода',
  },
  deliveryCity: {
    valueSchema: cityCodeSchema,
    description: 'город доставки (измерение geography, truth table §3.3)',
  },
  partner: {
    valueSchema: partnerIdSchema,
    description: 'партнёр-исполнитель, если знание специфично для него',
  },
} as const satisfies Record<string, FacetDefinition>;

export type FacetKey = keyof typeof FACET_REGISTRY;

/** Порядок стабилен — на него опираются детерминированные сообщения валидации. */
export const FACET_KEYS: readonly FacetKey[] = Object.freeze(
  Object.keys(FACET_REGISTRY) as FacetKey[]
);

/** Тип значения конкретной фасеты. `FacetValueOf<'documentForm'>` — не string. */
export type FacetValueOf<K extends FacetKey> = z.infer<(typeof FACET_REGISTRY)[K]['valueSchema']>;

/** Runtime-проверка ключа: неизвестный ключ должен быть ошибкой, не no-op. */
export function isFacetKey(key: string): key is FacetKey {
  return Object.prototype.hasOwnProperty.call(FACET_REGISTRY, key);
}

/**
 * Состояние фасеты на профиле знания.
 *
 * Три состояния, и ни одно не выражается через отсутствие ключа: отсутствие
 * ключа означает NOT_APPLICABLE (фасета не применима к этому `kind`) и
 * проверяется по `KNOWLEDGE_KIND_REGISTRY`, см. `kinds.ts` и `profile.ts`.
 *
 * - `UNKNOWN` — ось применима, значение не заполнено. По truth table §1 это
 *   НИКОГДА не `ANY`.
 * - `GLOBAL` — единственный способ получить эффект wildcard, объявляется
 *   пофасетно и требует `reviewStatus='REVIEWED'` на unit'е (truth table §1, §5).
 * - `SCOPED` — задан конкретный набор значений.
 */
export type FacetState<T> =
  | { readonly state: 'UNKNOWN' }
  | { readonly state: 'GLOBAL'; readonly reviewedBy: string; readonly reviewedAt: string }
  | {
      readonly state: 'SCOPED';
      readonly include: readonly T[];
      readonly exclude?: readonly T[];
    };

/**
 * Схема одного состояния фасеты.
 *
 * `include` обязателен и непуст намеренно: `SCOPED` с пустым `include` — это
 * либо «применимо ни к чему» (недостижимое состояние), либо, вместе с
 * `exclude`, чёрный ход к wildcard в обход `GLOBAL` и его требования
 * `reviewStatus='REVIEWED'`. Truth table §1 разрешает ровно один способ сказать
 * «применимо ко всему», и он проходит через ревью.
 */
export function facetStateSchema<T>(valueSchema: z.ZodType<T>) {
  return z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('UNKNOWN') }),
    z.strictObject({
      state: z.literal('GLOBAL'),
      // Пофасетные аудит-поля НЕ заменяют unit-уровневую тройку §5.1: их
      // сосуществование с ней — открытый вопрос truth table §8, здесь он не
      // решается. Обязательным остаётся `reviewStatus='REVIEWED'` на unit'е,
      // это проверяет `applicabilityProfileSchema`.
      reviewedBy: reviewerIdSchema,
      reviewedAt: isoTimestampSchema,
    }),
    z
      .strictObject({
        state: z.literal('SCOPED'),
        include: z.array(valueSchema).min(1).readonly(),
        exclude: z.array(valueSchema).min(1).readonly().optional(),
      })
      .superRefine((value, ctx) => {
        const overlap = value.exclude?.filter((item) => value.include.includes(item)) ?? [];
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

/** Карта фасет профиля. Ключи — только из реестра, значение — типа своего ключа. */
export type FacetMap = { readonly [K in FacetKey]?: FacetState<FacetValueOf<K>> };

/**
 * `strictObject`, потому что неизвестный ключ обязан быть ошибкой валидации, а
 * не молча отброшенным полем: молчаливое игнорирование опечатки в имени фасеты
 * — ровно тот класс бага, который весь контракт закрывает.
 *
 * Ключи перечислены поимённо, а не собраны циклом: сборка из `Object.entries`
 * стирает связь «ключ → тип значения» и требует утверждения типа, то есть ровно
 * той дыры, ради закрытия которой реестр и существует. Синхронность с реестром
 * проверяется тестом на совпадение наборов ключей.
 */
export const facetMapSchema = z.strictObject({
  scenario: facetStateSchema(FACET_REGISTRY.scenario.valueSchema).optional(),
  service: facetStateSchema(FACET_REGISTRY.service.valueSchema).optional(),
  documentType: facetStateSchema(FACET_REGISTRY.documentType.valueSchema).optional(),
  issuingCountry: facetStateSchema(FACET_REGISTRY.issuingCountry.valueSchema).optional(),
  destinationCountry: facetStateSchema(FACET_REGISTRY.destinationCountry.valueSchema).optional(),
  documentForm: facetStateSchema(FACET_REGISTRY.documentForm.valueSchema).optional(),
  languageFrom: facetStateSchema(FACET_REGISTRY.languageFrom.valueSchema).optional(),
  languageTo: facetStateSchema(FACET_REGISTRY.languageTo.valueSchema).optional(),
  deliveryCity: facetStateSchema(FACET_REGISTRY.deliveryCity.valueSchema).optional(),
  partner: facetStateSchema(FACET_REGISTRY.partner.valueSchema).optional(),
});

type Assert<T extends true> = T;

/** Схема и объявленный тип обязаны описывать одно и то же. */
type _FacetMapSchemaMatchesType = Assert<
  z.infer<typeof facetMapSchema> extends FacetMap ? true : false
>;
type _FacetMapTypeMatchesSchema = Assert<
  FacetMap extends z.infer<typeof facetMapSchema> ? true : false
>;
