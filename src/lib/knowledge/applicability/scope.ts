// `ancestorsOf` — чисто строковая функция над dot-notation ключом (никакой БД);
// используется, чтобы иерархия сценариев §3.1 жила в ОДНОМ месте, а не была
// переписана здесь второй, расходящейся копией.
import { ancestorsOf } from '@/lib/knowledge/scenarios';
import type { FacetKey, FacetState } from './facets';
import { applicableFacetsOf, requiredFacetsOf } from './kinds';
import type { ApplicabilityProfile } from './profile';
import type { QueryFacetState, QueryFrame } from './query-frame';
import { scopeReason, type ScopeReasonCode, type ScopeSituation } from './reasons';

/**
 * Вердикт по паре (профиль, запрос) — truth table §3.
 *
 * Три значения, и `UNKNOWN` НЕ является ни `MATCH`, ни `GLOBAL`: `GLOBAL` — это
 * подтверждённое человеком «применимо ко всему» (§1, §5), `UNKNOWN` — «мы не
 * знаем». Слить их значило бы вернуть тот самый ложный wildcard, ради запрета
 * которого §1 и написан.
 */
export type ScopeVerdict = 'MATCH' | 'CONFLICT' | 'UNKNOWN';

export interface FacetScopeVerdict {
  readonly facet: FacetKey;
  readonly verdict: ScopeVerdict;
  readonly reason: ScopeReasonCode;
}

export interface ScopeDecision {
  /**
   * Агрегация §3: `CONFLICT`, если хотя бы одна ПРИМЕНИМАЯ ось дала CONFLICT;
   * иначе `UNKNOWN`, если хотя бы одна дала UNKNOWN; иначе `MATCH`.
   * Неприменимые оси не голосуют вообще.
   */
  readonly verdict: ScopeVerdict;
  /** Ровно применимые оси `KNOWLEDGE_KIND_REGISTRY[kind]`, в порядке реестра. */
  readonly facetVerdicts: readonly FacetScopeVerdict[];
  /**
   * Обязательные для `kind` оси, по которым НЕТ сигнала В ЗАПРОСЕ.
   *
   * Вычисляется ЗДЕСЬ, сравнением `QueryFrame.facets` с
   * `requiredFacetsOf(profile.kind)`: в `QueryFrame` такого поля нет намеренно
   * (см. `query-frame.ts`) — это не факт вопроса, а результат сравнения вопроса
   * с требованиями конкретного `kind`, и вторая копия этой логики в
   * LLM-построителе неминуемо разошлась бы с реестром.
   *
   * Это утверждение о ЗАПРОСЕ, а не о паре: если профиль по той же оси
   * `GLOBAL`, ось всё равно попадёт сюда (вопрос действительно её не назвал),
   * но вердикт пары будет `MATCH`, и уточнять для ЭТОГО unit'а нечего.
   */
  readonly missingFacets: readonly FacetKey[];
  readonly conflictingFacets: readonly FacetKey[];
  readonly unknownFacets: readonly FacetKey[];
  /**
   * Сигнал «по этому unit'у уверенного ответа нет». Итоговое решение —
   * уточнять, держать или отвечать — принимает `resolveKnowledgeSet`: оно одно
   * видит, конкурирует ли неизвестность с другими кандидатами.
   */
  readonly requiresClarification: boolean;
  readonly reasons: readonly ScopeReasonCode[];
}

/**
 * Покрывает ли `broader` значение `narrower` на этой оси.
 *
 * Для `scenario` — иерархия: профиль `apostille` покрывает запрос
 * `apostille.zags.spb` (§3.1, «профиль = S или предок S»). Для остальных осей
 * покрытие — это равенство: у кода страны и кода города иерархии нет.
 *
 * Синтаксическое сравнение — осознанное ограничение до Задачи 2.2: «апостиль» и
 * `apostille.zags` без контролируемого словаря не совпадут (truth table §3.4).
 */
