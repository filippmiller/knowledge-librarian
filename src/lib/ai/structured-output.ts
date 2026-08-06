import type { z } from 'zod';
import {
  createChatCompletionDetailed,
  type ChatCompletionResult,
  type ChatMessage,
  type CompletionAttempt,
  type CompletionRunConfig,
  type FallbackPolicy,
  type Provider,
  type ProviderModelMap,
} from '@/lib/ai/chat-provider';
// toCompletionOptions живёт в extraction-run (A2) и остаётся ЕДИНСТВЕННЫМ местом,
// где конфигурация прогона превращается в маршрутизирующие поля вызова. Собрать
// их здесь вручную — ровно тот дубль, который A2 и удалял: разойтись primary,
// retry и structured-вызов смогли бы только через три независимые копии.
import { toCompletionOptions } from '@/lib/ai/extraction-run';

/**
 * Фоллбэк для structured-вызовов по умолчанию запрещён.
 *
 * Это не осторожность ради осторожности: `requestedFallbackPolicy()` в A1 при
 * НЕзаданной политике выводит `CROSS_PROVIDER`, и structured-вызов, забывший
 * задать политику, молча уезжал бы к другому вендору. Для extraction, судьи и
 * QueryFrame это хуже отказа: их выдачу сравнивают между прогонами, а прогон,
 * половина которого обслужена другой моделью, несравним ни с чем (A2 честно
 * пометит его `MIXED`, но потерянного сравнения это не вернёт).
 *
 * Прогону, которому резерв действительно нужен, политика задаётся явно — и
 * `servedByProvider`/`servedByModel` в результате покажут, кто ответил на самом
 * деле.
 */
export const DEFAULT_STRUCTURED_FALLBACK_POLICY: FallbackPolicy = 'NONE';

/**
 * Конфигурация прогона для structured-вызова.
 *
 * Намеренно ШИРЕ, чем `ExtractionRunConfig` из A2, по двум причинам:
 *
 * 1. `extractionSchemaVersion` — поле артефакта ИЗВЛЕЧЕНИЯ, а не свойство
 *    вызова. Требовать его здесь значило бы заставить судью (PR E) и
 *    QueryFrame-builder (PR D) выдумывать версию схемы извлечения, к которой они
 *    не имеют отношения, — то есть записывать в артефакт неправду ради типа.
 *    `ExtractionRunConfig` при этом остаётся присваиваемым сюда структурно:
 *    extraction-вызовы передают свою конфигурацию как есть.
 *
 * 2. `fallbackPolicy` необязателен, чтобы дефолт `NONE` был достижим по типам, а
 *    не только через каст. Конфигурация, собранная без политики, обязана
 *    получить `NONE`, а не унаследовать `CROSS_PROVIDER` из A1.
 */
export type StructuredRunConfig = Omit<CompletionRunConfig, 'fallbackPolicy'> & {
  fallbackPolicy?: FallbackPolicy;
  /**
   * Модели резервного провайдера. Без них `planFallback()` понижает до `NONE`
   * любой прогон с закреплённой моделью — а у structured-вызова модель
   * закреплена всегда (`toCompletionOptions` отдаёт разрезолвленную строку).
   */
  providerModels?: ProviderModelMap;
};

export interface StructuredOptions<T> {
  /** Тот же Zod, что и в контракте B1: одна валидация, а не «похожая». */
  schema: z.ZodType<T>;
  messages: ChatMessage[];
  runConfig: StructuredRunConfig;
  /** Переопределяет политику из `runConfig`. Не задано — берётся из неё. */
  fallbackPolicy?: FallbackPolicy;
  maxTokens?: number;
  temperature?: number;
  /** Внешняя отмена. Прерванная попытка попадает в `attempts[]` как `ABORTED`. */
  signal?: AbortSignal;
}

/**
 * Результат — ПОЛНЫЙ `ChatCompletionResult` плюс разобранные данные. `attempts[]`
 * доходит до вызывающего целиком: по нему PR E считает `ModelRelationship`, и
 * адаптер, отдающий только `data`, обнулил бы смысл A1/A2.
 */
export type StructuredResult<T> = ChatCompletionResult & { data: T };

/**
 * Отличает «нормализация лишь сняла обёртку» от «нормализация достроила
 * оборванный JSON».
 *
 * Снятие markdown-заборов и мусора вокруг — это нормально: сырой текст не
 * парсится, потому что вокруг JSON есть лишнее, но данные целы. Опасен другой
 * случай — сырой текст не парсится, потому что ОБОРВАН, и нормализация
 * достроила его до валидного, отбросив хвост. Различаем по длине: ремонт
 * обрезанного ответа всегда теряет содержимое, а снятие обёртки — нет.
 */
