import type { ChatMessage } from '@/lib/ai/chat-provider';
import { structured, type StructuredResult, type StructuredRunConfig } from '@/lib/ai/structured-output';
import {
  buildQueryFrame,
  rawQueryExtractionSchema,
  type ConversationMessage,
  type RawQueryExtraction,
} from './applicability/query-frame-builder';
import { QUESTION_ASPECTS, type QueryFrame } from './applicability/query-frame';
import { facetCatalog, triggerFactCatalog } from './prompt-catalogs';

/**
 * LLM-обвязка вокруг чистого `buildQueryFrame` (PR D, Beads translation-r35).
 * Всё, что можно проверить без сети, живёт в `query-frame-builder.ts` и
 * покрыто там тестами; здесь — только промпт и вызов `structured()` (PR C).
 */

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
- consentStatus описывает ТОЛЬКО текущее, явно выраженное согласие на этот конкретный случай. EXPLICIT допустим лишь когда человек сейчас ясно согласился. Спящий человек, человек без сознания или человек, который сейчас не способен дать/подтвердить согласие, означает ABSENT. Прошлое согласие, «раньше не возражал(а)», согласие в прошлый раз и отсутствие прежних возражений НИКОГДА не означают текущее EXPLICIT; без иных текущих данных оставь факт неуказанным.
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
