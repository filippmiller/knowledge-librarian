import type { EligibilityDecision } from './eligibility';
import type { FacetKey } from './facets';
import type { KnowledgeUnitKind } from './kinds';
import type { QueryFrame } from './query-frame';
import type { ResolutionReasonCode, TriggerReasonCode } from './reasons';
import { ASKABLE_SCOPE_SITUATIONS, type ScopeDecision } from './scope';
import type { TriggerDecision } from './trigger';
import type { TriggerFactKey } from './trigger-facts';

/**
 * Структурное числовое ограничение (truth table §4.1 п.3, §4.2).
 *
 * `factKey` — ЧТО измеряется («максимум секунд удержания»), а не «число из
 * правила»: сравнивать значения имеет смысл только внутри одного факта.
 * Отсутствие поля (`null` на кандидате) означает, что число живёт в прозе —
 * §4.2 прямо говорит, что такой unit governance §4.1 п.3 НЕ блокирует.
 */
export interface NumericConstraint {
  readonly factKey: string;
  readonly value: number;
  readonly unit: string;
}

/** Кандидат, уже прошедший три предыдущих evaluator'а. */
export interface EvaluatedCandidate {
  readonly unitId: string;
  readonly kind: KnowledgeUnitKind;
  readonly eligibility: EligibilityDecision;
  readonly scope: ScopeDecision;
  /** Заполнено только у `EXCEPTION_RULE`; у остальных `kind` — `null`. */
  readonly trigger: TriggerDecision | null;
  /** Source-backed wording for the effective (possibly inherited) trigger. */
  readonly triggerPresentationConditions?: readonly string[];
  /** Runtime graph/condition corruption; unlike an ordinary unknown fact this
   * must never become presentable conditional evidence. */
  readonly triggerInvalid?: boolean;
  /** Set by Decision Relevance. Undefined preserves legacy/test behavior as relevant. */
  readonly semanticRelevance?: 'RELEVANT' | 'IRRELEVANT';
  /** Source-backed proof that this trigger is a necessary (not merely
   * sufficient) condition, so its falsity can justify a denial. */
  readonly negativeInferenceAllowed?: boolean;
  /** На какое правило это исключение навешано (§2.1, обязательно для исключений). */
  readonly parentRuleRef: string | null;
  /** Явная замена: единственный способ разрешить конфликт чисел без человека. */
  readonly supersedes: readonly string[];
  readonly numericConstraint: NumericConstraint | null;
}

export interface ExcludedCandidate {
  readonly unitId: string;
  readonly reason: ResolutionReasonCode;
  /** Кто вытеснил — для `supersedes`. */
  readonly byUnitId?: string;
}

export interface HeldCandidate {
  readonly unitId: string;
  readonly reason: ResolutionReasonCode;
}

export interface OverriddenCandidate {
  readonly unitId: string;
  readonly byUnitId: string;
}

export interface NumericConflict {
  readonly factKey: string;
  readonly reason: Extract<
    ResolutionReasonCode,
    'numeric_conflict_unresolved' | 'numeric_unit_mismatch'
  >;
  readonly entries: readonly {
    readonly unitId: string;
    readonly value: number;
    readonly unit: string;
  }[];
}

export interface ClarificationNeeds {
  readonly facets: readonly FacetKey[];
  readonly triggerFacts: readonly TriggerFactKey[];
  readonly ambiguities: readonly string[];
}