function wasRepaired(rawText: string, normalizedText: string): boolean {
  const raw = rawText.trim();
  if (!raw) return false;

  try {
    JSON.parse(raw);
    return false; // сырой ответ сам по себе валиден — чинить было нечего
  } catch {
    // разбираемся ниже
  }

  try {
    JSON.parse(normalizedText);
  } catch {
    return false; // нормализованный тоже не парсится — это INVALID_JSON, не обрыв
  }

  // Сырой не парсится, нормализованный парсится. Отличаем «сняли обёртку» от
  // «достроили обрыв» по БАЛАНСУ СКОБОК, а не по длине: markdown-забор вокруг
  // целого JSON длину меняет, но скобки в нём сбалансированы, а у оборванного
  // ответа — нет. Сравнение длин здесь давало ложные срабатывания на заборах.
  return !hasBalancedJsonBrackets(raw);
}

/** Баланс `{}`/`[]` с пропуском содержимого строк и экранирования. */
function hasBalancedJsonBrackets(text: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (const char of text) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
  }

  return depth === 0 && !inString;
}

/** Одна претензия схемы к ответу модели: путь до поля + причина. */
export interface StructuredIssue {
  /** Путь в нотации `facets.scenario.state` / `notes[1]`. */
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export type StructuredFailureReason =
  | 'INVALID_JSON'
  | 'SCHEMA_MISMATCH'
  /**
   * Схема упала сама, не вынеся вердикта. `safeParse()` в Zod 4 НЕ ловит
   * исключения из `.transform()`/`.superRefine()`/`.check()`/`z.custom()` — он их
   * пробрасывает (проверено на 4.3.5). Без этой ветки такая схема уносила бы
   * наружу голый `Error` без `attempts[]`, то есть ровно ту телеметрию, ради
   * которой адаптер и возвращает полный результат вызова.
   */
  | 'SCHEMA_THREW'
  /**
   * Ответ провайдера оборван на полуслове. Нормализация умеет «починить» такой
   * JSON, и результат может пройти схему — просто с меньшим числом элементов
   * массива. Отдельная причина, а не `INVALID_JSON`: тут вызывающему нужен
   * повтор запроса, а не разбор претензий к полям.
   */
  | 'TRUNCATED_JSON';

/**
 * Ответ пришёл, но контракту не соответствует.
 *
 * Отдельный класс, а не `ChatCompletionError`: там «не ответил никто», здесь
 * ответил конкретный провайдер конкретной моделью — и это известно
 * (`result.servedByProvider`/`servedByModel`). Свалить их в один тип значило бы
 * потерять единственное различие, ради которого журнал вызовов существует.
 *
 * `attempts` — геттер поверх `result.attempts`, а не копия: разойтись они не
 * могут физически.
 */
export class StructuredOutputError extends Error {
  readonly reason: StructuredFailureReason;
  readonly issues: readonly StructuredIssue[];
  /** Полный результат вызова, включая `attempts[]` и фактического исполнителя. */
  readonly result: ChatCompletionResult;

  constructor(
    reason: StructuredFailureReason,
    issues: readonly StructuredIssue[],
    result: ChatCompletionResult,
    options?: { cause?: unknown }
  ) {
    super(buildMessage(reason, issues, result));
    this.name = 'StructuredOutputError';
    this.reason = reason;
    this.issues = issues;
    this.result = result;
    if (options && 'cause' in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }

  get attempts(): CompletionAttempt[] {
    return this.result.attempts;
  }

  get servedByProvider(): Provider {
    return this.result.servedByProvider;
  }

  get servedByModel(): string {
    return this.result.servedByModel;
  }
}

/** Сколько претензий печатается в сообщении, прежде чем оно станет нечитаемым. */
const MAX_LISTED_ISSUES = 5;

/**
 * Путь до поля в человекочитаемой нотации. Пустой путь — претензия к корню
 * ответа целиком (например, `Unrecognized key` у `strictObject`).
 */
function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '<корень ответа>';

  let formatted = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      formatted += `[${segment}]`;
    } else if (typeof segment === 'symbol') {
      formatted += `[${String(segment)}]`;
    } else {
      formatted += formatted === '' ? segment : `.${segment}`;
    }
  }
  return formatted;
}

function buildMessage(
  reason: StructuredFailureReason,
  issues: readonly StructuredIssue[],
  result: ChatCompletionResult
): string {
  const served = `${result.servedByProvider}/${result.servedByModel}`;

  if (reason === 'INVALID_JSON') {
    const cause = issues[0]?.message ?? 'причина не определена';
    return `structured(): ответ ${served} не разобрался как JSON: ${cause}`;
  }

  if (reason === 'SCHEMA_THREW') {
    const cause = issues[0]?.message ?? 'причина не определена';
    return `structured(): схема упала на ответе ${served}, вердикта нет: ${cause}`;
  }

  if (reason === 'TRUNCATED_JSON') {
    return `structured(): ответ ${served} оборван — нормализация «починила» бы его с потерей данных, нужен повтор`;
  }

  const listed = issues
    .slice(0, MAX_LISTED_ISSUES)
    .map((issue) => `${issue.path}: ${issue.message} [${issue.code}]`)
    .join('; ');
  const hidden = issues.length - MAX_LISTED_ISSUES;
  const tail = hidden > 0 ? `; и ещё ${hidden}` : '';

  return `structured(): ответ ${served} не прошёл валидацию схемы (${issues.length} шт.): ${listed}${tail}`;
}

