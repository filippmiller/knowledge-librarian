import { createHash } from 'node:crypto';
import type { ExtractedKnowledgeUnit } from './extraction';
import type { KnowledgeUnitKind } from './kinds';
import type { TriggerClause } from './trigger';

/**
 * Идентификаторы для persistence (PR F, план §3, Beads translation-179).
 *
 * Три РАЗНЫХ идентификатора, не один — Revision 4b исправила внутреннее
 * противоречие: старая формулировка называла anchor "pre-LLM", но включала
 * `kind` и per-unit дискриминатор, а оба появляются только ПОСЛЕ экстракции
 * (одно правило источника может стать тремя unit'ами).
 *
 * - `sourceBlockAnchor` — ДЕЙСТВИТЕЛЬНО pre-LLM: место в источнике, не unit.
 * - `unitId` — post-extraction, но устойчив к перефразировке `statement`.
 * - `contentHash` — отдельный fingerprint содержания, ловит дрейф; НЕ identity.
 *
 * Модуль сознательно НЕ импортирует `hashSource` из `@/lib/ai/extraction-run`:
 * тот файл транзитивно тянет `chat-provider.ts` → `openai.ts` (инициализация
 * клиента на импорте) — нарушение декларативности `applicability/`. Одна
 * строка хэширования здесь — не дубль policy-логики, а инфраструктурная
 * утилита; дублировать её дешевле, чем протаскивать импортный граф LLM-слоя
 * в модуль, который обязан оставаться «ни Prisma, ни LLM, ни ввода-вывода».
 */
