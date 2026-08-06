import { z } from 'zod';
import {
  CITY_CONCEPTS,
  COUNTRY_CONCEPTS,
  DOCUMENT_TYPE_CONCEPTS,
  LANGUAGE_CONCEPTS,
  PARTNER_CONCEPTS,
  SERVICE_CONCEPTS,
} from './concept-registry';
import { resolveConceptAlias, type ConceptVocabulary } from './concepts';
import { conceptIdSchema, FACET_KEYS, FACET_REGISTRY, type FacetKey } from './facets';
import { nonBlankString } from './text';
import { TRIGGER_FACT_KEYS, TRIGGER_FACT_REGISTRY, type TriggerFactKey } from './trigger-facts';
import { getScenario } from '@/lib/knowledge/scenarios';
import {
  QUESTION_ASPECTS,
  UNKNOWN_QUERY_FACETS,
  UNKNOWN_TRIGGER_FACTS,
  type FacetEvidence,
  type QueryFacetMap,
  type QueryFacetState,
  type QueryFactMap,
  type QueryFactState,
  type QueryFrame,
  type QuestionAspect,
} from './query-frame';

/**
 * Реконсиляция сырого LLM-извлечения в `QueryFrame` (PR D, план §3, Beads
 * translation-r35). Чистая функция — приоритет источника (текущее сообщение
 * vs история), обнаружение конфликта и правило «никогда не выдумывать»
 * ДЕТЕРМИНИРОВАНЫ и потому живут в коде, а не в суждении модели: acceptance
 * criteria (regression-тест на факт из истории, конфликт всегда попадает в
 * ambiguities) должны быть воспроизводимы одинаково при каждом прогоне.
 *
 * LLM отвечает только за РАСПОЗНАВАНИЕ упоминаний (`RawQueryExtraction`) —
 * само построение `QueryFrame` из них здесь, без обращения к модели повторно.
 */

export interface ConversationMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

/** Одно упоминание facet-значения где-то в разговоре. `rawValue` — то, что
 *  распознала модель ДО сверки со словарём; резолвится здесь, а не там, чтобы
 *  переиспользовать один и тот же `FACET_REGISTRY`/`ConceptVocabulary`, а не
 *  заставлять промпт знать реестры наизусть. */
export interface RawFacetMention {
  readonly facet: FacetKey;
  readonly polarity: 'INCLUDE' | 'EXCLUDE';
  readonly rawValue: string;
  readonly messageId: string;
  readonly quote: string;
}

export interface RawTriggerFactMention {
  readonly fact: TriggerFactKey;
  readonly rawValue: string;
  readonly messageId: string;
  readonly quote: string;
}

export interface RawQueryExtraction {
  readonly facetMentions: readonly RawFacetMention[];
  readonly triggerFactMentions: readonly RawTriggerFactMention[];
  readonly questionAspects: readonly QuestionAspect[];
}

export const rawFacetMentionSchema = z.strictObject({
  facet: z.enum(FACET_KEYS as [FacetKey, ...FacetKey[]]),
  polarity: z.enum(['INCLUDE', 'EXCLUDE']),
  rawValue: nonBlankString('rawValue не может быть пустым'),
  messageId: nonBlankString('messageId не может быть пустым'),
  quote: nonBlankString('quote обязана содержать текст источника, а не пробелы'),
});

export const rawTriggerFactMentionSchema = z.strictObject({
  fact: z.enum(TRIGGER_FACT_KEYS as [TriggerFactKey, ...TriggerFactKey[]]),
  rawValue: nonBlankString('rawValue не может быть пустым'),
  messageId: nonBlankString('messageId не может быть пустым'),
  quote: nonBlankString('quote обязана содержать текст источника, а не пробелы'),
});

export const rawQueryExtractionSchema = z.strictObject({
  facetMentions: z.array(rawFacetMentionSchema).readonly(),
  triggerFactMentions: z.array(rawTriggerFactMentionSchema).readonly(),
  questionAspects: z.array(z.enum(QUESTION_ASPECTS)).readonly(),
});