export interface ResolutionDecision {
  /**
   * `ANSWER` — отвечать выбранным набором; `CLARIFY` — известно, ЧТО спросить;
   * `HOLD` — отдать человеку. Три исхода, а не `boolean canAnswer`: «спросить»
   * и «сдаться» — разные действия, и склейка их лишает систему возможности
   * задать вопрос.
   */
  readonly disposition: 'ANSWER' | 'CLARIFY' | 'HOLD';
  readonly selected: readonly string[];
  /** Non-operative evidence usable only to explain a denial. It never
   * participates in override, supersedes, or numeric conflict resolution. */
  readonly negativeEvidence?: readonly string[];
  /**
   * Кандидаты, судьба которых не решена. Ключевое: они НЕ выброшены. `UNKNOWN`
   * не является основанием молча удалить кандидата, и пустой набор кандидатов
   * при живых неизвестностях — недопустимый исход.
   */
  readonly undetermined: readonly HeldCandidate[];
  readonly excluded: readonly ExcludedCandidate[];
  readonly overridden: readonly OverriddenCandidate[];
  readonly numericConflicts: readonly NumericConflict[];
  readonly requiresHumanReview: boolean;
  readonly clarificationNeeds: ClarificationNeeds;
  readonly reasons: readonly (ResolutionReasonCode | TriggerReasonCode)[];
  /** How selected evidence may be rendered by synthesis. */
  readonly selectedApplicability?: readonly {
    readonly unitId: string;
    readonly mode: 'NORMAL' | 'CONDITIONAL' | 'NEGATIVE';
    readonly presentationConditions: readonly string[];
  }[];
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * Разрешение отношений между несколькими кандидатами — truth table §4.
 *
 * Чего эта функция намеренно НЕ делает: не отсекает менее специфичные unit'ы
 * «по специфичности сценария». §4.1 п.1 прямо исправляет это прочтение — все
 * `PROCEDURE_STEP`/`TERM_DEFINITION`, прошедшие §3 как MATCH, идут в синтез
 * ВМЕСТЕ («применяются все»), и приоритет специального над общим выражается
 * ТОЛЬКО через явные связи `parentRuleRef` и `supersedes`, а не через сравнение
 * глубины ключей.
 */
/**
 * Все узлы, лежащие на каком-либо цикле `supersedes` внутри выбранного набора.
 *
 * Ищется именно ЦИКЛ, а не пара: `A→B→C→A` состоит из трёх законных на вид дуг,
 * и проверка «а сосед указывает на меня?» её не видит. Раньше такая тройка
 * удаляла сама себя целиком и оставляла пустой набор кандидатов.
 *
 * Обход итеративный (стек), а не рекурсивный: длина цепочки замен приходит из
 * данных, и переполнять ей стек не хочется.
 */
function findSupersedesCycleMembers(
  scope: ReadonlySet<string>,
  byId: ReadonlyMap<string, EvaluatedCandidate>
): Set<string> {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  const members = new Set<string>();

  const edgesFrom = (unitId: string): string[] =>
    (byId.get(unitId)?.supersedes ?? []).filter(
      (targetId) => targetId !== unitId && scope.has(targetId)
    );

  for (const root of scope) {
    if ((colour.get(root) ?? WHITE) !== WHITE) continue;

    const path: string[] = [];
    const stack: { unitId: string; edgeIndex: number }[] = [{ unitId: root, edgeIndex: 0 }];
    colour.set(root, GREY);
    path.push(root);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const edges = edgesFrom(frame.unitId);

      if (frame.edgeIndex >= edges.length) {
        colour.set(frame.unitId, BLACK);
        stack.pop();
        path.pop();
        continue;
      }

      const next = edges[frame.edgeIndex++];
      const nextColour = colour.get(next) ?? WHITE;

      if (nextColour === GREY) {
        // Замкнулись: всё от вхождения `next` в текущий путь и до конца — цикл.
        const start = path.indexOf(next);
        if (start >= 0) for (const unitId of path.slice(start)) members.add(unitId);
        continue;
      }
      if (nextColour === BLACK) continue;

      colour.set(next, GREY);
      path.push(next);
      stack.push({ unitId: next, edgeIndex: 0 });
    }
  }

  return members;
}