function sha256Hex16(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/** NUL-разделитель при конкатенации полей перед хэшированием — без него
 *  ("ab", "c") и ("a", "bc") хэшировались бы одинаково. */
const SEP = '\u0000';

/**
 * `structuralPath` (позиционный путь в дереве документа, `docx-canonical-
 * blocks.ts`), а НЕ `sectionPath` (breadcrumb заголовков) — независимое
 * ревью PR #76, Step 3: `sectionPath` не различает структурную перестройку
 * документа (например, тот же абзац, перенесённый в ячейку таблицы), если
 * видимый текст и breadcrumb заголовков при этом не изменились — такая
 * перестройка не меняет ни `sourceRevisionHash` (зависит только от
 * `canonicalText`), ни `sectionPath`, ни `blockStart`/`blockEnd` (тот же
 * текст на том же месте линейной строки), но МЕНЯЕТ реальное место unit'а в
 * документе. `sectionPath` остаётся семантическими метаданными
 * (`SourceBlockLocation.sectionPath`) для человекочитаемого контекста, но
 * не участвует в structural identity.
 */
export function computeSourceBlockAnchor(
  sourceRevisionHash: string,
  structuralPath: string,
  blockStart: number,
  blockEnd: number
): string {
  return sha256Hex16(
    [sourceRevisionHash, structuralPath, String(blockStart), String(blockEnd)].join(SEP)
  );
}

export interface EvidenceOffsets {
  readonly start: number;
  readonly end: number;
}

/**
 * ЕДИНСТВЕННОЕ дословное вхождение `quote` в `blockText`. `null`, если цитата
 * не найдена буквально — по плану это ОШИБКА ЭКСТРАКЦИИ (LLM исказила цитату
 * при копировании), а не повод искать "похожее" вхождение эвристикой.
 *
 * `null` и при НЕСКОЛЬКИХ вхождениях — тихий выбор первого (в т.ч. когда
 * короткая цитата оказывается ВНУТРИ другого совпадения, «дней» внутри «через
 * 3 дней») означал бы, что `unitId` строится на непроверяемом угадывании
 * места, а не на точном офсете источника: то же требование "без эвристик",
 * применённое к неоднозначности, а не только к отсутствию (находка
 * независимого ревью этого PR).
 */
export function resolveEvidenceOffsets(blockText: string, quote: string): EvidenceOffsets | null {
  if (quote.length === 0) return null;
  const start = blockText.indexOf(quote);
  if (start === -1) return null;
  if (blockText.indexOf(quote, start + 1) !== -1) return null;
  return { start, end: start + quote.length };
}

export function computeUnitId(
  sourceBlockAnchor: string,
  resolvedEvidenceStart: number,
  resolvedEvidenceEnd: number,
  kind: KnowledgeUnitKind
): string {
  return sha256Hex16(
    [sourceBlockAnchor, String(resolvedEvidenceStart), String(resolvedEvidenceEnd), kind].join(SEP)
  );
}

/** Сортировка ключей рекурсивно — `JSON.stringify` сохраняет порядок вставки
 *  объекта, а два прогона извлечения одного и того же facets-набора не
 *  гарантируют одинаковый порядок ключей в LLM-выдаче. Без сортировки
 *  `contentHash` менялся бы от перестановки ключей — ложный сигнал дрейфа. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`
  );
  return `{${entries.join(',')}}`;
}

export type ContentHashInput = Pick<
  ExtractedKnowledgeUnit,
  'statement' | 'facets' | 'triggerCondition' | 'numericConstraint'
>;

/**
 * Сравнение по code units (`<`/`>`), НЕ `localeCompare` — preflight A
 * (translation-apt, независимое ревью). `localeCompare` без явной локали
 * читает locale/collation среды выполнения: тот же логический набор clauses
 * теоретически мог бы отсортироваться по-разному на разных машинах/версиях
 * Node/сборках ICU, дав РАЗНЫЙ `contentHash` для ОДНОГО И ТОГО ЖЕ unit'а —
 * а `reviewedContentHash` в committed review manifest (план §3 PR H)
 * обязан совпадать между окружением ревьюера и окружением прогона. */
function compareByCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * `triggerCondition.all` — конъюнкция ("И"), не последовательность: смысл не
 * зависит от порядка условий. `stableStringify` сортирует ключи ОБЪЕКТОВ, но
 * намеренно не трогает порядок МАССИВОВ (для большинства массивов порядок
 * значим) — без этой нормализации перестановка условий той же сутью дала бы
 * другой `contentHash`, ложный сигнал дрейфа (находка независимого ревью).
 *
 * Тай-брейк по `equals` при равном `fact` — не гипотетический кейс:
 * `triggerConditionSchema` (`trigger.ts`) запрещает дубль `fact` через
 * `superRefine`, но эта функция принимает голый TS-объект БЕЗ прогона через
 * схему (`ContentHashInput` — структурный тип, не `z.infer` с валидацией).
 * Без тай-брейка `Array.prototype.sort` (гарантированно стабильный с ES2019)
 * оставил бы такие clauses в порядке ВХОДА — то есть перестановка входа
 * меняла бы `contentHash` ровно в том случае, который сортировка должна была
 * устранить.
 */
function compareTriggerClauses(a: TriggerClause, b: TriggerClause): number {
  const byFact = compareByCodeUnits(a.fact, b.fact);
  if (byFact !== 0) return byFact;
  return compareByCodeUnits(String(a.equals), String(b.equals));
}

function normalizeTriggerCondition(
  condition: ContentHashInput['triggerCondition']
): ContentHashInput['triggerCondition'] {
  if (condition === null) return null;
  return { all: [...condition.all].sort(compareTriggerClauses) };
}

/** Fingerprint содержания — меняется, когда меняется СУТЬ unit'а, и служит
 *  обнаружению дрейфа между прогонами. НЕ используется для identity: два
 *  прогона одного и того же источника с разной формулировкой `statement`
 *  обязаны дать РАЗНЫЙ `contentHash`, но ТОТ ЖЕ `unitId` — в этом весь смысл
 *  разделения (acceptance criterion PR F). */
export function computeContentHash(unit: ContentHashInput): string {
  return sha256Hex16(
    stableStringify({
      statement: unit.statement,
      facets: unit.facets,
      triggerCondition: normalizeTriggerCondition(unit.triggerCondition),
      numericConstraint: unit.numericConstraint,
    })
  );
}
