import { createHash } from 'node:crypto';
import type { ExtractedKnowledgeUnit } from './extraction';
import type { KnowledgeUnitKind } from './kinds';

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

export function computeSourceBlockAnchor(
  sourceRevisionHash: string,
  sectionPath: string,
  blockStart: number,
  blockEnd: number
): string {
  return sha256Hex16(
    [sourceRevisionHash, sectionPath, String(blockStart), String(blockEnd)].join(SEP)
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
 * `triggerCondition.all` — конъюнкция ("И"), не последовательность: смысл не
 * зависит от порядка условий. `stableStringify` сортирует ключи ОБЪЕКТОВ, но
 * намеренно не трогает порядок МАССИВОВ (для большинства массивов порядок
 * значим) — без этой нормализации перестановка условий той же сутью дала бы
 * другой `contentHash`, ложный сигнал дрейфа (находка независимого ревью).
 */
function normalizeTriggerCondition(
  condition: ContentHashInput['triggerCondition']
): ContentHashInput['triggerCondition'] {
  if (condition === null) return null;
  return { all: [...condition.all].sort((a, b) => a.fact.localeCompare(b.fact)) };
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