function facetCovers(facet: FacetKey, broader: string, narrower: string): boolean {
  if (facet === 'scenario') {
    return ancestorsOf(narrower).includes(broader);
  }
  return broader === narrower;
}

type PairOutcome = Extract<ScopeSituation, 'match_exact' | 'conflict_value' | 'unknown_profile_more_specific'>;

/** Одно значение профиля против одного значения запроса — ячейка матрицы §3.1. */
function comparePair(facet: FacetKey, profileValue: string, queryValue: string): PairOutcome {
  if (facetCovers(facet, profileValue, queryValue)) return 'match_exact';
  // Профиль строго специфичнее запроса: специфичность должна быть подтверждена
  // запросом, а не предположена (§3.1) — потому UNKNOWN, а не MATCH.
  if (facetCovers(facet, queryValue, profileValue)) return 'unknown_profile_more_specific';
  return 'conflict_value';
}

const PAIR_PRIORITY: Record<PairOutcome, number> = {
  match_exact: 0,
  unknown_profile_more_specific: 1,
  conflict_value: 2,
};

/**
 * `include` — дизъюнкция: профиль применим к ЛЮБОМУ из значений, вопрос — про
 * ЛЮБОЕ из своих. Достаточно одной совпавшей пары, чтобы ось совпала; и лучше
 * `UNKNOWN`, чем `CONFLICT`, если хоть одна пара оставляет надежду — жёсткая
 * фильтрация не должна убивать recall.
 */
function bestOutcome(outcomes: readonly PairOutcome[]): PairOutcome {
  // Затравка — худший исход: пустой `include` на профиле означает «применимо ни
  // к чему» и по B1 нелегален; получить из него MATCH было бы чёрным ходом к
  // wildcard в обход `GLOBAL`, поэтому здесь fail-closed, а не бросок исключения.
  return outcomes.reduce<PairOutcome>(
    (best, next) => (PAIR_PRIORITY[next] < PAIR_PRIORITY[best] ? next : best),
    'conflict_value'
  );
}

const SITUATION_VERDICT: Record<ScopeSituation, ScopeVerdict> = {
  match_exact: 'MATCH',
  match_global: 'MATCH',
  conflict_value: 'CONFLICT',
  conflict_excluded_by_profile: 'CONFLICT',
  conflict_excluded_by_query: 'CONFLICT',
  unknown_query_signal: 'UNKNOWN',
  unknown_profile_scope: 'UNKNOWN',
  unknown_profile_state_absent: 'UNKNOWN',
  unknown_profile_more_specific: 'UNKNOWN',
  missing_in_query: 'UNKNOWN',
};

function evaluateFacet(
  facet: FacetKey,
  profileState: FacetState<string> | undefined,
  queryState: QueryFacetState<string>
): ScopeSituation {
  // Ось применима к kind, но ключа нет — профиль противоречит реестру.
  // Fail-closed: UNKNOWN, никогда не MATCH.
  if (profileState === undefined) return 'unknown_profile_state_absent';

  // GLOBAL проверяется ПЕРВЫМ и покрывает в том числе нераспознанный запрос:
  // §3.1/§3.3/§3.4 дают MATCH в строке GLOBAL для любой колонки, включая
  // «не распознан». Это единственный wildcard, и он прошёл ревью человеком.
  if (profileState.state === 'GLOBAL') return 'match_global';

  // Профиль не заполнен — строка «профиль не заполнен» §3.1: UNKNOWN во всех
  // колонках. Порядок с проверкой запроса роли не играет, обе дают UNKNOWN.
  if (profileState.state === 'UNKNOWN') return 'unknown_profile_scope';

  if (queryState.state === 'UNKNOWN') return 'unknown_query_signal';

  const profileInclude = profileState.include;
  const profileExclude = profileState.exclude ?? [];

  // Отрицание на стороне запроса («нужен НЕ апостиль»): если ВСЁ, что покрывает
  // профиль, вопрос явно отверг — это честный CONFLICT, а не пробел.
  if (
    queryState.exclude.length > 0 &&
    profileInclude.every((value) =>
      queryState.exclude.some((excluded) => facetCovers(facet, excluded, value))
    )
  ) {
    return 'conflict_excluded_by_query';
  }

  if (queryState.include.length === 0) {
    // Известно только, чем вопрос НЕ является. Этого хватает, чтобы отвергнуть
    // (случай выше), но не хватает, чтобы подтвердить.
    return 'unknown_query_signal';
  }

  const outcomes: PairOutcome[] = [];
  let excludedByProfile = false;

  for (const queryValue of queryState.include) {
    if (profileExclude.some((excluded) => facetCovers(facet, excluded, queryValue))) {
      excludedByProfile = true;
      outcomes.push('conflict_value');
      continue;
    }
    outcomes.push(
      bestOutcome(profileInclude.map((profileValue) => comparePair(facet, profileValue, queryValue)))
    );
  }

  const best = bestOutcome(outcomes);
  if (best === 'conflict_value' && excludedByProfile) return 'conflict_excluded_by_profile';
  return best;
}

