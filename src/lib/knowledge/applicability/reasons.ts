import { FACET_KEYS, type FacetKey } from './facets';
import { TRIGGER_FACT_KEYS, type TriggerFactKey } from './trigger-facts';

/**
 * Реестр машиночитаемых причин решений (PR B2).
 *
 * Почему коды, а не строки на месте: решение evaluator'а обязано объяснять себя
 * так, чтобы объяснение можно было проверить тестом, сматчить в oracle (PR H) и
 * показать в trace — голый boolean или человеческая фраза не годятся ни для
 * одного из трёх. Свободная строка вырождается в ту же EAV-проблему, что и
 * свободная карта фасет: `scenario_conflict` и `scenarioConflict` одинаково
 * валидны для компилятора и одинаково молча не совпадут в грейдере.
 *
 * Пофасетные и пофактовые коды ВЫВОДЯТСЯ из реестров B1, а не перечисляются
 * руками: новая ось в `FACET_REGISTRY` автоматически расширяет пространство
 * кодов, и рассинхронизации между реестром осей и реестром причин быть не может
 * по построению.
 */

/**
 * Что именно произошло на одной оси при сравнении профиля с запросом.
 *
 * Три исхода truth table §3 (MATCH/CONFLICT/UNKNOWN) — это ВЕРДИКТ; ситуация
 * ниже — его причина. Разные причины одного вердикта различать обязательно:
 * `unknown_query_signal` («вопрос не сказал») лечится уточняющим вопросом, а
 * `unknown_profile_scope` («знание не размечено») — правкой базы знаний, и
 * склейка их в один код лишила бы PR H возможности их разделить.
 */
export const SCOPE_SITUATIONS = [
  /** Значение профиля покрывает значение запроса (для `scenario` — включая предков). */
  'match_exact',
  /** `FacetState.GLOBAL` — единственный легальный wildcard (truth table §1, §5). */
  'match_global',
  /** Значение запроса известно и не покрыто набором профиля (§3.1/§3.3/§3.4). */
  'conflict_value',
  /** Значение запроса попало в `exclude` профиля — явный отказ, не пробел. */
  'conflict_excluded_by_profile',
  /** Запрос явно отрицает всё, что покрывает профиль («нужен НЕ апостиль»). */
  'conflict_excluded_by_query',
  /** У запроса нет сигнала по этой оси — «сценарий не распознан» из §3.1. */
  'unknown_query_signal',
  /** Профиль не заполнен по этой оси — строка «профиль не заполнен» §3.1. */
  'unknown_profile_scope',
  /**
   * Ось применима к `kind`, но ключа в `facets` нет вовсе. По контракту B1 это
   * NOT_APPLICABLE, а реестр говорит «применима» — профиль противоречит сам
   * себе. Fail-closed в UNKNOWN: молча счесть такую ось совпавшей значило бы
   * вернуть ровно тот баг, который весь контракт закрывает.
   */
  'unknown_profile_state_absent',
  /** Профиль строго специфичнее запроса (§3.1, строка «профиль = потомок S»). */
  'unknown_profile_more_specific',
  /** Ось обязательна для этого `kind`, но в ЗАПРОСЕ сигнала нет. */
  'missing_in_query',
] as const;

export type ScopeSituation = (typeof SCOPE_SITUATIONS)[number];

/** Пофасетный код причины: `scenario_match_exact`, `deliveryCity_conflict_value`. */
export type ScopeReasonCode = `${FacetKey}_${ScopeSituation}`;

export function scopeReason(facet: FacetKey, situation: ScopeSituation): ScopeReasonCode {
  return `${facet}_${situation}`;
}

/** Полное пространство пофасетных кодов — для тестов на замкнутость и для PR H. */
export const SCOPE_REASON_CODES: readonly ScopeReasonCode[] = Object.freeze(
  FACET_KEYS.flatMap((facet) => SCOPE_SITUATIONS.map((situation) => scopeReason(facet, situation)))
);

/**
 * Что произошло с одним триггер-фактом.
 *
 * `unknown` здесь — не «фактически нет», а «неизвестно»: ровно то различие,
 * из-за которого `TRIGGER_FACT_REGISTRY` живёт отдельно от значений и не имеет
 * варианта `'UNKNOWN'` внутри union'а значений.
 */
export const TRIGGER_SITUATIONS = ['satisfied', 'violated', 'unknown'] as const;
export type TriggerSituation = (typeof TRIGGER_SITUATIONS)[number];

export type TriggerReasonCode = `${TriggerFactKey}_${TriggerSituation}`;

export function triggerReason(
  fact: TriggerFactKey,
  situation: TriggerSituation
): TriggerReasonCode {
  return `${fact}_${situation}`;
}

export const TRIGGER_REASON_CODES: readonly TriggerReasonCode[] = Object.freeze(
  TRIGGER_FACT_KEYS.flatMap((fact) =>
    TRIGGER_SITUATIONS.map((situation) => triggerReason(fact, situation))
  )
);

