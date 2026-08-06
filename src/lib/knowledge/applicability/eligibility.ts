// Тип-онли импорт: связь с действующим enum v1 проверяется компилятором, но
// ни строчки рантайма Prisma в контракт не попадает.
import type { KnowledgeStatus } from '@prisma/client';
import type { FacetKey } from './facets';
import { requiredFacetsOf, type KnowledgeUnitKind } from './kinds';
import type { ApplicabilityProfile, ProfileAudience } from './profile';
import type { EligibilityReasonCode } from './reasons';
import type { ReviewStatus } from './review';

/**
 * Статусы жизненного цикла — ДОСЛОВНО `KnowledgeStatus` из v1-схемы
 * (`prisma/schema.prisma`). Второй список статусов здесь не заводится: он бы
 * разошёлся с базой на первой же миграции. Совпадение проверяется типом ниже.
 */
export const UNIT_LIFECYCLE_STATUSES = ['ACTIVE', 'SUPERSEDED', 'DEPRECATED'] as const;
export type UnitLifecycleStatus = (typeof UNIT_LIFECYCLE_STATUSES)[number];

type Assert<T extends true> = T;
type _StatusMatchesPrisma = Assert<UnitLifecycleStatus extends KnowledgeStatus ? true : false>;
type _PrismaMatchesStatus = Assert<KnowledgeStatus extends UnitLifecycleStatus ? true : false>;

/**
 * Аудитория ВЫЗОВА — какой канал спрашивает. Действующая семантика v1
 * (`Audience` в `src/lib/knowledge/audience.ts`); повторена литералами, а не
 * импортом, потому что тот модуль тянет за собой Prisma-клиент, а этот
 * контракт обязан оставаться без ввода-вывода.
 */
export const REQUEST_AUDIENCES = ['internal', 'client'] as const;
export type RequestAudience = (typeof REQUEST_AUDIENCES)[number];

/**
 * Ссылка на ревизию источника: из какой версии документа собран unit.
 * `null` означает «unit не помнит происхождения» — это дефект данных, но не
 * повод блокировать (см. `evaluateUnitEligibility`).
 */
export interface SourceRevisionRef {
  readonly documentId: string;
  readonly revision: number;
}

/**
 * Unit в объёме, достаточном для решения о годности. Namely `-Like`: контракт
 * не ждёт Prisma-модель и не завязан на её поля (их имена — открытый вопрос
 * truth table §8, Задача 2.4).
 */
export interface KnowledgeUnitLike {
  readonly unitId: string;
  readonly status: UnitLifecycleStatus;
  /**
   * Профиль ровно из B1, но `audience` СОЗНАТЕЛЬНО расширен до `| null`.
   *
   * Truth table §3.2 описывает строку «не заполнено на профиле» и тут же
   * говорит, что это не легальный путь, а последствие бага миграции или ручной
   * правки БД. Через типизированный `ApplicabilityProfile` такое состояние
   * недостижимо — значит, если бы вход был объявлен строго, строка §3.2 была бы
   * непроверяемой, а рантайм всё равно мог бы её получить из базы.
   */
  readonly profile: Omit<ApplicabilityProfile, 'audience'> & {
    readonly audience: ProfileAudience | null;
  };
  /** ISO-8601 с временем; `null` — ограничения нет. */
  readonly validFrom: string | null;
  readonly validUntil: string | null;
  readonly sourceRevision: SourceRevisionRef | null;
}

export interface RequestContext {
  readonly audience: RequestAudience;
  /** «Сейчас» — параметр, а не `Date.now()`: чистая функция не читает часы. */
  readonly now: string;
  /**
   * Актуальные ревизии источников, `documentId → revision`. Отсутствие записи
   * означает «сверить не с чем», а не «всё в порядке» — см. ниже.
   */
  readonly currentSourceRevisions?: Readonly<Record<string, number>>;
}

