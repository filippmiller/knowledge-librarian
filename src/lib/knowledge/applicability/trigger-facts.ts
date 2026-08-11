import { z } from 'zod';

/**
 * Реестр триггер-фактов — СИТУАЦИОННЫХ сигналов, активирующих `EXCEPTION_RULE`.
 *
 * Отдельный реестр, а не расширение `FACET_REGISTRY`, и это не вкусовое
 * разделение: truth table §6 прямо разводит два класса сигналов на живом
 * примере — «прихватило в автобусе» это НЕ geography-фасета, а признак
 * публичного места для `triggerCondition`. Фасеты говорят, к какому классу
 * знания относится вопрос; триггер-факты — что происходит вокруг
 * спрашивающего прямо сейчас. Слияние их в один реестр вернуло бы ту же
 * ошибку, что и слияние NOT_APPLICABLE с UNKNOWN: два разных вопроса, один
 * ответ.
 *
 * Value-типы содержат ТОЛЬКО известные варианты. `UNKNOWN` живёт исключительно
 * в состоянии (`{ state: 'UNKNOWN' }`, см. `query-frame.ts`): вариант
 * `'UNKNOWN'` внутри union'а значений дал бы два способа сказать одно и то же
 * (`{state:'UNKNOWN'}` и `{state:'KNOWN', value:'UNKNOWN'}`), и любой
 * evaluator обязан был бы проверять оба.
 */

export const PRIVACY_CONTEXTS = ['PRIVATE', 'PUBLIC'] as const;
export type PrivacyContext = (typeof PRIVACY_CONTEXTS)[number];

export const CONSENT_STATUSES = ['EXPLICIT', 'ABSENT'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export const REACHABILITY_LEVELS = ['LIMITED', 'NORMAL'] as const;
export type Reachability = (typeof REACHABILITY_LEVELS)[number];

export const RESOURCE_AVAILABILITY_LEVELS = ['AVAILABLE', 'UNAVAILABLE'] as const;
export type ResourceAvailability = (typeof RESOURCE_AVAILABILITY_LEVELS)[number];

interface TriggerFactDefinition {
  readonly valueSchema: z.ZodType;
  readonly description: string;
}

export const TRIGGER_FACT_REGISTRY = {
  privacyContext: {
    valueSchema: z.enum(PRIVACY_CONTEXTS),
    description: 'приватная обстановка или публичное место',
  },
  consentStatus: {
    valueSchema: z.enum(CONSENT_STATUSES),
    description: 'есть ли явное согласие на текущий момент',
  },
  reachability: {
    valueSchema: z.enum(REACHABILITY_LEVELS),
    description: 'ограничена ли подвижность/доступность',
  },
  helperPresent: {
    valueSchema: z.boolean(),
    description: 'есть ли рядом помощник',
  },
  // translation-oxu: закрытый каталог не покрывал ограничение ресурса
  // ("при отсутствии воды допустим кожный антисептик") — override без
  // исполнимого триггера падал в structural gap, из которого repair не
  // мог выйти (условия для его закрытия просто не существовало).
  resourceAvailability: {
    valueSchema: z.enum(RESOURCE_AVAILABILITY_LEVELS),
    description: 'доступен ли расходуемый ресурс/материал, необходимый для основного способа выполнения действия',
  },
} as const satisfies Record<string, TriggerFactDefinition>;

export type TriggerFactKey = keyof typeof TRIGGER_FACT_REGISTRY;

export const TRIGGER_FACT_KEYS: readonly TriggerFactKey[] = Object.freeze(
  Object.keys(TRIGGER_FACT_REGISTRY) as TriggerFactKey[]
);

export type TriggerFactValueOf<K extends TriggerFactKey> = z.infer<
  (typeof TRIGGER_FACT_REGISTRY)[K]['valueSchema']
>;

export function isTriggerFactKey(key: string): key is TriggerFactKey {
  return Object.prototype.hasOwnProperty.call(TRIGGER_FACT_REGISTRY, key);
}