/** Фасеты, чьи значения живут в `ConceptVocabulary` (Задача 2.2) — резолвятся
 *  через `resolveConceptAlias`, а не точным совпадением формы. `scenario`
 *  (дерево `SCENARIOS`) и `documentForm` (закрытый enum без алиасов)
 *  обрабатываются отдельно ниже. */
const CONCEPT_VOCABULARY_BY_FACET: Partial<Record<FacetKey, ConceptVocabulary>> = {
  service: SERVICE_CONCEPTS,
  documentType: DOCUMENT_TYPE_CONCEPTS,
  issuingCountry: COUNTRY_CONCEPTS,
  destinationCountry: COUNTRY_CONCEPTS,
  languageFrom: LANGUAGE_CONCEPTS,
  languageTo: LANGUAGE_CONCEPTS,
  deliveryCity: CITY_CONCEPTS,
  partner: PARTNER_CONCEPTS,
};

const DOCUMENT_FORM_VALUES = ['ORIGINAL', 'SCAN', 'COPY'] as const;

/**
 * Сырое значение -> валидный `FacetValueOf<K>` или `undefined`. `undefined`
 * означает «упоминание отброшено» — ИМЕННО так acceptance criterion «никогда
 * не выдумывает» реализован: неразрешимое значение не доезжает до `QueryFrame`
 * ни в каком виде, факт остаётся `UNKNOWN` (или падает на историю, если она
 * дала разрешимое значение).
 */
function resolveFacetRawValue(facet: FacetKey, rawValue: string): string | undefined {
  const vocabulary = CONCEPT_VOCABULARY_BY_FACET[facet];
  if (vocabulary) {
    const resolved = resolveConceptAlias(vocabulary, rawValue);
    return resolved;
  }
  if (facet === 'scenario') {
    return getScenario(rawValue) ? rawValue : undefined;
  }
  if (facet === 'documentForm') {
    const normalized = rawValue.trim().toUpperCase();
    return (DOCUMENT_FORM_VALUES as readonly string[]).includes(normalized)
      ? normalized
      : undefined;
  }
  return undefined;
}

function resolveTriggerFactRawValue(fact: TriggerFactKey, rawValue: string): unknown {
  if (fact === 'helperPresent') {
    const normalized = rawValue.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
    return undefined;
  }
  const normalized = rawValue.trim().toUpperCase();
  const schema = TRIGGER_FACT_REGISTRY[fact].valueSchema;
  const parsed = schema.safeParse(normalized);
  return parsed.success ? parsed.data : undefined;
}

interface ResolvedFacetMention {
  readonly value: string;
  readonly polarity: 'INCLUDE' | 'EXCLUDE';
  readonly evidence: FacetEvidence;
}

function resolveFacetMentions(
  facet: FacetKey,
  mentions: readonly RawFacetMention[]
): ResolvedFacetMention[] {
  const resolved: ResolvedFacetMention[] = [];
  for (const mention of mentions) {
    if (mention.facet !== facet) continue;
    const value = resolveFacetRawValue(facet, mention.rawValue);
    if (value === undefined) continue;
    // Схема реестра — последняя проверка (defense in depth): резолвер выше уже
    // должен был отдать валидное значение, но два независимых пути к одному и
    // тому же контракту расходятся быстрее, чем кажется (см. B2 review этой сессии).
    if (!FACET_REGISTRY[facet].valueSchema.safeParse(value).success) continue;
    resolved.push({
      value,
      polarity: mention.polarity,
      evidence: { source: 'CURRENT_MESSAGE', messageId: mention.messageId, quote: mention.quote },
    });
  }
  return resolved;
}