const VERDICT_PRIORITY: Record<ScopeVerdict, number> = { CONFLICT: 0, UNKNOWN: 1, MATCH: 2 };

/**
 * Совпадает ли scope знания с фасетами вопроса — truth table §3.
 *
 * Голосуют ТОЛЬКО оси из `applicableFacetsOf(profile.kind)`. Ось вне этого
 * списка — NOT_APPLICABLE: она не голосует ни за, ни против и не даёт UNKNOWN.
 * Именно поэтому здесь перебирается реестр, а не `Object.keys(profile.facets)`:
 * ключ, попавший в карту вопреки контракту, не должен получить право голоса
 * (см. `kinds.ts` — разница NOT_APPLICABLE и UNKNOWN держится структурно).
 *
 * `audience` здесь не проверяется намеренно: по truth table §3.2 аудитория
 * запроса приходит из контекста вызова, а не из текста вопроса, и её в
 * `QueryFrame` нет. Эта ось — предмет `evaluateUnitEligibility`.
 */
export function evaluateScope(profile: ApplicabilityProfile, query: QueryFrame): ScopeDecision {
  const facetVerdicts: FacetScopeVerdict[] = [];
  const reasons: ScopeReasonCode[] = [];
  const conflictingFacets: FacetKey[] = [];
  const unknownFacets: FacetKey[] = [];

  for (const facet of applicableFacetsOf(profile.kind)) {
    const situation = evaluateFacet(
      facet,
      profile.facets[facet] as FacetState<string> | undefined,
      query.facets[facet] as QueryFacetState<string>
    );
    const verdict = SITUATION_VERDICT[situation];
    const reason = scopeReason(facet, situation);

    facetVerdicts.push({ facet, verdict, reason });
    reasons.push(reason);
    if (verdict === 'CONFLICT') conflictingFacets.push(facet);
    if (verdict === 'UNKNOWN') unknownFacets.push(facet);
  }

  // `missingFacets` — про ЗАПРОС, не про пару: обязательная для kind ось, по
  // которой вопрос не дал сигнала. Считается по реестру, а не по вердиктам,
  // потому что вердикт может быть MATCH за счёт GLOBAL на профиле.
  const missingFacets = requiredFacetsOf(profile.kind).filter(
    (facet) => query.facets[facet].state === 'UNKNOWN'
  );
  for (const facet of missingFacets) {
    reasons.push(scopeReason(facet, 'missing_in_query'));
  }

  const verdict = facetVerdicts.reduce<ScopeVerdict>(
    (worst, entry) => (VERDICT_PRIORITY[entry.verdict] < VERDICT_PRIORITY[worst] ? entry.verdict : worst),
    'MATCH'
  );

  return {
    verdict,
    facetVerdicts,
    missingFacets,
    conflictingFacets,
    unknownFacets,
    requiresClarification: verdict === 'UNKNOWN',
    reasons,
  };
}
