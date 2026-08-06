import { z } from 'zod';
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
 * Ключ сценария — dot-notation путь дерева сценариев
 * (`src/lib/knowledge/scenarios.ts`): `apostille`, `apostille.min_justice`,
 * `apostille.zags.spb`. Верхний регистр и ведущая точка невалидны там же.
 */
const scenarioKeySchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:_[a-z0-9]+)*(?:\.[a-z0-9]+(?:_[a-z0-9]+)*)*$/,
    'ключ сценария — dot-notation в нижнем регистре, напр. "apostille.zags.spb"'
  );

/**
 * Идентификатор концепта (Задача 2.2). До появления контролируемого словаря
 * это slug той же формы, что и ключ сценария: `apostille`, `apostille.zags`.
 * Синтаксическое совпадение кодов — НЕ то же, что совпадение концептов
 * (truth table §3.4); сопоставление синонимов появится вместе с `ConceptAlias`.
 */
export const conceptIdSchema = z
  .string()
  .regex(
    /^[a-z0-9]+(?:[_.][a-z0-9]+)*$/,
    'идентификатор концепта — slug в нижнем регистре, напр. "apostille.zags"'
  );

/** Страна — ISO-3166-1 alpha-2, верхний регистр. */
const countryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, 'код страны — ISO-3166-1 alpha-2, напр. "RU"');

/** Язык — ISO-639, нижний регистр. */
const languageCodeSchema = z
  .string()
  .regex(/^[a-z]{2,3}$/, 'код языка — ISO-639, напр. "ru"');

/** Город доставки — slug в нижнем регистре: `spb`, `nizhny_novgorod`. */
const cityCodeSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/, 'код города — slug в нижнем регистре, напр. "spb"');

/** Партнёр — slug в нижнем регистре. */
const partnerIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/, 'идентификатор партнёра — slug в нижнем регистре');

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
    valueSchema: conceptIdSchema,
    description: 'к какой услуге относится знание (truth table §3.4)',
  },
  documentType: {
    valueSchema: conceptIdSchema,
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
