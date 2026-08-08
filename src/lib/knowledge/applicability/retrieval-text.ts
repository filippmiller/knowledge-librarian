import { CONCEPT_VOCABULARY_BY_FACET } from './concept-registry';
import { isKnownConcept } from './concepts';
import { FACET_KEYS, type FacetKey } from './facets';
import type { PersistedKnowledgeUnit } from './identity-assignment';
import { TRIGGER_FACT_REGISTRY, type TriggerFactKey } from './trigger-facts';
import { getScenario } from '@/lib/knowledge/scenarios';

/**
 * Индексируемый текст unit'а (PR G, план §3). НЕ только `statement`:
 * "не более 15 секунд подряд" обязано находиться вопросом "как долго можно
 * водить пальцами", а изолированный statement числового фрагмента этого не
 * несёт — сематическая связь с "почёсыванием" живёт в РОДИТЕЛЬСКОМ unit'е,
 * в исходной цитате и в facets/условиях, не в самой фразе про секунды.
 */

function labelForFacetValue(key: FacetKey, value: string): string | undefined {
  const vocabulary = CONCEPT_VOCABULARY_BY_FACET[key];
  if (!vocabulary || !isKnownConcept(vocabulary, value)) return undefined;
  return vocabulary[value].label;
}

function facetsText(unit: PersistedKnowledgeUnit): string[] {
  const parts: string[] = [];
  for (const key of FACET_KEYS) {
    const value = unit.facets[key];
    if (value === undefined) continue;
    const label = labelForFacetValue(key, value);
    if (label) parts.push(label);
  }
  return parts;
}

/** `scenario`/`documentForm` — единственные facets БЕЗ записи в
 *  `CONCEPT_VOCABULARY_BY_FACET` (`concept-registry.ts`, "обрабатываются
 *  отдельно на месте использования"). `facetsText()` их поэтому молча
 *  пропускает — это то самое "место использования". */
const DOCUMENT_FORM_LABELS: Record<string, string> = {
  ORIGINAL: 'оригинал',
  SCAN: 'скан',
  COPY: 'копия',
};

function scenarioText(unit: PersistedKnowledgeUnit): string[] {
  const value = unit.facets.scenario;
  if (value === undefined) return [];
  const label = getScenario(value)?.label;
  return label ? [label] : [];
}

function documentFormText(unit: PersistedKnowledgeUnit): string[] {
  const value = unit.facets.documentForm;
  if (value === undefined) return [];
  const label = DOCUMENT_FORM_LABELS[value];
  return label ? [label] : [];
}

function triggerConditionText(unit: PersistedKnowledgeUnit): string[] {
  if (!unit.triggerCondition) return [];
  return unit.triggerCondition.all.map((clause) => {
    const fact = clause.fact as TriggerFactKey;
    const description = TRIGGER_FACT_REGISTRY[fact].description;
    return `${description}: ${String(clause.equals)}`;
  });
}

function numericConstraintText(unit: PersistedKnowledgeUnit): string[] {
  if (!unit.numericConstraint) return [];
  const { factKey, value, unit: measureUnit } = unit.numericConstraint;
  return [`${factKey}: ${value} ${measureUnit}`];
}

/**
 * `unitsById` — все units этого прогона (или как минимум родители фрагментов).
 * Родитель ищется по `unit.parentRuleRef` — после preflight C
 * (translation-djc) это ВСЕГДА либо настоящий `unitId`, либо `null`, никогда
 * сырая ссылка (`extractionRef`/anchor не переживают persistence). `if
 * (parent)` здесь — не откат на случай нерезолвившейся ссылки, а защита от
 * ситуации, когда `unitsById`, переданный ЭТИМ вызовом, просто не включает
 * родителя (например, родитель — в `ambiguousDuplicates`, не в основном
 * наборе units): контекст родителя опционален, а не обязателен для
 * построения текста.
 */
export function buildRetrievalText(
  unit: PersistedKnowledgeUnit,
  unitsById: ReadonlyMap<string, PersistedKnowledgeUnit>
): string {
  const parts: string[] = [];

  if (unit.title) parts.push(unit.title);
  parts.push(unit.statement);

  // РОВНО один уровень вверх, намеренно: закрывает регрессию Q04
  // (числовой фрагмент получает контекст своего прямого родителя). Цепочка
  // глубже одного уровня (фрагмент → фрагмент → базовое правило) сегодня НЕ
  // разворачивается — известное ограничение (независимое ревью этого PR),
  // не пропущенный случай: реальные фикстуры фрагментируются на один
  // уровень, а рекурсивный обход потребовал бы защиты от циклов
  // (parentRuleRef, ссылающийся сам на себя транзитивно), которой сегодня
  // негде взяться из PersistedKnowledgeUnit в отрыве от остального прогона.
  if (unit.parentRuleRef !== null) {
    const parent = unitsById.get(unit.parentRuleRef);
    if (parent) parts.push(parent.statement);
  }

  parts.push(unit.sourceSpan.quote);
  parts.push(...facetsText(unit));
  parts.push(...scenarioText(unit));
  parts.push(...documentFormText(unit));
  parts.push(...triggerConditionText(unit));
  parts.push(...numericConstraintText(unit));

  return parts.filter((p) => p.length > 0).join('. ');
}
