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
import type { CanonicalBlockKind } from './docx-canonical-blocks';

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
  /** Deterministic provenance from canonicalization. Kept on the extraction
   *  input so orchestration can distinguish structural headings from
   *  substantive prose without guessing from wording or length. */
  readonly kind?: CanonicalBlockKind;
}

const KIND_DESCRIPTIONS: Record<(typeof KNOWLEDGE_UNIT_KINDS)[number], string> = {
  PROCEDURE_STEP: 'шаг процедуры — что нужно сделать в рамках сценария',
  EXCEPTION_RULE: 'оговорка, которая изменяет или отменяет отдельный базовый PROCEDURE_STEP; условная формулировка сама по себе ещё НЕ делает правило исключением',
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
- triggerCondition — структурированная применимость/предпосылка правила ЛЮБОГО kind, включая PROCEDURE_STEP. Формат: {"all": [{"fact": "...", "equals": ...}, ...]} — конъюнкция условий, минимум одно. самостоятельная инструкция с условием является PROCEDURE_STEP, а не EXCEPTION_RULE, если она не отменяет отдельный родительский шаг; если её условие выражается каталогом ниже, triggerCondition ОБЯЗАТЕЛЕН. EXCEPTION_RULE используй только когда оговорка изменяет отдельное базовое правило; тогда parentExtractionRef обязан ссылаться на extractionRef этого base-unit, а triggerCondition обязателен. Если условие нельзя выразить каталогом, оставь triggerCondition=null и добавь UNRECOGNIZED_TRIGGER_CONDITION; условие всё равно сохрани в statement.
${triggerFactCatalog({ booleanAsJsonLiteral: true })}
  Эти имена — ТОЛЬКО значения поля "fact" внутри triggerCondition. Это НЕ отдельные top-level поля unit'а (в отличие от facets выше, которые — настоящие ключи объекта facets).
  НЕПРАВИЛЬНО: {"kind": "EXCEPTION_RULE", "privacyContext": "PUBLIC", ...} — privacyContext НИКОГДА не пишется рядом с kind/statement/facets.
  ПРАВИЛЬНО: {"kind": "EXCEPTION_RULE", "triggerCondition": {"all": [{"fact": "privacyContext", "equals": "PUBLIC"}]}, ...}
- numericConstraint — если в тексте есть числовое ограничение (срок, количество, длительность): {"factKey": "что именно ограничивает число, своими словами", "value": число, "unit": "единица измерения"}. Одно числовое ограничение = один factKey = один unit. Несколько чисел в одном предложении ("15 секунд, потом пауза 30 секунд, не более 3 раз") — это НЕСКОЛЬКО отдельных unit'ов, каждый со своим factKey, не один unit с тремя числами. Для диапазона или альтернативы одного факта («два или три пальца») — тоже отдельный unit на КАЖДОЕ значение (value=2 и value=3), но у КАЖДОГО unit'а (кроме первого) sourceSpan.quote и evidenceByField.statement.quote ОБЯЗАНЫ сузиться до его собственного числового токена (например «двух» и «трёх» по отдельности) — НЕ повторяй у обоих unit'ов одну и ту же полную фразу целиком в sourceSpan.quote: одинаковый sourceSpan.quote при разном numericConstraint.value даёт одинаковый unitId у разных unit'ов, и прогон падает на identity-конфликте. Иначе — null.
  Для unit: "cycles" используй ТОЛЬКО когда исходный текст прямо считает циклы или целые повторяющиеся последовательности. Количество отдельных действий/случаев (например «прижать один раз») имеет unit="times", не "cycles".
- extractionRef — придумай короткий уникальный ID для ЭТОГО unit'а в рамках ЭТОГО ответа (например "u1", "u2", "u3"...). Обязан быть уникален среди ВСЕХ units этого ответа — два одинаковых extractionRef недопустимы.
- parentExtractionRef — если этот unit является ФРАГМЕНТОМ или оговоркой К КОНКРЕТНОМУ более общему правилу (например, числовое ограничение относится к нему), укажи extractionRef именно этого логического базового unit'а ИЗ ЭТОГО ЖЕ ОТВЕТА. Несколько обязательных действий, перечисленных рядом («получить согласие, надеть перчатки и остановиться по просьбе»), являются СО-ОБЯЗАТЕЛЬНЫМИ соседями, а не родителями друг друга: у них parentExtractionRef=null, если текст явно не задаёт отношение общего правила и его фрагмента/оговорки. Родитель обязан существовать среди units, которые ты возвращаешь сейчас — если общее правило само не выделяется отдельным unit'ом, оставь parentExtractionRef null, НЕ изобретай ссылку на unit, которого нет. Unit не может ссылаться сам на себя. Если unit самостоятелен — null.
  ЧАСТЫЙ НЕВЕРНЫЙ ПАТТЕРН: правило о СПОСОБЕ/ТЕХНИКЕ действия, стоящее в тексте рядом с правилом об УСЛОВИИ МЕСТА/КОНТЕКСТА (например, требование уединиться перед действием), — это НЕ исключение из правила про место, а отдельное самостоятельное правило про способ, даже если оба находятся в одном блоке подряд.
  НЕВЕРНО: {"kind":"EXCEPTION_RULE","parentExtractionRef":"<unit про уединение в приватном месте>","triggerCondition":{"all":[{"fact":"privacyContext","equals":"PRIVATE"}]}} для правила «регулярное выполнение действия определённым способом не считается надлежащим» — текст не говорит, что этот запрет действует только в приватной обстановке; он про технику и не зависит от места.
  ВЕРНО: kind="PROCEDURE_STEP", parentExtractionRef=null, triggerCondition=null. Текстовая близость двух правил в одном блоке сама по себе не создаёт между ними отношения условие/исключение — его создаёт только сам текст.
  ЕЩЁ ОДИН ЧАСТЫЙ НЕВЕРНЫЙ ПАТТЕРН: фраза, которая ПОДТВЕРЖДАЕТ, что базовое правило НЕ отменяется («желание продолжить не отменяет ограничение», «это не освобождает от требования»), — это НЕ EXCEPTION_RULE. Исключение по определению ИЗМЕНЯЕТ или ОТМЕНЯЕТ базовое правило при каком-то условии; фраза, прямо отрицающая отмену, делает противоположное — она подтверждает безусловность базового правила. Такую фразу структурируй как parentExtractionRef на base-unit, kind="PROCEDURE_STEP", triggerCondition=null — без выдуманного условия только ради того, чтобы оправдать kind="EXCEPTION_RULE".
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
