import prisma from '@/lib/db';

/**
 * Журнал вызовов модели в БД (PR #52).
 *
 * ЗАЧЕМ ОТДЕЛЬНО ОТ `call-trace-log.ts`. Тот пишет JSONL в файл и создан для
 * бенчмарк-прогонов: на машине разработчика файл рядом, его видно. В прод-
 * контейнере (Railway) файл эфемерен и недостижим — упал живой ответ, а
 * посмотреть, что именно ушло в модель и что она вернула, негде. Эта таблица —
 * прод-наблюдаемый эквивалент, и другого назначения у неё нет.
 *
 * ПОЧЕМУ ПО УМОЛЧАНИЮ ВЫКЛЮЧЕН. Схема `LlmCallLog` приземлилась на master ещё
 * из #52, но без пишущего кода: инструментацию сознательно не мержили, потому
 * что она тащит PII без срока хранения (translation-m0x). Содержимое промпта в
 * бюро переводов — это персональные данные клиента: ФИО в документах, номера
 * паспортов, адреса. Поэтому здесь три клапана, а не один:
 *
 *   1. Выключено по умолчанию — `LLM_CALL_LOG_ENABLED=true` включает осознанно
 *      и временно, на время разбора инцидента.
 *   2. `redactPii()` вычищает машинно-опознаваемые идентификаторы ДО записи.
 *   3. Срок хранения — `scripts/cleanup-llm-log.ts`, по умолчанию 30 дней.
 *
 * ЧЕГО РЕДАКТИРОВАНИЕ НЕ ДЕЛАЕТ (решение, принятое явно): ФИО не вычищаются.
 * Надёжно отличить имя человека от названия услуги или города регулярным
 * выражением нельзя, а ненадёжная зачистка хуже честного отсутствия — она даёт
 * ложное чувство безопасности и портит те самые данные, ради которых журнал
 * включали. Поэтому защита имён держится на клапанах 1 и 3, а не на 2: журнал
 * не работает постоянно и не хранится долго.
 */

/** Схема обрезает тексты на этой длине — см. комментарий у `systemPrompt`. */
export const LLM_CALL_LOG_MAX_CHARS = 20_000;

const TRUNCATION_MARKER = '...[truncated]';

/** По умолчанию — 30 дней. Меняется через `LLM_CALL_LOG_RETENTION_DAYS`. */
export const DEFAULT_RETENTION_DAYS = 30;

export interface LlmCallLogContext {
  /** Какая функция дёрнула модель: `answering-engine.synthesis` и т.п. */
  readonly callSite: string;
  readonly sessionId?: string;
  /**
   * Вопрос пользователя, запустивший всю цепочку — общий якорь, по которому
   * все 5–9 записей одного ответа собираются одним запросом.
   */
  readonly question?: string;
}

export interface LlmCallLogEntry extends LlmCallLogContext {
  readonly provider: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly userMessage: string;
  /** `null`, если вызов упал до получения ответа. */
  readonly rawResponse?: string | null;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly responseFormat?: string;
  readonly streaming?: boolean;
  readonly latencyMs?: number;
  /** Текст ошибки, если вызов (со всеми ретраями и резервом) не удался. */
  readonly error?: string | null;
}

/**
 * Читается при КАЖДОМ вызове, а не один раз при загрузке модуля: иначе
 * переменную нельзя ни подменить в тесте, ни включить без рестарта пода —
 * а включают её именно тогда, когда инцидент уже идёт.
 */
export function isLlmCallLogEnabled(): boolean {
  return process.env.LLM_CALL_LOG_ENABLED === 'true';
}

export function llmCallLogRetentionDays(): number {
  const raw = process.env.LLM_CALL_LOG_RETENTION_DAYS;
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw);
  // Ноль и отрицательное молча превратили бы «хранить 30 дней» в «удалить всё»
  // или «не удалять никогда» — оба варианта хуже дефолта, оба берутся из
  // опечатки в переменной окружения.
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(parsed);
}

/**
 * Порядок важен: узкие шаблоны идут ДО широкого «длинного числа», иначе тот
 * съест их первым и в журнале не останется даже типа затёртого идентификатора.
 */
const REDACTIONS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g, replacement: '[email]' },
  // Паспорт РФ: серия 4 цифры + номер 6, с пробелом/дефисом или слитно.
  { pattern: /\b\d{4}[ -]?\d{6}\b/g, replacement: '[doc-number]' },
  // СНИЛС: 123-456-789 01.
  { pattern: /\b\d{3}-\d{3}-\d{3}[ -]?\d{2}\b/g, replacement: '[snils]' },
  // Телефон: +7/8, скобки, дефисы и пробелы в любых сочетаниях.
  { pattern: /(?:\+7|\b8)[ -]?\(?\d{3}\)?[ -]?\d{3}[ -]?\d{2}[ -]?\d{2}\b/g, replacement: '[phone]' },
  // Остальные длинные цифровые последовательности: ИНН, номера свидетельств,
  // счетов. Порог 9 выбран так, чтобы не задеть цены и годы — самые частые
  // числа в этом корпусе (максимум 5–6 цифр).
  { pattern: /\b\d{9,}\b/g, replacement: '[number]' },
];

/**
 * Вычищает машинно-опознаваемые идентификаторы. НЕ вычищает ФИО — почему
 * именно так, см. шапку модуля.
 */
export function redactPii(text: string): string {
  return REDACTIONS.reduce(
    (acc, { pattern, replacement }) => acc.replace(pattern, replacement),
    text
  );
}

/** Обрезает с явной пометкой: молча укороченный промпт при разборе инцидента
 *  выглядит как промпт, который таким и отправили. */
export function truncateForLog(text: string, maxChars = LLM_CALL_LOG_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

function prepare(text: string): string {
  return truncateForLog(redactPii(text));
}

/**
 * Пишет запись журнала. Ничего не бросает наружу НИ ПРИ КАКИХ условиях:
 * диагностический журнал, уронивший боевой ответ пользователю, — это худший
 * из возможных размеров этой фичи. Отказ записи виден в логах пода и только.
 */
export async function recordLlmCall(entry: LlmCallLogEntry): Promise<void> {
  if (!isLlmCallLogEnabled()) return;

  try {
    await prisma.llmCallLog.create({
      data: {
        callSite: entry.callSite,
        provider: entry.provider,
        model: entry.model,
        systemPrompt: prepare(entry.systemPrompt),
        userMessage: prepare(entry.userMessage),
        rawResponse:
          entry.rawResponse === undefined || entry.rawResponse === null
            ? null
            : prepare(entry.rawResponse),
        ...(entry.temperature !== undefined && { temperature: entry.temperature }),
        ...(entry.maxTokens !== undefined && { maxTokens: entry.maxTokens }),
        ...(entry.responseFormat !== undefined && { responseFormat: entry.responseFormat }),
        streaming: entry.streaming ?? false,
        ...(entry.latencyMs !== undefined && { latencyMs: entry.latencyMs }),
        error:
          entry.error === undefined || entry.error === null ? null : prepare(entry.error),
        ...(entry.sessionId !== undefined && { sessionId: entry.sessionId }),
        question: entry.question === undefined ? null : prepare(entry.question),
      },
    });
  } catch (error) {
    console.warn('[llm-call-log] запись не удалась (вызов модели не затронут):', error);
  }
}
