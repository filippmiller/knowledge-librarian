import type { ChatMessage } from '@/lib/ai/chat-provider';
import type { ExtractionRunConfig } from '@/lib/ai/extraction-run';
import { structured, type StructuredResult } from '@/lib/ai/structured-output';
import { z } from 'zod';
import {
  extractedKnowledgeUnitSchema,
  type ExtractedKnowledgeUnit,
} from './applicability/extraction';
import { validateParentRefs } from './applicability/extraction-parent-refs';
import { applicableFacetsOf, KNOWLEDGE_UNIT_KINDS } from './applicability/kinds';
import { facetCatalog, triggerFactCatalog } from './prompt-catalogs';

/**
 * LLM-обвязка вокруг структурной экстракции (PR E, Beads translation-ypp).
 * Схема и типы — в `applicability/extraction.ts` (чистые, без IO);
 * проверка `extractionRef`/`parentExtractionRef` — в
 * `applicability/extraction-parent-refs.ts` (чистое, preflight C,
 * translation-djc); здесь — только промпт и вызов `structured()` (PR C).
 */

/** Один блок исходного текста с ЗАРАНЕЕ назначенным якорем. Разбиение
 *  документа на блоки — задача вызывающего кода (ingestion), не этого модуля:
 *  экстрактор лишь ссылается на уже существующие якоря в `sourceSpan`.
 *  `parentExtractionRef` ссылается на `extractionRef` ДРУГОГО unit'а этого
 *  же ответа, не на anchor блока (preflight C — anchor называет место в
 *  документе, не unit, и не может отличить несколько unit'ов на одном блоке
 *  друг от друга). */
export interface SourceBlock {
  readonly anchor: string;
  readonly text: string;
}

const KIND_DESCRIPTIONS: Record<(typeof KNOWLEDGE_UNIT_KINDS)[number], string> = {
  PROCEDURE_STEP: 'шаг процедуры — что нужно сделать в рамках сценария',
  EXCEPTION_RULE: 'исключение из PROCEDURE_STEP, активное только при определённой ситуации (triggerCondition)',
  TERM_DEFINITION: 'определение термина — не привязано к сценарию',
  DELIVERY_RULE: 'правило доставки в конкретный город',
  PRICE_RULE: 'цена или правило расчёта цены для услуги',
};

function kindCatalog(): string {
  return KNOWLEDGE_UNIT_KINDS.map(
    (kind) =>
      `- ${kind}: ${KIND_DESCRIPTIONS[kind]}\n  Применимые facets: ${applicableFacetsOf(kind).join(', ') || '(нет — этот kind вообще не несёт facets)'}`
  ).join('\n');
}

