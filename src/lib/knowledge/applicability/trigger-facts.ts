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
  // Живой замер 2026-08-12 (первый полный прогон вопросов): описание было
  // односложным — «приватная обстановка или публичное место», — и извлекатель
  // фрейма НЕ распознал прямо названное место как публичное, оставив факт
  // UNKNOWN. Соседний факт из того же вопроса (ограниченная подвижность) при
  // этом извлёкся: дело не в модели, а в том, что у одного факта был ориентир,
  // а у другого — нет. Последствие дороже пропуска: неизвестный решающий факт
  // уводит правила в условную подачу вместо однозначного разрешения.
  // Формулировка намеренно доменно-нейтральна — перечислять обстановки из
  // конкретного документа значило бы подгонять извлекатель под фикстуру.
  privacyContext: {
    valueSchema: z.enum(PRIVACY_CONTEXTS),
    description:
      'ПРИВАТНАЯ обстановка или ПУБЛИЧНОЕ место как обстоятельство вокруг человека прямо сейчас. ' +
      'ЕДИНСТВЕННЫЙ критерий: могут ли посторонние наблюдать происходящее. ' +
      'PUBLIC — из названной обстановки следует, что рядом посторонние или человека видно; ' +
      'PRIVATE — из названной обстановки следует, что человек один и его не видно. ' +
      'Названного места достаточно: выведи значение из него по критерию выше, не требуй, чтобы слова «публично» или «наедине» прозвучали буквально. ' +
      'Если обстановка не названа или из неё не следует ни присутствие, ни отсутствие посторонних — не указывай факт',
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
  // Формулировка намеренно узкая. Первая редакция звучала как «доступен ли
  // расходуемый ресурс/материал, необходимый для основного способа выполнения
  // действия» — и живой прогон (2026-08-11, блок b5) показал, что под неё
  // подводится почти любое правило про способ действия: модель приписала
  // resourceAvailability=UNAVAILABLE безусловному запрету способа, где в
  // исходном тексте нет ни слова о ресурсах. Аудитор покрытия справедливо
  // назвал такой триггер выдуманным, и repair не мог это закрыть — условия,
  // которое он требовал, в тексте не существовало. Выдуманный триггер хуже
  // отсутствующего: он делает правило исполнимым по признаку, которого нет.
  // Расширение закрытого каталога всегда несёт этот риск — модель тянется к
  // новому пункту, — поэтому новый факт обязан нести и границу применения.
  resourceAvailability: {
    valueSchema: z.enum(RESOURCE_AVAILABILITY_LEVELS),
    description:
      'НАЛИЧИЕ ИЛИ ОТСУТСТВИЕ ресурса как условие, при котором правило вообще применяется. ' +
      'Решающее — не то, упомянут ли в правиле расходуемый предмет, а то, сказано ли в тексте про его ДОСТУПНОСТЬ. ' +
      'ВЕРНО: «при отсутствии воды допустим антисептик» — текст прямо вводит условие отсутствия воды. ' +
      'НЕВЕРНО: «использованную салфетку выбрасывают, повторно применять нельзя» — салфетка расходуемая, ' +
      'но о её наличии или отсутствии не сказано ни слова, правило действует всегда: triggerCondition=null. ' +
      'НЕВЕРНО: любой безусловный запрет или оценка способа действия, где доступность ресурса не упомянута. ' +
      'Если сомневаешься — ставь null: выдуманное условие делает правило исполнимым по признаку, которого в документе нет',
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