export function resolveKnowledgeSet(
  candidates: readonly EvaluatedCandidate[],
  query: QueryFrame
): ResolutionDecision {
  const excluded: ExcludedCandidate[] = [];
  const undetermined: HeldCandidate[] = [];
  const reasons: (ResolutionReasonCode | TriggerReasonCode)[] = [];
  let requiresHumanReview = false;

  const selectedIds: string[] = [];
  const negativeEvidenceIds: string[] = [];
  const undeterminedIds: string[] = [];

  const addReason = (reason: ResolutionReasonCode | TriggerReasonCode) => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  const exclude = (unitId: string, reason: ResolutionReasonCode, byUnitId?: string) => {
    excluded.push(byUnitId === undefined ? { unitId, reason } : { unitId, reason, byUnitId });
    addReason(reason);
  };
  const hold = (unitId: string, reason: ResolutionReasonCode) => {
    undetermined.push({ unitId, reason });
    undeterminedIds.push(unitId);
    addReason(reason);
  };

  // ── Шаг 1. Отсев по достоверным основаниям и удержание неизвестного ────────
  for (const candidate of candidates) {
    if (!candidate.eligibility.eligible) {
      exclude(candidate.unitId, 'candidate_ineligible');
      continue;
    }

    // Единственное основание выбросить кандидата по §3 — ЯВНЫЙ CONFLICT.
    if (candidate.scope.verdict === 'CONFLICT') {
      exclude(candidate.unitId, 'scope_conflict');
      continue;
    }

    const isException = candidate.kind === 'EXCEPTION_RULE';

    if (isException && candidate.trigger === null) {
      exclude(candidate.unitId, 'exception_without_trigger');
      requiresHumanReview = true;
      continue;
    }

    if (candidate.trigger?.verdict === 'INACTIVE') {
      for (const reason of candidate.trigger.reasons) addReason(reason);
      // Exceptions retain their original fail-closed override semantics.
      // A relevant conditional procedure, however, is useful negative
      // evidence: it proves that its necessary condition is absent and lets
      // synthesis deny the action. An irrelevant candidate remains excluded
      // but still contributes structured diagnostic reasons.
      if (isException || candidate.semanticRelevance === 'IRRELEVANT') {
        exclude(candidate.unitId, 'exception_trigger_inactive');
      } else if (candidate.negativeInferenceAllowed === true) {
        negativeEvidenceIds.push(candidate.unitId);
      } else {
        exclude(candidate.unitId, 'exception_trigger_inactive');
      }
      continue;
    }

    if (candidate.scope.verdict === 'UNKNOWN') {
      hold(candidate.unitId, 'scope_unknown_held');
      continue;
    }

    if (candidate.trigger?.verdict === 'UNKNOWN') {
      for (const reason of candidate.trigger.reasons) addReason(reason);
      if (isException || candidate.triggerInvalid === true) {
        hold(candidate.unitId, 'exception_trigger_unknown');
        if (candidate.triggerInvalid === true) requiresHumanReview = true;
      }
      else selectedIds.push(candidate.unitId);
      continue;
    }

    selectedIds.push(candidate.unitId);
    if (candidate.trigger?.verdict === 'ACTIVE') {
      for (const reason of candidate.trigger.reasons) addReason(reason);
      addReason('exception_trigger_active');
    }
  }

  const byId = new Map(candidates.map((candidate) => [candidate.unitId, candidate]));

  // ── Шаг 2. Явная замена (`supersedes`) ────────────────────────────────────
  //
  // Заменять вправе только ВЫБРАННЫЙ кандидат: удержанный сам под вопросом, и
  // позволить ему вытеснить работающее правило значило бы решить неизвестностью.
  //
  // Замена ТРАНЗИТИВНА: если v3 заменяет v2, а v2 — v1, устарели оба. Поэтому
  // заявки собираются одним проходом по ИСХОДНОМУ набору — цепочка снимается
  // целиком, и результат не зависит от порядка обхода.
  //
  // Взаимная замена (A заменяет B и B заменяет A) — противоречие в данных.
  // Применить её порядком нельзя: результат зависел бы от сортировки выдачи, а
  // удаление обоих схлопнуло бы набор кандидатов в пустой — недопустимый исход.
  // Такая пара остаётся на месте и уходит человеку.
  const initiallySelected = new Set(selectedIds);

  // Цикл ищется ПО ВСЕМУ графу, а не только среди прямых пар A↔B. Проверка
  // «сосед указывает на меня» ловила двойки, но тройку A→B→C→A пропускала:
  // каждая дуга по отдельности выглядела законной, все три узла попадали в
  // `supersededBy` и удалялись — набор кандидатов схлопывался в пустой. Узлы
  // цикла остаются на месте и уходят человеку: упорядочить их нечем.
  const inCycle = findSupersedesCycleMembers(initiallySelected, byId);
  if (inCycle.size > 0) {
    addReason('supersedes_cycle_unresolved');
    requiresHumanReview = true;
  }

  const supersededBy = new Map<string, string>();
  for (const unitId of initiallySelected) {
    const candidate = byId.get(unitId);
    if (candidate === undefined || inCycle.has(unitId)) continue;
    for (const targetId of candidate.supersedes) {
      if (targetId === unitId || !initiallySelected.has(targetId)) continue;
      if (inCycle.has(targetId)) continue;
      // Победитель выбирается детерминированно (лексикографически меньший id),
      // а не «кто первым попался»: порядок выдачи кандидатов не должен менять
      // содержимое `excluded[].byUnitId`.
      const current = supersededBy.get(targetId);
      if (current === undefined || unitId < current) supersededBy.set(targetId, unitId);
    }
  }
  for (const [targetId, byUnitId] of supersededBy) {
    const position = selectedIds.indexOf(targetId);
    if (position >= 0) selectedIds.splice(position, 1);
    exclude(targetId, 'superseded_by_newer_unit', byUnitId);
  }

  // ── Шаг 3. Активное исключение переопределяет своего родителя (§4.1 п.2) ──
  const overridden: OverriddenCandidate[] = [];
  for (const unitId of [...selectedIds]) {
    const candidate = byId.get(unitId);
    if (candidate?.kind !== 'EXCEPTION_RULE') continue;

    // Исключение БЕЗ родителя — испорченная запись. Trusted-artifact v4
    // запрещает такую форму на границе доверия, но runtime остаётся
    // fail-closed для миграций, ручного ввода и устаревших артефактов.
    if (candidate.parentRuleRef === null) {
      requiresHumanReview = true;
      addReason('exception_without_parent');
      continue;
    }

    const position = selectedIds.indexOf(candidate.parentRuleRef);
    if (position >= 0) {
      selectedIds.splice(position, 1);
      overridden.push({ unitId: candidate.parentRuleRef, byUnitId: unitId });
      addReason('parent_overridden_by_exception');
      continue;
    }

    // Родитель есть в ссылке, но его нет в выборке: он не пришёл кандидатом,
    // выбыл по CONFLICT или был заменён через `supersedes`. Отдельная ветка
    // ниже ловит только «родитель УДЕРЖАН», а эти случаи раньше просто
    // проваливались молча — переопределять некого, и исключение оставалось
    // единственным выбранным кандидатом, то есть отвечало в одиночку. Для
    // ответа это то же самое, что оговорка без правила.
    if (!byId.has(candidate.parentRuleRef) || !undeterminedIds.includes(candidate.parentRuleRef)) {
      requiresHumanReview = true;
      addReason('exception_parent_unavailable');
    }
  }

  // ── Шаг 4. Конфликт чисел (§4.1 п.3) ─────────────────────────────────────
  const numericConflicts: NumericConflict[] = [];
  const groups = new Map<string, { unitId: string; value: number; unit: string }[]>();
  for (const unitId of selectedIds) {
    const constraint = byId.get(unitId)?.numericConstraint;
    // §4.2: число в прозе без структурного поля в сравнении не участвует —
    // сравнивать нечего, и это честное «не проверено», а не ошибка.
    if (constraint == null) continue;
    const group = groups.get(constraint.factKey) ?? [];
    group.push({ unitId, value: constraint.value, unit: constraint.unit });
    groups.set(constraint.factKey, group);
  }
  for (const [factKey, entries] of groups) {
    if (entries.length < 2) continue;
    const units = unique(entries.map((entry) => entry.unit));
    const values = unique(entries.map((entry) => entry.value));
    if (units.length > 1) {
      numericConflicts.push({ factKey, reason: 'numeric_unit_mismatch', entries });
      addReason('numeric_unit_mismatch');
      requiresHumanReview = true;
    } else if (values.length > 1) {
      numericConflicts.push({ factKey, reason: 'numeric_conflict_unresolved', entries });
      addReason('numeric_conflict_unresolved');
      requiresHumanReview = true;
    }
  }

  // ── Шаг 5. Что именно неизвестно и решает ли это исход ────────────────────
  const viableIds = new Set([...selectedIds, ...undeterminedIds]);

  /**
   * Неизвестность РЕШАЮЩАЯ, если без неё нельзя выбрать между кандидатами:
   * (а) кандидат связан отношением родитель/исключение с другим живым
   *     кандидатом — ровно случай `Q01-M1`/`Q05-M1`, где общее правило и
   *     исключение дают противоположные ответы;
   * (б) он спорит числом с уже выбранным кандидатом на тот же факт;
   * (в) выбирать не из чего вообще — тогда неизвестность решает между ответом
   *     и молчанием.
   * Во всех остальных случаях неизвестный кандидат просто удерживается и
   * никого не заставляет переспрашивать.
   */
  const isDecisive = (candidate: EvaluatedCandidate): boolean => {
    if (selectedIds.length === 0) return true;
    if (candidate.parentRuleRef !== null && viableIds.has(candidate.parentRuleRef)) return true;

    // Исключение с неизвестным условием И БЕЗ parentRuleRef вообще —
    // отдельный, более рискованный случай, чем "ссылка есть, но родителя нет
    // в текущей выдаче" (та ветка ниже уже покрыта и остаётся не-решающей:
    // там известно, с чем спорить нечего). Здесь неизвестно НИЧЕГО о том,
    // какое правило это исключение переопределяет — а значит нельзя
    // исключить, что оно как раз то, что уже уверенно выбрано. Реальная
    // находка (goal-shift benchmark, 2026-08-09, Q01-M1/Q05-M1): экстракция
    // не всегда линкует EXCEPTION_RULE к его родителю (parentRuleRef
    // приходит null чаще, чем предполагалось) — молчаливо считать такое
    // исключение "нерешающим" значило бы отвечать уверенно именно там, где
    // уверенности нет.
    if (candidate.trigger?.verdict === 'UNKNOWN') {
      return true;
    }

    // Неизвестный кандидат, который ЗАМЕНЯЕТ выбранного, — решающий. Шаг 2
    // сознательно даёт заменять только выбранным, поэтому удержанный U тут
    // ничего не удаляет; но если бы U разрешился в MATCH, он снял бы A. Ответить
    // сейчас уверенно из A значило бы ответить устаревшим правилом, зная, что
    // его судьба под вопросом. Обратное направление (выбранный заменяет
    // неизвестного) решающим НЕ является: там неизвестность и так проиграла.
    if (candidate.supersedes.some((targetId) => selectedIds.includes(targetId))) return true;

    for (const otherId of viableIds) {
      if (otherId === candidate.unitId) continue;
      const other = byId.get(otherId);
      if (other === undefined) continue;
      if (other.parentRuleRef === candidate.unitId) return true;
      if (
        candidate.numericConstraint != null &&
        other.numericConstraint != null &&
        selectedIds.includes(otherId) &&
        other.numericConstraint.factKey === candidate.numericConstraint.factKey &&
        (other.numericConstraint.value !== candidate.numericConstraint.value ||
          other.numericConstraint.unit !== candidate.numericConstraint.unit)
      ) {
        return true;
      }
    }
    return false;
  };

  const clarificationFacets: FacetKey[] = [];
  const clarificationTriggerFacts: TriggerFactKey[] = [];
  for (const held of undetermined) {
    const candidate = byId.get(held.unitId);
    if (candidate === undefined || !isDecisive(candidate)) continue;

    let askedAboutSomething = false;

    if (held.reason === 'scope_unknown_held') {
      // Спрашиваем по ПРИЧИНЕ неизвестности, а не по `missingFacets`: последнее
      // считается по состоянию `UNKNOWN` в запросе и не покрывает ни строку
      // «профиль специфичнее вопроса», ни запрос, у которого есть только
      // `exclude`. Обе эти неизвестности снимаются вопросом, и молча
      // проглотить их значило бы ответить уверенно там, где спросить можно.
      for (const facetVerdict of candidate.scope.facetVerdicts) {
        if (facetVerdict.verdict !== 'UNKNOWN') continue;
        if (ASKABLE_SCOPE_SITUATIONS.includes(facetVerdict.situation)) {
          clarificationFacets.push(facetVerdict.facet);
          askedAboutSomething = true;
        }
      }
    }

    if (held.reason === 'exception_trigger_unknown' && candidate.trigger !== null) {
      clarificationTriggerFacts.push(...candidate.trigger.missingFacts);
      if (candidate.trigger.missingFacts.length > 0) askedAboutSomething = true;
    }

    if (!askedAboutSomething) {
      // Неизвестность решающая, но снять её вопросом нельзя: знание не
      // размечено, ключа нет вопреки реестру или условие исключения пусто.
      // Ответить, сделав вид, что кандидата нет, — недопустимо.
      requiresHumanReview = true;
      addReason('knowledge_gap_requires_human_review');
    }
  }

  // Исключение выбрано, а правило, которое оно переопределяет, осталось
  // неопределённым: применить поправку к правилу неизвестной применимости
  // нельзя, а ответить одной поправкой — тем более.
  for (const unitId of selectedIds) {
    const candidate = byId.get(unitId);
    if (candidate?.kind !== 'EXCEPTION_RULE' || candidate.parentRuleRef === null) continue;
    if (undeterminedIds.includes(candidate.parentRuleRef)) {
      requiresHumanReview = true;
      addReason('exception_parent_undetermined');
    }
  }

  const clarificationNeeds: ClarificationNeeds = {
    facets: unique(clarificationFacets),
    triggerFacts: unique(clarificationTriggerFacts),
    // Построитель фрейма уже зафиксировал, что вопрос неоднозначен (например,
    // текущее сообщение противоречит истории). Ответить, проигнорировав это, —
    // тот же молчаливый override, который PR D специально отказался делать.
    ambiguities: unique(query.ambiguities),
  };

  if (clarificationNeeds.facets.length > 0) addReason('clarification_required_missing_facet');
  if (clarificationNeeds.triggerFacts.length > 0) {
    addReason('clarification_required_missing_trigger_fact');
  }
  if (clarificationNeeds.ambiguities.length > 0) addReason('clarification_required_query_ambiguity');

  for (const unitId of selectedIds) {
    if (byId.get(unitId)?.eligibility.requiresHumanReview === true) {
      requiresHumanReview = true;
      addReason('candidate_requires_human_review');
    }
  }

  if (selectedIds.length === 0 && negativeEvidenceIds.length === 0) addReason('no_selected_candidates');

  const needsClarification =
    clarificationNeeds.facets.length > 0 ||
    clarificationNeeds.triggerFacts.length > 0 ||
    clarificationNeeds.ambiguities.length > 0;

  // Спросить лучше, чем сдаться: `CLARIFY` идёт первым, потому что система
  // знает, ЧТО именно спросить. `HOLD` — когда сказать нечего или когда данные
  // противоречат друг другу и решать должен человек.
  const disposition: ResolutionDecision['disposition'] = needsClarification
    ? 'CLARIFY'
    : requiresHumanReview || (selectedIds.length === 0 && negativeEvidenceIds.length === 0)
      ? 'HOLD'
      : 'ANSWER';

  const selectedApplicability = [...selectedIds, ...negativeEvidenceIds].map((unitId) => {
    const candidate = byId.get(unitId)!;
    const mode = candidate.kind !== 'EXCEPTION_RULE' && candidate.trigger?.verdict === 'UNKNOWN'
      ? 'CONDITIONAL' as const
      : candidate.kind !== 'EXCEPTION_RULE' && candidate.trigger?.verdict === 'INACTIVE'
        ? 'NEGATIVE' as const
        : 'NORMAL' as const;
    return {
      unitId,
      mode,
      presentationConditions: candidate.triggerPresentationConditions ?? [],
    };
  });

  return {
    disposition,
    selected: selectedIds,
    negativeEvidence: negativeEvidenceIds,
    undetermined,
    excluded,
    overridden,
    numericConflicts,
    requiresHumanReview,
    clarificationNeeds,
    reasons,
    selectedApplicability,
  };
}
