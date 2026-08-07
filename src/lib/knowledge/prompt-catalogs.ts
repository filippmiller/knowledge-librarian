import {
  CITY_CONCEPTS,
  COUNTRY_CONCEPTS,
  DOCUMENT_TYPE_CONCEPTS,
  LANGUAGE_CONCEPTS,
  PARTNER_CONCEPTS,
  SERVICE_CONCEPTS,
} from './applicability/concept-registry';
import type { ConceptVocabulary } from './applicability/concepts';
import { FACET_KEYS, FACET_REGISTRY, type FacetKey } from './applicability/facets';
import { TRIGGER_FACT_KEYS, TRIGGER_FACT_REGISTRY } from './applicability/trigger-facts';
import { SCENARIOS } from './scenarios';

/**
 * Компактные текстовые описания реестров для LLM-промптов (PR D, PR E).
 * Единственное место, где реестры превращаются в текст для модели — оба
 * экстрактора (query-frame-extractor.ts, knowledge-unit-extractor.ts) читают
 * отсюда, а не держат каждый свою копию.
 */

const CONCEPT_VOCABULARIES: Partial<Record<FacetKey, { name: string; vocabulary: ConceptVocabulary }>> = {
  service: { name: 'SERVICE_CONCEPTS', vocabulary: SERVICE_CONCEPTS },
  documentType: { name: 'DOCUMENT_TYPE_CONCEPTS', vocabulary: DOCUMENT_TYPE_CONCEPTS },
  issuingCountry: { name: 'COUNTRY_CONCEPTS', vocabulary: COUNTRY_CONCEPTS },
  destinationCountry: { name: 'COUNTRY_CONCEPTS', vocabulary: COUNTRY_CONCEPTS },
  languageFrom: { name: 'LANGUAGE_CONCEPTS', vocabulary: LANGUAGE_CONCEPTS },
  languageTo: { name: 'LANGUAGE_CONCEPTS', vocabulary: LANGUAGE_CONCEPTS },
  deliveryCity: { name: 'CITY_CONCEPTS', vocabulary: CITY_CONCEPTS },
  partner: { name: 'PARTNER_CONCEPTS', vocabulary: PARTNER_CONCEPTS },
};

function vocabularyLines(vocabulary: ConceptVocabulary): string {
  const entries = Object.values(vocabulary);
  if (entries.length === 0) {
    return '  (словарь пуст — ни одно значение сегодня не подтверждено, всегда возвращай UNKNOWN)';
  }
  return entries
    .map((e) => `  ${e.id} — "${e.label}"${e.aliases?.length ? ` (напр.: ${e.aliases.join(', ')})` : ''}`)
    .join('\n');
}

function scenarioLines(): string {
  return Object.values(SCENARIOS)
    .map((node) => `  ${node.key} — "${node.label}"`)
    .join('\n');
}

/** Компактное описание фасет для промпта — реестры остаются единственным
 *  источником истины, промпт их не дублирует своей копией списка. */
export function facetCatalog(): string {
  return FACET_KEYS.map((key) => {
    const def = FACET_REGISTRY[key];
    const concept = CONCEPT_VOCABULARIES[key];
    if (concept) {
      return `- ${key}: ${def.description}\n  Допустимые значения (${concept.name}):\n${vocabularyLines(concept.vocabulary)}`;
    }
    if (key === 'documentForm') {
      return `- ${key}: ${def.description}\n  Допустимые значения: ORIGINAL, SCAN, COPY`;
    }
    // scenario. Полный список узлов, не один пример: промпт сам требует
    // «только значения из списков выше», а `scenarioKeySchema` (facets.ts)
    // принимает ЛЮБОЙ реальный узел SCENARIOS, не только листовой — пример
    // одного значения незаметно сужал бы то, что модели разрешено вернуть.
    return `- ${key}: ${def.description}\n  Допустимые значения (SCENARIOS):\n${scenarioLines()}`;
  }).join('\n');
}

export interface TriggerFactCatalogOptions {
  /**
   * `helperPresent` — единственный булев триггер-факт. По умолчанию
   * описывается как строка `"true"`/`"false"` — так, как её действительно
   * ждёт rawValue:string в сыром извлечении query-frame-builder.ts (PR D),
   * где парсинг в boolean делает код, а не схема.
   *
   * `true` переключает описание на JSON boolean БЕЗ кавычек — так, как его
   * ждёт `triggerConditionSchema` (переиспользован из B2, trigger.ts)
   * напрямую в PR E: там `equals` для helperPresent типизирован `z.boolean()`,
   * и строка "true" провалила бы схему на каждом исключении с этим фактом
   * (независимая находка ревью этого PR).
   */
  readonly booleanAsJsonLiteral?: boolean;
}

export function triggerFactCatalog(options: TriggerFactCatalogOptions = {}): string {
  return TRIGGER_FACT_KEYS.map((key) => {
    const def = TRIGGER_FACT_REGISTRY[key];
    if (key === 'helperPresent') {
      const value = options.booleanAsJsonLiteral
        ? 'JSON boolean true или false (БЕЗ кавычек)'
        : '"true" или "false"';
      return `- ${key}: ${def.description}\n  Значение: ${value}`;
    }
    const values = (def.valueSchema as { options?: readonly string[] }).options ?? [];
    return `- ${key}: ${def.description}\n  Допустимые значения: ${values.join(', ')}`;
  }).join('\n');
}