export interface EligibilityDecision {
  /** Может ли unit вообще участвовать дальше (дойти до §3 и до синтеза). */
  readonly eligible: boolean;
  /** Может ли ответ на его основе уйти В ЭТОТ КАНАЛ автоматически, без человека. */
  readonly autoAnswerAllowed: boolean;
  readonly requiresHumanReview: boolean;
  /** Обязательные для `kind` оси, оставленные в `UNKNOWN` на профиле. */
  readonly unknownRequiredFacets: readonly FacetKey[];
  /** Обязательные оси, ключа которых нет в карте вовсе (профиль ⊥ реестру). */
  readonly absentRequiredFacets: readonly FacetKey[];
  /** Подмножество `reasons`, из-за которого `eligible === false`. */
  readonly blockingReasons: readonly EligibilityReasonCode[];
  readonly reasons: readonly EligibilityReasonCode[];
}

/** §3.2 в чистом виде: (аудитория профиля × аудитория запроса) → вердикт. */
function audienceOutcome(
  profileAudience: ProfileAudience | null,
  requestAudience: RequestAudience
): { readonly verdict: 'MATCH' | 'CONFLICT' | 'UNKNOWN'; readonly reason?: EligibilityReasonCode } {
  if (profileAudience === null) {
    // Именованное исключение из §1: на клиентской стороне «не заполнено» — это
    // CONFLICT, а не UNKNOWN. Ошибка «не показал» дешевле ошибки «показал не то».
    return requestAudience === 'client'
      ? { verdict: 'CONFLICT', reason: 'audience_missing_for_client' }
      : { verdict: 'UNKNOWN', reason: 'audience_missing_for_internal' };
  }
  if (profileAudience === 'INTERNAL_ONLY' && requestAudience === 'client') {
    return { verdict: 'CONFLICT', reason: 'audience_internal_only_for_client' };
  }
  return { verdict: 'MATCH' };
}

/**
 * Строгий ISO-8601 с временем и зоной — ровно тот формат, в котором контракт
 * хранит отметки времени (B1, §5.1).
 *
 * `Date.parse` в одиночку сюда не годится: он принимает `'0'`, голую дату и
 * прочее, что движок Node вольно нормализует. То есть испорченное значение
 * читалось бы как ВАЛИДНОЕ окно действия, и unit оказывался бы годен по
 * данным, которых нет. Отдельно ловим переполнение (`2026-02-30`): строка
 * разбирается, но Date молча переносит её на март, и окно уезжает.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseInstant(value: string): number | null {
  if (!ISO_INSTANT.test(value)) return null;

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;

  // Дата-переполнение: '2026-02-30T00:00:00Z' проходит regex и Date.parse, но
  // соответствует 2 марта. Сверяем календарную часть с тем, что получилось.
  const iso = new Date(parsed).toISOString();
  if (iso.slice(0, 10) !== value.slice(0, 10) && value.endsWith('Z')) return null;

  return parsed;
}

/**
 * Годен ли unit к рассмотрению вообще — независимо от конкретного вопроса.
 *
 * Проверяет ровно то, что перечисляет план для этой функции: статус, ревью
 * (§5), аудиторию (§3.2), окно действия, ревизию источника — и обязательные для
 * `kind` фасеты (§2.1), потому что оставленная в `UNKNOWN` обязательная ось
 * означает, что unit не знает, к чему он применим.
 *
 * Два разных «нет» разведены намеренно. `eligible === false` — unit выбывает
 * (это всегда ДОСТОВЕРНОЕ условие: архивный статус, истёкшее окно, чужая
 * аудитория, неподтверждённое знание в клиентском канале). `autoAnswerAllowed
 * === false` при `eligible === true` — unit остаётся кандидатом, но ответ на
 * его основе не уходит автоматически. Схлопывание этих двух состояний в один
 * boolean и есть то самое «жёсткая фильтрация убила recall».
 */