function buildFacetState(
  facet: FacetKey,
  mentions: readonly RawFacetMention[],
  currentMessageId: string,
  ambiguities: string[]
): QueryFacetState<unknown> {
  const resolved = resolveFacetMentions(facet, mentions);
  const current = resolved.filter((m) => m.evidence.messageId === currentMessageId);
  const history = resolved.filter((m) => m.evidence.messageId !== currentMessageId);

  const winning = current.length > 0 ? current : history;
  const source: 'CURRENT_MESSAGE' | 'HISTORY' = current.length > 0 ? 'CURRENT_MESSAGE' : 'HISTORY';

  if (winning.length === 0) return { state: 'UNKNOWN' };

  if (current.length > 0 && history.length > 0) {
    const currentValues = setOf(current);
    const historyValues = setOf(history);
    // История ⊆ текущее — не конфликт: текущее сообщение ДОБАВИЛО значение,
    // не отреклось от того, что было известно ("и апостиль тоже нужен" поверх
    // "нужен перевод"). Конфликт — когда текущее пропускает или меняет то,
    // что утверждала история, ровно как в примере плана "не апостиль, а
    // легализация" (история говорила про апостиль, текущее — про другое).
    if (!isSubsetOf(historyValues, currentValues)) {
      ambiguities.push(
        `${facet}: текущее сообщение (${[...currentValues].join(', ') || '—'}) противоречит истории (${[...historyValues].join(', ') || '—'})`
      );
    }
  }

  let include = dedupe(winning.filter((m) => m.polarity === 'INCLUDE').map((m) => m.value));
  let exclude = dedupe(winning.filter((m) => m.polarity === 'EXCLUDE').map((m) => m.value));

  // Один и тот же resolved-значение как INCLUDE и EXCLUDE одновременно —
  // самопротиворечие (LLM спутала полярность, или два синонима резолвились в
  // один id с разной полярностью), а не легальное состояние: `queryFacetStateSchema`
  // (query-frame.ts) явно запрещает пересечение include/exclude. Строгий отказ
  // от обоих значений безопаснее, чем произвольный выбор одной из полярностей.
  const overlap = include.filter((v) => exclude.includes(v));
  if (overlap.length > 0) {
    ambiguities.push(
      `${facet}: значение ${overlap.join(', ')} одновременно INCLUDE и EXCLUDE в одном источнике — отброшено`
    );
    include = include.filter((v) => !overlap.includes(v));
    exclude = exclude.filter((v) => !overlap.includes(v));
  }

  if (include.length === 0 && exclude.length === 0) return { state: 'UNKNOWN' };

  return {
    state: 'KNOWN',
    include,
    exclude,
    evidence: dedupeEvidence(winning.map((m) => ({ ...m.evidence, source }))),
  };
}

function setOf(mentions: readonly ResolvedFacetMention[]): Set<string> {
  return new Set(mentions.map((m) => `${m.polarity}:${m.value}`));
}

