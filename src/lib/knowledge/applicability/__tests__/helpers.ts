import type { FacetMap, FacetState } from '../facets';
import type { KnowledgeUnitLike, RequestContext } from '../eligibility';
import type { KnowledgeUnitKind } from '../kinds';
import type { ApplicabilityProfile, ProfileAudience } from '../profile';
import {
  UNKNOWN_QUERY_FACETS,
  UNKNOWN_TRIGGER_FACTS,
  type QueryFacetMap,
  type QueryFacetState,
  type QueryFactMap,
  type QueryFactState,
  type QueryFrame,
  type QuestionAspect,
} from '../query-frame';
import type { ReviewStatus } from '../review';

/**
 * Конструкторы фикстур для suite'ов PR B2.
 *
 * Не `.test.ts` намеренно: vitest забирает только `*.test.ts`, и этот модуль
 * остаётся библиотекой, а не пустым тестовым файлом.
 *
 * Все конструкторы собирают ПОЛНЫЕ структуры контракта B1 — карты запроса со
 * всеми ключами, тройку ревью в легальной комбинации. Частичная фикстура
 * доказывала бы поведение на данных, которых схема не пропустит, то есть не
 * доказывала бы ничего.
 */

const EVIDENCE = Object.freeze([
  Object.freeze({ source: 'CURRENT_MESSAGE' as const, quote: 'фикстура теста' }),
]);

export function known<T>(include: readonly T[], exclude: readonly T[] = []): QueryFacetState<T> {
  return { state: 'KNOWN', include, exclude, evidence: EVIDENCE };
}

export function unknown<T>(): QueryFacetState<T> {
  return { state: 'UNKNOWN' };
}

export function fact<T>(value: T): QueryFactState<T> {
  return { state: 'KNOWN', value, evidence: EVIDENCE };
}

export function buildQuery(
  overrides: {
    readonly facets?: Partial<QueryFacetMap>;
    readonly triggerFacts?: Partial<QueryFactMap>;
    readonly concepts?: readonly string[];
    readonly questionAspects?: readonly QuestionAspect[];
    readonly ambiguities?: readonly string[];
  } = {}
): QueryFrame {
  return {
    concepts: overrides.concepts ?? [],
    facets: { ...UNKNOWN_QUERY_FACETS, ...overrides.facets },
    triggerFacts: { ...UNKNOWN_TRIGGER_FACTS, ...overrides.triggerFacts },
    questionAspects: overrides.questionAspects ?? ['PROCEDURE'],
    ambiguities: overrides.ambiguities ?? [],
  };
}

export const REVIEWED = Object.freeze({
  reviewStatus: 'REVIEWED' as ReviewStatus,
  reviewedBy: 'operator-1',
  reviewedAt: '2026-08-06T10:00:00Z',
});

export const UNCLASSIFIED = Object.freeze({
  reviewStatus: 'UNCLASSIFIED' as ReviewStatus,
  reviewedBy: null,
  reviewedAt: null,
});

/** Состояние `GLOBAL` с аудит-полями — легально только на `REVIEWED`-профиле. */
export function global<T>(): FacetState<T> {
  return { state: 'GLOBAL', reviewedBy: REVIEWED.reviewedBy, reviewedAt: REVIEWED.reviewedAt };
}

export function scoped<T>(include: readonly T[], exclude?: readonly T[]): FacetState<T> {
  return exclude === undefined
    ? { state: 'SCOPED', include }
    : { state: 'SCOPED', include, exclude };
}

export function buildProfile(
  kind: KnowledgeUnitKind,
  facets: FacetMap,
  overrides: {
    readonly audience?: ProfileAudience;
    readonly review?: Pick<ApplicabilityProfile, 'reviewStatus' | 'reviewedBy' | 'reviewedAt'>;
  } = {}
): ApplicabilityProfile {
  return {
    kind,
    facets,
    audience: overrides.audience ?? 'CLIENT_SAFE',
    ...(overrides.review ?? REVIEWED),
  };
}

/** Профиль, у которого `audience` может быть `null` — см. `KnowledgeUnitLike`. */
export function buildUnit(
  overrides: {
    readonly unitId?: string;
    readonly status?: KnowledgeUnitLike['status'];
    readonly kind?: KnowledgeUnitKind;
    readonly facets?: FacetMap;
    readonly audience?: ProfileAudience | null;
    readonly review?: Pick<ApplicabilityProfile, 'reviewStatus' | 'reviewedBy' | 'reviewedAt'>;
    readonly validFrom?: string | null;
    readonly validUntil?: string | null;
    readonly sourceRevision?: KnowledgeUnitLike['sourceRevision'];
  } = {}
): KnowledgeUnitLike {
  const kind = overrides.kind ?? 'PROCEDURE_STEP';
  return {
    unitId: overrides.unitId ?? 'u-1',
    status: overrides.status ?? 'ACTIVE',
    profile: {
      kind,
      facets: overrides.facets ?? { scenario: scoped(['apostille']) },
      audience: overrides.audience === undefined ? 'CLIENT_SAFE' : overrides.audience,
      ...(overrides.review ?? REVIEWED),
    },
    validFrom: overrides.validFrom ?? null,
    validUntil: overrides.validUntil ?? null,
    sourceRevision: overrides.sourceRevision ?? null,
  };
}

export function buildRequestContext(
  overrides: Partial<RequestContext> = {}
): RequestContext {
  return {
    audience: overrides.audience ?? 'client',
    now: overrides.now ?? '2026-08-06T12:00:00Z',
    ...(overrides.currentSourceRevisions === undefined
      ? {}
      : { currentSourceRevisions: overrides.currentSourceRevisions }),
  };
}