const SYSTEM_PROMPT = `Ты извлекаешь структурированные единицы знания из документа бюро апостиля/переводов/легализации — для базы знаний, не для пересказа клиенту.

Каждая единица знания (unit) имеет один из видов; у каждого — СВОЙ закрытый список применимых facets, использовать facet вне этого списка для данного kind нельзя:
${kindCatalog()}

Для каждого unit'а извлеки:
- kind — один из видов выше.
- statement — САМО утверждение своими словами: что правило говорит, а не только к чему оно применимо. Не может быть пустым.
- facets — на какие оси распространяется unit. Указывай ТОЛЬКО оси, применимые к kind этого unit'а (см. список выше), и ТОЛЬКО значения из списков ниже; неуверен — не указывай ось вообще. Каждая ось — ОДНО значение (строка), не список: если правило не привязано к конкретному значению оси (например, документ вообще не про сценарии бюро апостиля/переводов) — это тоже "неуверен", ось просто ОПУСКАЕТСЯ из facets целиком, а не заполняется массивом из нескольких/всех значений.
${facetCatalog()}
- triggerCondition — ТОЛЬКО для EXCEPTION_RULE: при какой ситуации исключение активно. Формат: {"all": [{"fact": "...", "equals": ...}, ...]} — конъюнкция условий, минимум одно. У остальных kind — null. "fact" ОБЯЗАН быть ОДНИМ ИЗ ключей списка ниже — не изобретай новое имя факта и не описывай условие свободным текстом в поле "fact". Если ситуация, при которой правило — исключение, НЕ описывается ни одним из фактов ниже (например: "нельзя использовать посторонние предметы", "прекратить немедленно при боли" — это не про место/согласие/доступность/помощника), НЕ придумывай новый "fact": оставь triggerCondition null и добавь uncertainty {"kind": "UNRECOGNIZED_TRIGGER_CONDITION", "description": "какая на самом деле ситуация активирует исключение", "quote": "..."} — правило при этом не теряется, просто его условие остаётся неструктурированным до отдельного решения по каталогу фактов.
${triggerFactCatalog({ booleanAsJsonLiteral: true })}
  Эти имена — ТОЛЬКО значения поля "fact" внутри triggerCondition. Это НЕ отдельные top-level поля unit'а (в отличие от facets выше, которые — настоящие ключи объекта facets).
  НЕПРАВИЛЬНО: {"kind": "EXCEPTION_RULE", "privacyContext": "PUBLIC", ...} — privacyContext НИКОГДА не пишется рядом с kind/statement/facets.
  ПРАВИЛЬНО: {"kind": "EXCEPTION_RULE", "triggerCondition": {"all": [{"fact": "privacyContext", "equals": "PUBLIC"}]}, ...}
- numericConstraint — если в тексте есть числовое ограничение (срок, количество, длительность): {"factKey": "что именно ограничивает число, своими словами", "value": число, "unit": "единица измерения"}. Одно числовое ограничение = один factKey = один unit. Несколько чисел в одном предложении ("15 секунд, потом пауза 30 секунд, не более 3 раз") — это НЕСКОЛЬКО отдельных unit'ов, каждый со своим factKey, не один unit с тремя числами. Иначе — null.
- extractionRef — придумай короткий уникальный ID для ЭТОГО unit'а в рамках ЭТОГО ответа (например "u1", "u2", "u3"...). Обязан быть уникален среди ВСЕХ units этого ответа — два одинаковых extractionRef недопустимы.
- parentExtractionRef — если этот unit является ФРАГМЕНТОМ более общего правила (например, числовое ограничение относится к правилу, описанному в том же или другом блоке текста), укажи extractionRef ДРУГОГО unit'а ИЗ ЭТОГО ЖЕ ОТВЕТА, который и есть родитель. Родитель обязан существовать среди units, которые ты возвращаешь сейчас — если общее правило само не выделяется отдельным unit'ом, оставь parentExtractionRef null, НЕ изобретай ссылку на unit, которого нет. Unit не может ссылаться сам на себя. Если unit самостоятелен — null.
- sourceSpan — {"anchor": anchor блока, откуда взят unit, "quote": дословная цитата}.
- evidenceByField — ОБЯЗАТЕЛЬНО подтверждение для КАЖДОГО заполненного поля: всегда для "statement"; для "facets", если facets непуст; для "triggerCondition", если оно не null; для "numericConstraint", если оно не null. Формат ключа {"anchor","quote"} на каждое из этих имён полей. Пропуск обязательного подтверждения — ошибка формата, не опция.
- uncertainties — если что-то в тексте похоже на условие/число, но ты не уверен, как его структурировать: [{"kind": "UNRECOGNIZED_TRIGGER_CONDITION"|"UNRECOGNIZED_NUMERIC_CONSTRAINT"|"AMBIGUOUS_FACET"|"OTHER", "description": "...", "quote": "..."}]. НЕ пропускай такой фрагмент молча — лучше явная uncertainty, чем потерянное правило.

ПРАВИЛА:
- Не изобретай значения фасет/условий, которых нет в списках выше или в тексте.
- Каждое реальное правило текста обязано попасть хотя бы в один unit — молчаливый пропуск правила хуже, чем unit с uncertainties.

Ответ СТРОГО JSON: {"units": [...]}`;

/** Промпт — чистая функция, проверяется без сети. */
export function buildExtractionPromptMessages(blocks: readonly SourceBlock[]): ChatMessage[] {
  if (blocks.length === 0) {
    throw new Error('buildExtractionPromptMessages: blocks не может быть пуст');
  }
  const document = blocks.map((b) => `[${b.anchor}]\n${b.text}`).join('\n\n');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Документ (блоки помечены анкерами):\n\n${document}\n\nИзвлеки все units по правилам выше.` },
  ];
}

const extractionResponseSchema = z.strictObject({
  units: z.array(extractedKnowledgeUnitSchema).readonly(),
});

export interface ExtractKnowledgeUnitsOptions {
  readonly blocks: readonly SourceBlock[];
  readonly runConfig: ExtractionRunConfig;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly signal?: AbortSignal;
}

export interface ExtractKnowledgeUnitsResult {
  readonly units: ExtractedKnowledgeUnit[];
  readonly structuredResult: StructuredResult<{ units: readonly ExtractedKnowledgeUnit[] }>;
}

/**
 * Извлекает `ExtractedKnowledgeUnit[]` из блоков документа через
 * `structured()` (PR C), затем проверяет `extractionRef`/`parentExtractionRef`
 * каждого unit'а (`validateParentRefs`, preflight C) — уникальность
 * `extractionRef`, существование/само-ссылку/циклы `parentExtractionRef`.
 * Сломанная ссылка не резолвится в тишине — unit остаётся на месте с явной
 * `DANGLING_PARENT_REF`/`DUPLICATE_EXTRACTION_REF` uncertainty (та же
 * дисциплина, что закрывала регрессию translation-2n9, теперь на корректной
 * per-run identity, а не на source-block anchor).
 */
export async function extractKnowledgeUnits(
  options: ExtractKnowledgeUnitsOptions
): Promise<ExtractKnowledgeUnitsResult> {
  const structuredResult = await structured<{ units: readonly ExtractedKnowledgeUnit[] }>({
    schema: extractionResponseSchema,
    messages: buildExtractionPromptMessages(options.blocks),
    runConfig: options.runConfig,
    ...(options.maxTokens !== undefined && { maxTokens: options.maxTokens }),
    ...(options.temperature !== undefined && { temperature: options.temperature }),
    ...(options.signal && { signal: options.signal }),
  });

  const units = validateParentRefs(structuredResult.data.units);

  return { units, structuredResult };
}
