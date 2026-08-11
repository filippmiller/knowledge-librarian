import { z } from 'zod';
import { CONCEPT_VOCABULARY_BY_FACET } from './concept-registry';
import { resolveConceptAlias } from './concepts';
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

const HISTORICAL_CONSENT_PATTERN =
  /(?:раньше|ранее|прежде|до\s+этого|в\s+прошл(?:ый|ом)\s+раз|когда-то|не\s+возражал[аи]?)/iu;

const CURRENT_CONSENT_IMPOSSIBLE_PATTERN =
  /(?:спящ\p{L}*|спит|без\s+сознания|бессознательн\p{L}*|не\s+может\s+(?:сейчас\s+)?(?:дать|подтвердить|выразить)\s+согласие|не\s+способ\p{L}*\s+(?:сейчас\s+)?(?:дать|подтвердить|выразить)\s+согласие)/iu;

function deriveCurrentConsentAbsence(message: ConversationMessage): FacetEvidence | null {
  const match = CURRENT_CONSENT_IMPOSSIBLE_PATTERN.exec(message.text);
  return match === null
    ? null
    : { source: 'CURRENT_MESSAGE', messageId: message.id, quote: match[0] };
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

/**
 * Пер-значное согласование текущего сообщения с историей (pre-retrieval
 * hardening, Step 6). Раньше `winning = current.length > 0 ? current :
 * history` отбрасывал историю ЦЕЛИКОМ, как только текущее сообщение
 * упоминало facet ХОТЬ ЧТО-ТО — "и апостиль тоже" (текущее упоминает только
 * apostille, не повторяя "перевод") тихо терял "перевод" из истории и вдобавок
 * ошибочно попадал в ambiguities как "конфликт".
 *
 * Правильная гранулярность — не сообщение целиком, а КОНКРЕТНОЕ значение:
 * если текущее сообщение высказалось об этом значении (в любую полярность —
 * INCLUDE или EXCLUDE), его мнение побеждает для ЭТОГО значения (замена). Если
 * текущее о значении вообще не говорило, значение наследуется из истории как
 * есть (добавление). Это НЕ "всегда объединять историю": значение, которое
 * текущее сообщение явно перепол­яризовало (например EXCLUDE поверх истории
 * INCLUDE — "не апостиль, а легализация"), переопределяется, а не сливается.
 */
function buildFacetState(
  facet: FacetKey,
  mentions: readonly RawFacetMention[],
  currentMessageId: string,
  ambiguities: string[]
): QueryFacetState<unknown> {
  const resolved = resolveFacetMentions(facet, mentions);
  const current = resolved.filter((m) => m.evidence.messageId === currentMessageId);
  const history = resolved.filter((m) => m.evidence.messageId !== currentMessageId);
  if (current.length === 0 && history.length === 0) return { state: 'UNKNOWN' };

  // Самопротиворечие ВНУТРИ текущего сообщения (одно значение — сразу INCLUDE
  // и EXCLUDE в одной реплике) обязано быть отброшено ДО того, как решит,
  // какое значение "текущее" вообще утверждает — иначе оно могло бы случайно
  // победить над историей с произвольной из двух полярностей.
  const currentPolaritiesByValue = new Map<string, Set<'INCLUDE' | 'EXCLUDE'>>();
  for (const m of current) {
    const set = currentPolaritiesByValue.get(m.value) ?? new Set<'INCLUDE' | 'EXCLUDE'>();
    set.add(m.polarity);
    currentPolaritiesByValue.set(m.value, set);
  }
  for (const [value, polarities] of [...currentPolaritiesByValue]) {
    if (polarities.size > 1) {
      ambiguities.push(
        `${facet}: значение ${value} в текущем сообщении упомянуто и как INCLUDE, и как EXCLUDE одновременно — отброшено`
      );
      currentPolaritiesByValue.delete(value);
    }
  }

  // Пер-значный merge: текущее выигрывает для значений, о которых оно
  // высказалось (замена); значения, которых текущее не касалось, наследуются
  // из истории как есть (добавление).
  const finalPolarityByValue = new Map<string, 'INCLUDE' | 'EXCLUDE'>();
  for (const m of history) {
    if (!currentPolaritiesByValue.has(m.value)) finalPolarityByValue.set(m.value, m.polarity);
  }
  for (const [value, polarities] of currentPolaritiesByValue) {
    finalPolarityByValue.set(value, [...polarities][0]);
  }

  if (finalPolarityByValue.size === 0) return { state: 'UNKNOWN' };

  const include = [...finalPolarityByValue].filter(([, p]) => p === 'INCLUDE').map(([v]) => v);
  const exclude = [...finalPolarityByValue].filter(([, p]) => p === 'EXCLUDE').map(([v]) => v);

  const evidenceSourceFor = (value: string): 'CURRENT_MESSAGE' | 'HISTORY' =>
    currentPolaritiesByValue.has(value) ? 'CURRENT_MESSAGE' : 'HISTORY';
  const winningMentions = [...current, ...history].filter(
    (m) => finalPolarityByValue.get(m.value) === m.polarity
  );

  return {
    state: 'KNOWN',
    include,
    exclude,
    evidence: dedupeEvidence(
      winningMentions.map((m) => ({ ...m.evidence, source: evidenceSourceFor(m.value) }))
    ),
  };
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
    .filter((r): r is { value: unknown; mention: RawTriggerFactMention } => r.value !== undefined)
    // Consent is per-current-case and cannot be inherited merely because a
    // model labeled a historical mention (or a current quote explicitly
    // talking about the past) EXPLICIT.
    .filter(
      (r) =>
        fact !== 'consentStatus' ||
        r.value !== 'EXPLICIT' ||
        (r.mention.messageId === currentMessageId && !HISTORICAL_CONSENT_PATTERN.test(r.mention.quote))
    );

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

  // Trust boundary (pre-retrieval hardening, Step 5): `id` обязан
  // однозначно идентифицировать сообщение. Пустой `id` не отличим ни от
  // одного реального сообщения; задвоенный `id` делает currentMessageId
  // (последнее сообщение) неразличимым от одноимённого сообщения истории —
  // упоминание из "истории" молча приписалось бы текущему, и наоборот.
  const seenMessageIds = new Set<string>();
  for (const m of messages) {
    if (m.id.trim().length === 0) {
      throw new Error(
        `buildQueryFrame: ConversationMessage.id не может быть пустым (текст: "${m.text.slice(0, 40)}")`
      );
    }
    if (seenMessageIds.has(m.id)) {
      throw new Error(
        `buildQueryFrame: ConversationMessage.id "${m.id}" встречается в разговоре дважды — сообщения неразличимы`
      );
    }
    seenMessageIds.add(m.id);
  }

  const currentMessageId = messages[messages.length - 1].id;
  const ambiguities: string[] = [];
  const messageById = new Map(messages.map((m) => [m.id, m]));

  // Упоминание, сославшееся на messageId вне реального разговора — не
  // "исторический факт" и не "текущее сообщение", а непроверяемая цитата.
  // `!== currentMessageId` без этой проверки тихо зачислял бы такое
  // упоминание в HISTORY — ссылка на источник врала бы, даже если само
  // значение реальное (см. ревью Grok на этот PR).
  //
  // `quote` дополнительно обязана быть дословной подстрокой текста ИМЕННО
  // этого сообщения (pre-retrieval hardening, Step 5) — раньше проверялась
  // только непустота (`nonBlankString` в query-frame.ts), значит
  // сфабрикованная цитата с настоящим messageId проходила насквозь: реальный
  // источник, но придуманное содержание. `&&` короткого замыкания оставляет
  // `messageById.get(...)!` безопасным — до него уже отфильтрован любой
  // messageId, которого нет в карте.
  const knownMessageIds = new Set(messages.map((m) => m.id));
  const facetMentions = extraction.facetMentions.filter(
    (m) => knownMessageIds.has(m.messageId) && messageById.get(m.messageId)!.text.includes(m.quote)
  );
  const triggerFactMentions = extraction.triggerFactMentions.filter(
    (m) => knownMessageIds.has(m.messageId) && messageById.get(m.messageId)!.text.includes(m.quote)
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


  // Deterministic safety signal independent of LLM wording: a sleeping,
  // unconscious, or currently incapable person cannot provide current
  // explicit consent. This current-message fact overrides any extracted or
  // historical consent mention; absence of such evidence remains UNKNOWN.
  const currentConsentAbsence = deriveCurrentConsentAbsence(messages[messages.length - 1]);
  if (currentConsentAbsence !== null) {
    triggerFacts.consentStatus = {
      state: 'KNOWN',
      value: 'ABSENT',
      evidence: [currentConsentAbsence],
    };
  }

  return {
    concepts: conceptsOf(facets as QueryFacetMap),
    facets: facets as unknown as QueryFacetMap,
    triggerFacts: triggerFacts as unknown as QueryFactMap,
    questionAspects: dedupe(extraction.questionAspects) as QuestionAspect[],
    ambiguities,
  };
}