/**
 * Чистая половина `structured()`: разбор и валидация уже полученного ответа.
 *
 * Вынесена отдельно, потому что это единственный способ проверить ветку
 * «провайдер отдал неразбираемый JSON» — provider-слой в режиме `json_object`
 * прогоняет текст через `normalizeJsonResponse()` и в худшем случае отдаёт `{}`,
 * так что через живой вызов эта ветка недостижима. Реализация ОДНА: `structured()`
 * вызывает эту же функцию, второй копии проверки не существует.
 */
export function validateStructuredPayload<T>(
  schema: z.ZodType<T>,
  result: ChatCompletionResult
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StructuredOutputError(
      'INVALID_JSON',
      [{ path: '<корень ответа>', code: 'invalid_json', message }],
      result,
      { cause: error }
    );
  }

  // `safeParse` безопасен только относительно НЕсоответствия схеме: исключение
  // из `.transform()`/`.superRefine()`/`.check()`/`z.custom()` он пробрасывает
  // как есть. Не поймать его здесь значило бы отдать вызывающему голый `Error`
  // без `attempts[]` — единственная дыра, через которую телеметрия вызова могла
  // бы потеряться.
  let validation: ReturnType<z.ZodType<T>['safeParse']>;
  try {
    validation = schema.safeParse(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new StructuredOutputError(
      'SCHEMA_THREW',
      [{ path: '<схема>', code: 'schema_threw', message }],
      result,
      { cause: error }
    );
  }

  if (!validation.success) {
    // Ни коэрсии, ни частичного приёма: адаптер принимает ровно то, что принимает
    // схема, и ни байтом больше. Насколько строг сам контракт — решает схема
    // (в B1 это `strictObject`, отвергающий лишние ключи, а не молча их срезающий).
    const issues: StructuredIssue[] = validation.error.issues.map((issue) => ({
      path: formatIssuePath(issue.path),
      code: issue.code,
      message: issue.message,
    }));
    throw new StructuredOutputError('SCHEMA_MISMATCH', issues, result);
  }

  return validation.data;
}

/**
 * Вызов модели, ответ которого обязан соответствовать схеме.
 *
 * Возвращает `data` ВМЕСТЕ с полным результатом вызова: кто ответил, сработал ли
 * резерв и все попытки по порядку. Downstream (PR D/E) записывает эти поля в
 * артефакт прогона — адаптер, отдающий один `data`, заставил бы их пересчитывать
 * маршрутизацию по env, то есть врать.
 */
export async function structured<T>(
  opts: StructuredOptions<T>
): Promise<StructuredResult<T>> {
  const fallbackPolicy =
    opts.fallbackPolicy ??
    opts.runConfig.fallbackPolicy ??
    DEFAULT_STRUCTURED_FALLBACK_POLICY;

  const routing = toCompletionOptions({ ...opts.runConfig, fallbackPolicy });

  const result = await createChatCompletionDetailed({
    ...routing,
    messages: opts.messages,
    // JSON-режим обоих провайдеров + нормализация ответа — из provider-слоя, а не
    // своя. Побочный эффект осознан: `result.text` здесь уже нормализованный, и
    // ответ прозой доезжает до схемы как `{}` (претензии будут про отсутствующие
    // поля, а не про «это не JSON»).
    responseFormat: 'json_object',
    ...(opts.maxTokens !== undefined && { maxTokens: opts.maxTokens }),
    ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    ...(opts.signal && { signal: opts.signal }),
  });

  // Обрезанный ответ НЕ чинится молча. `normalizeJsonResponse()` достраивает
  // скобки и отбрасывает хвостовой огрызок — для v1-синтеза это правильно, но
  // здесь опасно: ответ, оборванный ПОСЛЕ целого элемента массива
  // (`{"units":[{...},{...}],`), чинится в объект, который схему ПРОХОДИТ, просто
  // с меньшим числом units. Тихая потеря знания вместо retry — ровно то, чего
  // structured-контракт допускать не должен. Признак ремонта: сырой ответ сам по
  // себе не парсится, а нормализованный парсится.
  if (result.rawText !== undefined && wasRepaired(result.rawText, result.text)) {
    throw new StructuredOutputError(
      'TRUNCATED_JSON',
      [
        {
          path: '',
          code: 'truncated_response',
          message:
            'ответ провайдера оборван и был бы «починен» нормализацией: часть данных потеряна, нужен повторный вызов',
        },
      ],
      result
    );
  }

  // Резерв провайдера НЕ спасает от несоответствия схеме, и это осознанно:
  // `createChatCompletionDetailed` возвращается на первом же ответе провайдера,
  // а схема проверяется после. Ответ 200 с мусором внутри валит вызов целиком, к
  // другому вендору за «может, у него получится» адаптер не ходит — иначе
  // `servedByModel` перестал бы означать «модель, чью выдачу вы читаете».
  // Перезапрос по содержательной причине — решение вызывающего (consistency
  // retry в PR E), а не молчаливая механика адаптера.
  return { ...result, data: validateStructuredPayload(opts.schema, result) };
}
