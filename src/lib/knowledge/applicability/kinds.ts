import { z } from 'zod';
import type { FacetKey } from './facets';

/**
 * Реестр видов знания: какие фасеты применимы к каждому `kind` и какие из них
 * обязательны.
 *
 * ПЕРЕНЕСЁН ДОСЛОВНО из `docs/plans/2026-08-05-applicability-truth-table.md`
 * §2.1 — truth table объявлена там единственным источником истины, и
 * расхождение кода с ней считается ошибкой кода, а не поводом «согласовать».
 *
 * Именно этот реестр отличает NOT_APPLICABLE от UNKNOWN: фасета вне
 * `applicableFacets` обязана ОТСУТСТВОВАТЬ в `facets` (ось не действует и не
 * голосует), фасета внутри — обязана присутствовать хотя бы со значением
 * `{ state: 'UNKNOWN' }` (ось действует, значение не известно). Склейка этих
 * двух случаев в одно «поле пустое» — тот самый дефект `scenarioKey=null`,
 * ради которого весь контракт и существует.
 */
export const KNOWLEDGE_KIND_REGISTRY = {
  PROCEDURE_STEP: {
    applicableFacets: ['scenario'],
    requiredFacets: ['scenario'],
  },
  EXCEPTION_RULE: {
    applicableFacets: ['scenario'],
    requiredFacets: ['scenario'],
  },
  TERM_DEFINITION: {
    // Пустой список ФАСЕТ — намеренно: truth table §2 явно исключает `scenario`
    // из применимых для этого kind. Это НЕ значит «в §3 голосовать нечему»:
    // применимое измерение `audience` у этого kind есть, оно голосует в §3.2 и
    // обязательно — просто `audience` не фасета и потому в этот реестр не
    // входит. Ровно эта разница закрывает находку про «вакуумный MATCH».
    applicableFacets: [],
    requiredFacets: [],
  },
  DELIVERY_RULE: {
    applicableFacets: ['scenario', 'deliveryCity'],
    requiredFacets: ['scenario', 'deliveryCity'],
  },
  PRICE_RULE: {
    applicableFacets: ['scenario', 'service'],
    requiredFacets: ['scenario', 'service'],
  },
} as const satisfies Record<
  string,
  { readonly applicableFacets: readonly FacetKey[]; readonly requiredFacets: readonly FacetKey[] }
>;

export type KnowledgeUnitKind = keyof typeof KNOWLEDGE_KIND_REGISTRY;

export const KNOWLEDGE_UNIT_KINDS: readonly KnowledgeUnitKind[] = Object.freeze(
  Object.keys(KNOWLEDGE_KIND_REGISTRY) as KnowledgeUnitKind[]
);

export const knowledgeUnitKindSchema = z.enum(
  Object.keys(KNOWLEDGE_KIND_REGISTRY) as [KnowledgeUnitKind, ...KnowledgeUnitKind[]]
);

type Assert<T extends true> = T;

/**
 * `requiredFacets ⊆ applicableFacets` (truth table §2.1) — проверка на этапе
 * компиляции, а не только теста: обязательная, но неприменимая фасета сделала
 * бы `kind` невалидируемым в принципе (ключ обязан отсутствовать и обязан быть
 * заполнен одновременно).
 */
type _RequiredIsSubsetOfApplicable = Assert<
  {
    [K in KnowledgeUnitKind]: (typeof KNOWLEDGE_KIND_REGISTRY)[K]['requiredFacets'][number] extends (typeof KNOWLEDGE_KIND_REGISTRY)[K]['applicableFacets'][number]
      ? true
      : false;
  }[KnowledgeUnitKind]
>;

export function applicableFacetsOf(kind: KnowledgeUnitKind): readonly FacetKey[] {
  return KNOWLEDGE_KIND_REGISTRY[kind].applicableFacets;
}

export function requiredFacetsOf(kind: KnowledgeUnitKind): readonly FacetKey[] {
  return KNOWLEDGE_KIND_REGISTRY[kind].requiredFacets;
}

/**
 * `false` здесь означает именно NOT_APPLICABLE — ось не действует для этого
 * вида знания и не участвует в агрегации §3, а не «значение неизвестно».
 */
export function isFacetApplicableTo(kind: KnowledgeUnitKind, facet: FacetKey): boolean {
  return applicableFacetsOf(kind).includes(facet);
}

export function isFacetRequiredFor(kind: KnowledgeUnitKind, facet: FacetKey): boolean {
  return requiredFacetsOf(kind).includes(facet);
}