/**
 * Причины решения о годности unit'а. Список закрытый и перечислен руками:
 * в отличие от осей, здесь нет реестра, из которого его можно вывести, —
 * каждая строка соответствует конкретному пункту truth table.
 */
export const ELIGIBILITY_REASON_CODES = [
  /** Unit не в рабочем статусе (архив/черновик/заменён). */
  'unit_status_not_active',
  /** `now < validFrom` — знание ещё не вступило в силу. */
  'validity_not_started',
  /** `now > validUntil` — знание истекло. */
  'validity_expired',
  /** `validUntil < validFrom` — окно нечитаемо, доверять ему нельзя. */
  'validity_window_malformed',
  /** §3.2: профиль `INTERNAL_ONLY`, запрос клиентский → CONFLICT. */
  'audience_internal_only_for_client',
  /** §3.2, последняя строка: аудитория не проставлена, запрос клиентский → CONFLICT. */
  'audience_missing_for_client',
  /** §3.2, последняя строка: аудитория не проставлена, запрос внутренний → UNKNOWN. */
  'audience_missing_for_internal',
  /** §5: `UNCLASSIFIED` исключается ДО §3 для клиента — гейт на входе. */
  'review_unclassified_for_client',
  /** §5: для оператора `UNCLASSIFIED` участвует, но след остаётся. */
  'review_unclassified_for_internal',
  /** Обязательная для `kind` фасета оставлена в `UNKNOWN`. */
  'required_facet_unknown',
  /** Обязательной фасеты нет в карте вовсе — профиль противоречит реестру. */
  'required_facet_absent',
  /** Unit собран по устаревшей ревизии источника. */
  'source_revision_stale',
  /** Ревизия unit'а новее, чем известная ревизия источника — рассинхрон данных. */
  'source_revision_ahead_of_source',
  /** Сверить ревизию не с чем; §4.2-принцип: проверка включается по факту данных. */
  'source_revision_unverified',
] as const;

export type EligibilityReasonCode = (typeof ELIGIBILITY_REASON_CODES)[number];

/** Причины решений о наборе unit'ов (truth table §4). */
export const RESOLUTION_REASON_CODES = [
  /** Кандидат не прошёл `evaluateUnitEligibility`. */
  'candidate_ineligible',
  /** Явный CONFLICT по §3 — единственное основание выбросить кандидата. */
  'scope_conflict',
  /** UNKNOWN по §3: кандидат УДЕРЖИВАЕТСЯ, а не выбрасывается. */
  'scope_unknown_held',
  /** §4.1 п.2: `triggerCondition` активен — исключение переопределяет родителя. */
  'exception_trigger_active',
  /** §4.1 п.2: условие не выполнено — исключение не активно и НЕ блокирует общее правило. */
  'exception_trigger_inactive',
  /** §4.1 п.2: условия не хватает — исключение удерживается, не активируется. */
  'exception_trigger_unknown',
  /**
   * `EXCEPTION_RULE` без `triggerCondition` (§2.1 объявляет его обязательным):
   * исключение, которое нечем активировать, неотличимо от обычного шага и
   * молча переопределяло бы родителя. Достоверный дефект данных, не пробел.
   */
  'exception_without_trigger',
  /** Родительское правило переопределено активным исключением. */
  'parent_overridden_by_exception',
  /** Явная связь `supersedes` — единственный способ разрешить конфликт чисел молча. */
  'superseded_by_newer_unit',
  /**
   * A заменяет B и B заменяет A. Разрешить порядком обхода нельзя (результат
   * зависел бы от сортировки выдачи), а удалить оба — значит схлопнуть набор
   * кандидатов в пустой. Связь игнорируется, решение уходит человеку.
   */
  'supersedes_cycle_unresolved',
  /** §4.1 п.3: разные значения одного факта без `supersedes` → человек. */
  'numeric_conflict_unresolved',
  /** Один факт измерен в разных единицах — сравнивать нечего, это дефект данных. */
  'numeric_unit_mismatch',
  /** Не хватает фасеты, и именно она решает между конкурирующими правилами. */
  'clarification_required_missing_facet',
  /** Не хватает триггер-факта, и именно он решает между правилом и исключением. */
  'clarification_required_missing_trigger_fact',
  /** Построитель фрейма (PR D) уже пометил вопрос неоднозначным — не игнорировать. */
  'clarification_required_query_ambiguity',
  /** Выбранный кандидат сам по себе требует человека (см. `EligibilityDecision`). */
  'candidate_requires_human_review',
  /** Выбирать не из чего — но удержанные кандидаты остаются видимыми. */
  'no_selected_candidates',
] as const;

export type ResolutionReasonCode = (typeof RESOLUTION_REASON_CODES)[number];
