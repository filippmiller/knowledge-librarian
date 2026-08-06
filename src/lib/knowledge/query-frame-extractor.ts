import type { ChatMessage } from '@/lib/ai/chat-provider';
import { structured, type StructuredResult, type StructuredRunConfig } from '@/lib/ai/structured-output';
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
import {
  buildQueryFrame,
  rawQueryExtractionSchema,
  type ConversationMessage,
  type RawQueryExtraction,
} from './applicability/query-frame-builder';
import { QUESTION_ASPECTS, type QueryFrame } from './applicability/query-frame';
import { TRIGGER_FACT_KEYS, TRIGGER_FACT_REGISTRY } from './applicability/trigger-facts';
import { SCENARIOS } from './scenarios';

/**
 * LLM-обвязка вокруг чистого `buildQueryFrame` (PR D, Beads translation-r35).
 * Всё, что можно проверить без сети, живёт в `query-frame-builder.ts` и
 * покрыто там тестами; здесь — только промпт и вызов `structured()` (PR C).
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

/** Компактное описание фасет для промпта — реестры остаются единственным
 *  источником истины, промпт их не дублирует своей копией списка. */
function facetCatalog(): string {
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
    // одного значения незаметно сужал бы то, что модели разрешено вернуть
    // (находка Codex-ревью этого PR).
    return `- ${key}: ${def.description}\n  Допустимые значения (SCENARIOS):\n${scenarioLines()}`;
  }).join('\n');
}

function scenarioLines(): string {
  return Object.values(SCENARIOS)
    .map((node) => `  ${node.key} — "${node.label}"`)
    .join('\n');
}

function triggerFactCatalog(): string {
  return TRIGGER_FACT_KEYS.map((key) => {
    const def = TRIGGER_FACT_REGISTRY[key];
    if (key === 'helperPresent') {
      return `- ${key}: ${def.description}\n  Значение: "true" или "false"`;
    }
    const values = (def.valueSchema as { options?: readonly string[] }).options ?? [];
    return `- ${key}: ${def.description}\n  Допустимые значения: ${values.join(', ')}`;
  }).join('\n');
}

const SYSTEM_PROMPT = `Ты извлекаешь структурированные факты из разговора с клиентом бюро апостиля/переводов/легализации — для системы поиска знаний, не для ответа клиенту.

Твоя задача — найти упоминания ДВУХ видов сигналов в разговоре:

1. FACET-упоминания: клиент называет (или отрицает) конкретное значение одной из осей ниже.
${facetCatalog()}

2. TRIGGER-FACT упоминания: ситуационные сигналы вокруг клиента прямо сейчас (не про услугу, а про ОБСТОЯТЕЛЬСТВА).
${triggerFactCatalog()}

ПРАВИЛА (нарушение любого — ошибка):
- Указывай ТОЛЬКО значения, которые есть в списках выше. Если клиент назвал что-то, чего в списке нет, или ты не уверен — НЕ указывай это упоминание вообще. Придуманное значение хуже пропущенного.
- rawValue для facet/trigger-fact — это id/значение ИЗ СПИСКА (или его синонима), не свободный текст.
- messageId бери из тега перед каждым сообщением ([m1], [m2], ...).
- quote — дословная цитата из сообщения, по которой решение можно перепроверить.
- polarity: "EXCLUDE", если клиент явно отрицает значение ("не апостиль, а легализация" -> service EXCLUDE apostille_spb, service INCLUDE consular_legalization). НЕ используй EXCLUDE для вопросов-требований ("а оригинал не нужен?" — это НЕ отрицание значения documentForm, это вопрос; отрази его через questionAspects: REQUIREMENT, а не через facet-упоминание).
- Извлекай упоминания из ВСЕХ сообщений разговора, не только последнего — история так же важна.
- questionAspects — какие аспекты явно спрашивает ПОСЛЕДНЕЕ сообщение (может быть несколько: ${QUESTION_ASPECTS.join(', ')}).

Ответ СТРОГО JSON по схеме:
{
  "facetMentions": [{"facet": "...", "polarity": "INCLUDE"|"EXCLUDE", "rawValue": "...", "messageId": "...", "quote": "..."}],
  "triggerFactMentions": [{"fact": "...", "rawValue": "...", "messageId": "...", "quote": "..."}],
  "questionAspects": ["..."]
}`;

/** Промпт — чистая функция, проверяется без сети. Импурная часть (сетевой
 *  вызов) — только `extractQueryFrame` ниже. */
export function buildExtractionMessages(
  messages: readonly ConversationMessage[],
  channel?: string
): ChatMessage[] {
  if (messages.length === 0) {
    throw new Error('buildExtractionMessages: messages не может быть пуст');
  }
  const transcript = messages.map((m) => `[${m.id}] ${m.role}: ${m.text}`).join('\n');
  const channelLine = channel ? `Канал: ${channel}\n\n` : '';

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `${channelLine}Разговор (последнее сообщение — [${messages[messages.length - 1].id}], текущее):\n${transcript}\n\nИзвлеки facet- и trigger-fact-упоминания по правилам выше.`,
    },
  ];
}

export interface ExtractQueryFrameOptions {
  /** Полный разговор по порядку; последнее сообщение считается текущим. */
  readonly messages: readonly ConversationMessage[];
  readonly channel?: string;
  readonly runConfig: StructuredRunConfig;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export interface ExtractQueryFrameResult {
  readonly queryFrame: QueryFrame;
  readonly rawExtraction: RawQueryExtraction;
  /** Полный результат `structured()` — `attempts[]`, `servedByProvider/Model` —
   *  для журнала прогона (PR H), не только для отладки. */
  readonly structuredResult: StructuredResult<RawQueryExtraction>;
}

/**
 * Строит `QueryFrame` из вопроса + истории через LLM-извлечение (PR D).
 * Реконсиляция (приоритет источника, конфликты, "никогда не выдумывать")
 * происходит в `buildQueryFrame` — чистой функции, а не здесь.
 */
export async function extractQueryFrame(
  options: ExtractQueryFrameOptions
): Promise<ExtractQueryFrameResult> {
  const structuredResult = await structured<RawQueryExtraction>({
    schema: rawQueryExtractionSchema,
    messages: buildExtractionMessages(options.messages, options.channel),
    runConfig: options.runConfig,
    ...(options.maxTokens !== undefined && { maxTokens: options.maxTokens }),
    ...(options.temperature !== undefined && { temperature: options.temperature }),
    ...(options.signal && { signal: options.signal }),
  });

  const queryFrame = buildQueryFrame(structuredResult.data, options.messages);

  return { queryFrame, rawExtraction: structuredResult.data, structuredResult };
}