export function evaluateUnitEligibility(
  unit: KnowledgeUnitLike,
  requestContext: RequestContext
): EligibilityDecision {
  const reasons: EligibilityReasonCode[] = [];
  const blockingReasons: EligibilityReasonCode[] = [];
  let requiresHumanReview = false;

  const block = (reason: EligibilityReasonCode) => {
    reasons.push(reason);
    blockingReasons.push(reason);
  };
  const note = (reason: EligibilityReasonCode) => {
    reasons.push(reason);
  };

  if (unit.status !== 'ACTIVE') {
    block('unit_status_not_active');
  }

  // Окно действия. Нечитаемое окно (конец раньше начала) — не «нет ограничения»,
  // а сломанные данные: доверять такому unit'у нельзя ни в каком канале.
  const now = parseInstant(requestContext.now);
  const from = unit.validFrom === null ? null : parseInstant(unit.validFrom);
  const until = unit.validUntil === null ? null : parseInstant(unit.validUntil);
  if (
    (unit.validFrom !== null && from === null) ||
    (unit.validUntil !== null && until === null) ||
    now === null ||
    (from !== null && until !== null && until < from)
  ) {
    block('validity_window_malformed');
  } else {
    if (from !== null && now < from) block('validity_not_started');
    if (until !== null && now > until) block('validity_expired');
  }

  const audience = audienceOutcome(unit.profile.audience, requestContext.audience);
  if (audience.reason !== undefined) {
    if (audience.verdict === 'CONFLICT') {
      block(audience.reason);
    } else {
      // UNKNOWN по аудитории для оператора: показать можно, автоматически — нет.
      note(audience.reason);
      requiresHumanReview = true;
    }
  }

  // §5: для клиента `UNCLASSIFIED` — гейт НА ВХОДЕ, жёстче любого CONFLICT по
  // отдельному измерению: unit не доходит до §3 вообще. Для оператора он
  // участвует как обычно — оператор и есть линия защиты.
  const reviewStatus: ReviewStatus = unit.profile.reviewStatus;
  if (reviewStatus === 'UNCLASSIFIED') {
    if (requestContext.audience === 'client') {
      block('review_unclassified_for_client');
    } else {
      note('review_unclassified_for_internal');
      requiresHumanReview = true;
    }
  }

  // §2.1 в рантайме: обязательная ось обязана быть SCOPED или GLOBAL.
  const kind: KnowledgeUnitKind = unit.profile.kind;
  const unknownRequiredFacets: FacetKey[] = [];
  const absentRequiredFacets: FacetKey[] = [];
  for (const facet of requiredFacetsOf(kind)) {
    const state = unit.profile.facets[facet];
    if (state === undefined) {
      absentRequiredFacets.push(facet);
    } else if (state.state === 'UNKNOWN') {
      unknownRequiredFacets.push(facet);
    }
  }

  if (absentRequiredFacets.length > 0) {
    // Ключа нет вовсе — по контракту B1 это NOT_APPLICABLE, а реестр говорит
    // «обязательна». Профиль противоречит сам себе, и это ДОСТОВЕРНЫЙ дефект,
    // а не неизвестность: оценивать такой unit нечем ни в каком канале.
    block('required_facet_absent');
  }

  if (unknownRequiredFacets.length > 0) {
    note('required_facet_unknown');
    // Условная рантайм-часть, которую truth table §2.1 явно оставила за этой
    // функцией: в клиентский АВТОответ unit с неизвестной обязательной осью не
    // идёт. Но и не выбывает — оператору он по-прежнему виден.
    if (requestContext.audience === 'client') {
      requiresHumanReview = true;
    }
  }

  // Ревизия источника. По принципу §4.2 (governance включается по факту
  // заполненного поля, а не «предположительно»): сверять нечего — фиксируем
  // след, но не блокируем; сверили и разошлось — блокируем.
  if (unit.sourceRevision === null) {
    note('source_revision_unverified');
  } else {
    const known = requestContext.currentSourceRevisions?.[unit.sourceRevision.documentId];
    if (known === undefined) {
      note('source_revision_unverified');
    } else if (unit.sourceRevision.revision < known) {
      block('source_revision_stale');
    } else if (unit.sourceRevision.revision > known) {
      block('source_revision_ahead_of_source');
    }
  }

  const eligible = blockingReasons.length === 0;

  return {
    eligible,
    autoAnswerAllowed: eligible && !requiresHumanReview,
    requiresHumanReview,
    unknownRequiredFacets,
    absentRequiredFacets,
    blockingReasons,
    reasons,
  };
}