function isSubsetOf(subset: Set<string>, superset: Set<string>): boolean {
  for (const v of subset) if (!superset.has(v)) return false;
  return true;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function dedupeEvidence(evidence: readonly FacetEvidence[]): FacetEvidence[] {
  const seen = new Set<string>();
  const out: FacetEvidence[] = [];
  for (const e of evidence) {
    const key = `${e.source}|${e.messageId ?? ''}|${e.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function buildTriggerFactState(
  fact: TriggerFactKey,
  mentions: readonly RawTriggerFactMention[],
  currentMessageId: string,
  ambiguities: string[]
): QueryFactState<unknown> {
  const resolved = mentions
    .filter((m) => m.fact === fact)
    .map((m) => ({ value: resolveTriggerFactRawValue(fact, m.rawValue), mention: m }))
    .filter((r): r is { value: unknown; mention: RawTriggerFactMention } => r.value !== undefined);

  const current = resolved.filter((r) => r.mention.messageId === currentMessageId);
  const history = resolved.filter((r) => r.mention.messageId !== currentMessageId);

  const winning = current.length > 0 ? current : history;
  if (winning.length === 0) return { state: 'UNKNOWN' };

  // Само текущее сообщение может утверждать два разных значения одного факта
  // (LLM извлекла из двух разных фраз) — это самопротиворечие, не то же самое,
  // что «одно значение, подтверждённое дважды». Тай-брейк детерминирован
  // (последнее упоминание побеждает), но НЕ молчалив — записывается в
  // ambiguities, а не просто выбирается без следа.
  if (current.length > 0) {
    const distinctCurrentValues = new Set(current.map((r) => r.value));
    if (distinctCurrentValues.size > 1) {
      ambiguities.push(
        `${fact}: текущее сообщение само себе противоречит (${[...distinctCurrentValues].map(String).join(', ')}) — использовано последнее`
      );
    }
  }

  if (current.length > 0 && history.length > 0) {
    const currentValue = current[current.length - 1].value;
    const conflicting = history.some((r) => r.value !== currentValue);
    if (conflicting) {
      ambiguities.push(
        `${fact}: текущее сообщение (${String(currentValue)}) противоречит истории`
      );
    }
  }

  const last = winning[winning.length - 1];
  const source: 'CURRENT_MESSAGE' | 'HISTORY' = current.length > 0 ? 'CURRENT_MESSAGE' : 'HISTORY';
  return {
    state: 'KNOWN',
    value: last.value,
    evidence: [{ source, messageId: last.mention.messageId, quote: last.mention.quote }],
  };
}

/**
 * `QueryFrame.concepts` (queryFrameSchema, query-frame.ts) — `z.array(conceptIdSchema)`,
 * т.е. только lowercase-slug. `COUNTRY_CONCEPTS` хранит ISO alpha-2 ЗАГЛАВНЫМИ
 * (`RU`) — включение странового кода сюда без формы сломало бы собственную
 * схему `QueryFrame`. Только `include`, не `exclude`: «не апостиль» не делает
 * apostille_spb концептом ИНТЕРЕСА этого запроса, скорее наоборот.
 */
function conceptsOf(facets: QueryFacetMap): string[] {
  const concepts = new Set<string>();
  for (const facet of FACET_KEYS) {
    if (!(facet in CONCEPT_VOCABULARY_BY_FACET)) continue;
    const state = facets[facet];
    if (state.state !== 'KNOWN') continue;
    for (const v of state.include) {
      if (conceptIdSchema.safeParse(v).success) concepts.add(v as string);
    }
  }
  return [...concepts];
}

/**
 * Строит `QueryFrame` из сырого извлечения + упорядоченного разговора.
 * `messages` обязан быть непуст — последнее сообщение считается текущим
 * (`currentMessageId`), всё до него — историей.
 */
export function buildQueryFrame(
  extraction: RawQueryExtraction,
  messages: readonly ConversationMessage[]
): QueryFrame {
  if (messages.length === 0) {
    throw new Error('buildQueryFrame: messages не может быть пуст — нет текущего сообщения');
  }
  const currentMessageId = messages[messages.length - 1].id;
  const ambiguities: string[] = [];

  // Упоминание, сославшееся на messageId вне реального разговора — не
  // "исторический факт" и не "текущее сообщение", а непроверяемая цитата.
  // `!== currentMessageId` без этой проверки тихо зачислял бы такое
  // упоминание в HISTORY — ссылка на источник врала бы, даже если само
  // значение реальное (см. ревью Grok на этот PR).
  const knownMessageIds = new Set(messages.map((m) => m.id));
  const facetMentions = extraction.facetMentions.filter((m) => knownMessageIds.has(m.messageId));
  const triggerFactMentions = extraction.triggerFactMentions.filter((m) =>
    knownMessageIds.has(m.messageId)
  );

  const facets = { ...UNKNOWN_QUERY_FACETS } as Record<FacetKey, QueryFacetState<unknown>>;
  for (const facet of FACET_KEYS) {
    facets[facet] = buildFacetState(facet, facetMentions, currentMessageId, ambiguities);
  }

  const triggerFacts = { ...UNKNOWN_TRIGGER_FACTS } as Record<
    TriggerFactKey,
    QueryFactState<unknown>
  >;
  for (const fact of TRIGGER_FACT_KEYS) {
    triggerFacts[fact] = buildTriggerFactState(
      fact,
      triggerFactMentions,
      currentMessageId,
      ambiguities
    );
  }

  return {
    concepts: conceptsOf(facets as QueryFacetMap),
    facets: facets as unknown as QueryFacetMap,
    triggerFacts: triggerFacts as unknown as QueryFactMap,
    questionAspects: dedupe(extraction.questionAspects) as QuestionAspect[],
    ambiguities,
  };
}
