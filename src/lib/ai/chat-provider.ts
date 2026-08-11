import { openai, CHAT_MODEL as OPENAI_DEFAULT_MODEL } from '@/lib/openai';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type Provider = 'anthropic' | 'openai';

/**
 * Что разрешено делать, когда первичный провайдер/модель не ответили.
 *
 * `SAME_PROVIDER_ONLY` в A1 имеет ровно один доступный резерв — альтернативную
 * модель того же провайдера, объявленную в `providerModels[primaryProvider]`.
 * Если она не объявлена или совпадает с первичной, резерва физически нет и
 * политика ведёт себя как `NONE` (а не как молчаливый кросс-провайдерный
 * фоллбэк).
 */
export type FallbackPolicy = 'NONE' | 'SAME_PROVIDER_ONLY' | 'CROSS_PROVIDER';

/** Валидный model ID для каждого провайдера отдельно. */
export interface ProviderModelMap {
  anthropic?: string;
  openai?: string;
}

/**
 * Разрешённая конфигурация одного прогона — то, что фактически поехало в API,
 * а не то, что было в env на момент старта процесса.
 *
 * Определена ЗДЕСЬ, в provider-слое, намеренно: extraction/grader/structured
 * output (A2/C/D/E) расширяют её своими полями, а provider-слой не зависит от
 * extraction-specific типа.
 */
export interface CompletionRunConfig {
  provider: Provider;
  model: string;
  promptVersion: string;
  fallbackPolicy: FallbackPolicy;
  requestTimeoutMs?: number;
  totalDeadlineMs?: number;
  /** Optional synchronous circuit breaker invoked immediately before every
   *  raw provider request, including transport retries and fallback. Throwing
   *  prevents that request from starting. Runtime-only; never persisted. */
  beforeProviderAttempt?: (attempt: { provider: Provider; model: string }) => void;
  /** Structured-output observer for exact post-call usage accounting. */
  onCompletionAttempts?: (attempts: readonly CompletionAttempt[]) => void;
}

export interface ChatCompletionOptions extends Partial<CompletionRunConfig> {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json_object';
  /**
   * Заставляет вызов идти к конкретному провайдеру, минуя глобальный
   * AI_PROVIDER. Нужно там, где независимость провайдера — часть смысла
   * вызова, а не оптимизация: LLM-judge, оценивающий выдачу экстрактора,
   * на том же провайдере и той же модели разделяет с ним характер ошибок,
   * то есть «независимый экзаменатор» только на словах.
   * Fallback на второго провайдера при этом сохраняется — закрепление
   * относится к выбору ПЕРВИЧНОГО провайдера, не к отказу от резерва.
   */
  provider?: Provider;
  /**
   * Закрепление модели ПЕРВИЧНОГО провайдера. Закреплённая модель никогда не
   * уходит другому провайдеру: у второго провайдера её просто не существует
   * (подтверждено живым прогоном — `claude-sonnet-5` уезжал в OpenAI и
   * возвращал `model_not_found`). Резерв берётся только из `providerModels`.
   */
  model?: string;
  /**
   * Валидные model ID по провайдерам. Наличие записи для резервного провайдера
   * — единственный способ разрешить кросс-провайдерный фоллбэк при
   * закреплённой модели.
   */
  providerModels?: ProviderModelMap;
  /** Таймаут ОДНОЙ попытки (primary или fallback). */
  requestTimeoutMs?: number;
  /** Суммарный дедлайн на весь вызов, включая retry и фоллбэк. */
  totalDeadlineMs?: number;
  /** Внешняя отмена. Прерванная попытка получает outcome `ABORTED`, не `ERROR`. */
  signal?: AbortSignal;
}

/** Токены реального вызова провайдера — источник для cost meter (Task 37).
 *  Отсутствует у ERROR/ABORTED попыток без ответа: нечего посчитать. */
export interface CompletionUsage {
  /**
   * `input_tokens` провайдера как есть. У Anthropic с включённым кэшированием
   * это НЕкэшированный остаток промпта, а не весь промпт: полный размер входа
   * равен `inputTokens + cacheCreationInputTokens + cacheReadInputTokens`.
   * Смысл поля не менялся — менялось то, сколько промпта в него попадает.
   */
  inputTokens: number;
  outputTokens: number;
  /**
   * Anthropic `cache_creation_input_tokens` — записано в кэш этим вызовом
   * (тарифицируется дороже обычного входа). Отсутствует, когда провайдер
   * счётчика не прислал (OpenAI-путь, ответ без кэша) — не подменяется нулём:
   * «кэш-запись 0» и «провайдер про кэш ничего не сказал» — разные факты.
   */
  cacheCreationInputTokens?: number;
  /**
   * Anthropic `cache_read_input_tokens` — прочитано из кэша (тарифицируется
   * заметно дешевле обычного входа). Ненулевое значение здесь — единственное
   * прямое доказательство, что breakpoint реально сработал.
   */
  cacheReadInputTokens?: number;
}

export interface CompletionAttempt {
  provider: Provider;
  model: string;
  /** ISO-8601 момент старта попытки. */
  startedAt: string;
  latencyMs: number;
  outcome: 'SUCCESS' | 'ERROR' | 'ABORTED';
  statusCode?: number;
  errorCode?: string;
  usage?: CompletionUsage;
}

export interface ChatCompletionResult {
  text: string;
  /**
   * Ответ провайдера ДО `normalizeJsonResponse()`.
   *
   * Нормализация чинит обрезанный JSON (достраивает скобки, отбрасывает
   * хвостовой огрызок), и это правильно для v1-синтеза, но для structured-вызова
   * опасно: ответ, обрезанный после целого элемента массива, чинится в объект,
   * который СХЕМУ ПРОХОДИТ — просто с меньшим числом units. Молчаливая потеря
   * знания вместо retry. Вызывающий, которому важна полнота, сверяет `rawText`
   * сам (см. `structured()`), а `text` остаётся прежним для всех остальных.
   *
   * Опционально ТОЛЬКО ради тестовых моков, собирающих результат вручную:
   * боевой путь заполняет поле всегда.
   */
  rawText?: string;
  servedByProvider: Provider;
  servedByModel: string;
  fallbackUsed: boolean;
  /** Каждая попытка по порядку, включая ABORTED и неудачные retry. */
  attempts: CompletionAttempt[];
  /**
   * ЛОГИЧЕСКИЕ сообщения, переданные ЭТОМУ вызову — `options.messages` как
   * они есть, одни и те же для всех попыток (retry/fallback меняют
   * провайдера или модель, но не промпт). Источник для call-trace log
   * бенчмарк-раннера (2026-08-10): без этого поля у пользователя не было
   * способа сопоставить конкретный "плохой" ответ с тем, что именно у
   * модели спросили — только агрегатная стоимость.
   *
   * НЕ обязательно байт-в-байт то, что реально ушло по проводам (Codex
   * review, 2026-08-10, finding 6): `buildAnthropicPayload` разделяет
   * system-сообщения в отдельное поле `system`, объединяет их, и может
   * добавить JSON-mode инструкцию, которой в `options.messages` не было;
   * OpenAI-путь может добавить аналогичную инструкцию через
   * `withOpenAiJsonInstruction`. Всё содержимое при этом сохраняется — просто
   * переструктурировано — так что для отладки (сопоставить "что спросили" с
   * "что ответили") этого поля достаточно почти всегда; для случая, где
   * важна ИМЕННО итоговая проводная форма (например: JSON-mode инструкция
   * сама стала причиной SCHEMA_MISMATCH), см. `buildAnthropicPayload`/
   * `withOpenAiJsonInstruction` — воспроизвести трансформацию можно оттуда.
   *
   * Опционально, но НЕ по той же причине, что `rawText?`/`usage?` выше: на
   * боевом пути оно заполняется ВСЕГДА (`options.messages` есть у любого
   * вызова структурно, отсутствовать ему неоткуда). Опционально оно ради уже
   * существующих тестовых моков в других файлах (`structured-output.test.ts`,
   * `knowledge-extractor-stream.test.ts`), которые собирают `ChatCompletionResult`
   * вручную и не обязаны знать про это поле — требовать его сделало бы их
   * недействительными без всякой пользы для того, что они реально проверяют.
   */
  requestMessages?: readonly ChatMessage[];
}

/**
 * Полный отказ (первичный провайдер И резерв). Бросается вместо сырой ошибки
 * провайдера, чтобы телеметрия попыток не терялась в catch-блоке.
 *
 * `message` — СЫРОЕ сообщение первопричины, ровно как до provider-слоя, когда
 * наружу летел `throw lastError`. Это осознанное ограничение: два сегодняшних
 * потребителя читают текст как есть (`src/app/api/health/ai/route.ts` —
 * `error.message`, `src/lib/ai/consistency-gate.ts` — `String(err)`), и ни один
 * не должен разбирать новый формат. Вся добавленная диагностика живёт в
 * структурных полях: `cause`, `attempts`, `errorCode`, `statusCode`.
 */
export class ChatCompletionError extends Error {
  readonly attempts: CompletionAttempt[];
  readonly errorCode?: string;
  readonly statusCode?: number;
  /** Same call-trace source as `ChatCompletionResult.requestMessages` — a
   *  total transport failure still had a real prompt behind it, and that
   *  prompt is exactly what a debugging trace needs even when no response
   *  ever came back. Optional in the constructor options bag (not a
   *  positional parameter) so the two pre-existing test call sites that
   *  construct this error by hand (`extraction-run.test.ts`,
   *  `knowledge-extractor-stream.test.ts`) stay valid unchanged. */
  readonly requestMessages?: readonly ChatMessage[];

  constructor(
    message: string,
    attempts: CompletionAttempt[],
    options?: {
      cause?: unknown;
      errorCode?: string;
      statusCode?: number;
      requestMessages?: readonly ChatMessage[];
    }
  ) {
    super(message);
    this.name = 'ChatCompletionError';
    this.attempts = attempts;
    this.errorCode = options?.errorCode;
    this.statusCode = options?.statusCode;
    this.requestMessages = options?.requestMessages;
    if (options && 'cause' in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Текст первопричины без обёрток — то, что видели call sites до A1. */
function rawMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Внутренняя ошибка одной HTTP-попытки — несёт статус для классификации. */
class ProviderRequestError extends Error {
  readonly statusCode?: number;
  readonly errorCode?: string;

  constructor(
    message: string,
    options?: { statusCode?: number; errorCode?: string }
  ) {
    super(message);
    this.name = 'ProviderRequestError';
    this.statusCode = options?.statusCode;
    this.errorCode = options?.errorCode;
  }
}

// Читаются на СТАРТЕ вызова, а не на импорте модуля: значение env на момент
// вызова — то же, что фактически поехало в API, и его можно менять между
// прогонами. Читать их повторно внутри попытки нельзя — см. resolveDefaults().
function defaultAnthropicModel(): string {
  return process.env.ANTHROPIC_MODEL || 'claude-3-opus-20240229';
}

function defaultOpenAIModel(): string {
  return process.env.OPENAI_CHAT_MODEL || OPENAI_DEFAULT_MODEL;
}

function defaultTemperature(): number {
  return Number(process.env.AI_TEMPERATURE || 0.3);
}

function defaultAnthropicMaxTokens(): number {
  return Number(process.env.ANTHROPIC_MAX_TOKENS || 2048);
}

export function getProvider(): Provider {
  const provider = (process.env.AI_PROVIDER || '').toLowerCase();
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'openai') return 'openai';
  return process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai';
}

function otherProvider(provider: Provider): Provider {
  return provider === 'anthropic' ? 'openai' : 'anthropic';
}

function defaultModelFor(provider: Provider): string {
  return provider === 'anthropic' ? defaultAnthropicModel() : defaultOpenAIModel();
}

/**
 * Env-зависимые значения, снятые ОДИН РАЗ на старте вызова и живущие ровно
 * столько, сколько живёт вызов.
 *
 * Дефолты читаются во время вызова (а не при импорте) сознательно — это делает
 * слой тестируемым и позволяет менять конфигурацию между прогонами. Но внутри
 * ОДНОГО вызова env обязан быть заморожен: между первичной попыткой и резервом
 * проходит реальное время, и мутация env в этом окне иначе увела бы резерв на
 * другую модель, другой бюджет токенов и другую температуру, чем те, ради
 * которых вызов был начат. Прогон должен быть описуем одной конфигурацией.
 */
interface ResolvedDefaults {
  temperature: number;
  anthropicMaxTokens: number;
  anthropicApiKey?: string;
  openaiApiKey?: string;
}

function resolveDefaults(options: ChatCompletionOptions): ResolvedDefaults {
  return {
    temperature: options.temperature ?? defaultTemperature(),
    anthropicMaxTokens: options.maxTokens ?? defaultAnthropicMaxTokens(),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
  };
}

function hasApiKey(provider: Provider, defaults: ResolvedDefaults): boolean {
  return provider === 'anthropic'
    ? !!defaults.anthropicApiKey
    : !!defaults.openaiApiKey;
}

/**
 * Модель ПЕРВИЧНОГО провайдера: явное закрепление важнее карты моделей,
 * карта — важнее env-дефолта.
 */
function resolvePrimaryModel(
  provider: Provider,
  options: ChatCompletionOptions
): string {
  // `||`, а не `??`: сегодняшние call sites передают `process.env.X || undefined`
  // и рассчитывают, что пустая строка — это «не задано», как было до PR.
  return (
    options.model || options.providerModels?.[provider] || defaultModelFor(provider)
  );
}

/**
 * Модель РЕЗЕРВНОГО провайдера. `options.model` здесь сознательно не
 * участвует: именно переиспользование закреплённой модели на другом провайдере
 * и было багом.
 */
function resolveFallbackModel(
  provider: Provider,
  options: ChatCompletionOptions
): string {
  return options.providerModels?.[provider] || defaultModelFor(provider);
}

/**
 * Дефолт фоллбэк-политики (что ЗАПРОШЕНО). Три случая, и все три важны:
 *
 * - модель закреплена + для резервного провайдера нет model ID → `NONE`
 *   (fail-closed: явное закрепление важнее отказоустойчивости);
 * - модель закреплена + model ID резервного провайдера задан → `CROSS_PROVIDER`
 *   с этой моделью;
 * - модель НЕ закреплена (сегодняшний типичный call site) → `CROSS_PROVIDER` с
 *   дефолтной моделью целевого провайдера, то есть ровно сегодняшнее поведение.
 */
function requestedFallbackPolicy(options: ChatCompletionOptions): FallbackPolicy {
  if (options.fallbackPolicy) return options.fallbackPolicy;
  if (!options.model) return 'CROSS_PROVIDER';
  const fallbackProvider = otherProvider(options.provider ?? getProvider());
  return options.providerModels?.[fallbackProvider] ? 'CROSS_PROVIDER' : 'NONE';
}

interface FallbackPlan {
  /** Политика как её попросили (или как вывел дефолт). */
  requested: FallbackPolicy;
  /** Политика, которая ФАКТИЧЕСКИ будет исполнена. */
  effective: FallbackPolicy;
  target?: { provider: Provider; model: string };
}

/**
 * Единственное место, где решается судьба резерва. `effective` может быть
 * строже `requested` — и это должно быть видно снаружи, а не только в runtime:
 * артефакт прогона (A2) записывает `effective`, иначе он утверждал бы
 * «CROSS_PROVIDER» там, где фоллбэк был заблокирован.
 */
function planFallback(options: ChatCompletionOptions): FallbackPlan {
  const requested = requestedFallbackPolicy(options);
  const primaryProvider = options.provider ?? getProvider();
  const primaryModel = resolvePrimaryModel(primaryProvider, options);

  if (requested === 'CROSS_PROVIDER') {
    const fallbackProvider = otherProvider(primaryProvider);
    const fallbackProviderModel = options.providerModels?.[fallbackProvider];
    // Закреплённая модель уходит другому провайдеру ТОЛЬКО через providerModels
    // — даже если CROSS_PROVIDER запрошен явно. Молчаливая подмена модели хуже,
    // чем честный отказ: у второго провайдера этой модели просто нет.
    if (options.model && !fallbackProviderModel) {
      return { requested, effective: 'NONE' };
    }
    return {
      requested,
      effective: 'CROSS_PROVIDER',
      target: {
        provider: fallbackProvider,
        model: resolveFallbackModel(fallbackProvider, options),
      },
    };
  }

  if (requested === 'SAME_PROVIDER_ONLY') {
    // Единственный доступный в A1 резерв того же провайдера — альтернативная
    // модель из providerModels. Нет её (или совпадает с первичной) — резерва
    // физически нет, и политика обязана честно называться NONE.
    const alternate = options.providerModels?.[primaryProvider];
    if (!alternate || alternate === primaryModel) {
      return { requested, effective: 'NONE' };
    }
    return {
      requested,
      effective: 'SAME_PROVIDER_ONLY',
      target: { provider: primaryProvider, model: alternate },
    };
  }

  return { requested, effective: 'NONE' };
}

/**
 * ФАКТИЧЕСКАЯ фоллбэк-политика вызова — то, что будет исполнено, а не то, что
 * попросили. Downstream-артефакты записывают именно её.
 */
export function resolveFallbackPolicy(
  options: ChatCompletionOptions
): FallbackPolicy {
  return planFallback(options).effective;
}

/**
 * Фактическая конфигурация прогона — для артефактов A2/C/D/E, которым нужно
 * записать, что именно поехало, а не пересчитывать те же дефолты у себя.
 */
export function resolveRunConfig(
  options: ChatCompletionOptions
): CompletionRunConfig {
  const provider = options.provider ?? getProvider();
  return {
    provider,
    model: resolvePrimaryModel(provider, options),
    promptVersion: options.promptVersion ?? 'unversioned',
    fallbackPolicy: resolveFallbackPolicy(options),
    requestTimeoutMs: options.requestTimeoutMs,
    totalDeadlineMs: options.totalDeadlineMs,
    ...(options.beforeProviderAttempt && {
      beforeProviderAttempt: options.beforeProviderAttempt,
    }),
    ...(options.onCompletionAttempts && {
      onCompletionAttempts: options.onCompletionAttempts,
    }),
  };
}

function buildAnthropicPayload(options: ChatCompletionOptions) {
  const systemParts = options.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content.trim())
    .filter(Boolean);
  const userMessages = options.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  const responseFormatInstruction =
    options.responseFormat === 'json_object'
      ? 'Respond with valid JSON only. Use double quotes for all keys and string values. Do not wrap in markdown or add commentary.'
      : null;

  const system = [...systemParts, responseFormatInstruction]
    .filter(Boolean)
    .join('\n\n');

  return {
    system: system || undefined,
    messages: userMessages,
  };
}

/* ------------------------------------------------------------------------ *
 * Prompt caching (W1-B, 2026-08-10) — только Anthropic.
 *
 * Большие system-промпты этого репозитория (экстракция знаний, coverage-audit,
 * QueryFrame) постоянны в пределах прогона и переотправлялись на КАЖДЫЙ вызов
 * по полной входной цене. Anthropic кэширует префикс запроса по breakpoint'у
 * `cache_control`; порядок рендера — `tools` → `system` → `messages`, tools
 * здесь нет, поэтому system и есть весь стабильный префикс, а меняющийся от
 * вызова к вызову user-текст лежит ПОСЛЕ breakpoint'а и его не инвалидирует.
 *
 * Синтаксис, минимумы и семантика счётчиков — из скилла `claude-api`
 * (сверено 2026-08-10), не из памяти модели.
 * ------------------------------------------------------------------------ */

/**
 * Документированный минимум кэшируемого префикса в ТОКЕНАХ, по моделям.
 * Префикс короче минимума не кэшируется молча (ошибки не будет, но и записи в
 * кэш тоже — `cache_creation_input_tokens: 0`), то есть breakpoint на нём —
 * впустую потраченная разметка, которая ещё и выглядит в коде как работающая
 * оптимизация.
 *
 * Минимум НЕ монотонен по поколениям: 512 у Opus 5, но 4096 у Opus 4.6 и
 * Haiku 4.5. Поэтому «новее — значит меньше порог» здесь неверно, и угадывать
 * порог по имени модели нельзя.
 */
const CACHE_MIN_TOKENS_BY_MODEL: Readonly<Record<string, number>> = {
  'claude-opus-5': 512,
  'claude-fable-5': 512,
  'claude-mythos-5': 512,
  'claude-opus-4-8': 1024,
  'claude-sonnet-5': 1024,
  'claude-sonnet-4-6': 1024,
  'claude-sonnet-4-5': 1024,
  'claude-sonnet-4-0': 1024,
  'claude-opus-4-1': 1024,
  'claude-opus-4-0': 1024,
  'claude-opus-4-7': 2048,
  'claude-mythos-preview': 2048,
  'claude-opus-4-6': 4096,
  'claude-opus-4-5': 4096,
  'claude-haiku-4-5': 4096,
};

/**
 * Порог для модели, которой нет в таблице — самый строгий из документированных.
 * Fail-closed сознательно: неизвестная модель может иметь порог 4096, и
 * breakpoint ниже него — тихо неработающая оптимизация. Лучше не кэшировать
 * там, где мы не уверены, чем показывать в коде кэш, которого нет.
 */
const UNKNOWN_MODEL_CACHE_MIN_TOKENS = 4096;

function cacheMinTokensFor(model: string): number {
  const exact = CACHE_MIN_TOKENS_BY_MODEL[model];
  if (exact !== undefined) return exact;
  // Датированные снапшоты (`claude-haiku-4-5-20251001`) — тот же порог, что у
  // алиаса. Берём САМОЕ ДЛИННОЕ совпадение по префиксу, иначе `claude-opus-4-1`
  // могло бы совпасть с более коротким чужим ключом.
  let best: number | undefined;
  let bestLength = 0;
  for (const [key, min] of Object.entries(CACHE_MIN_TOKENS_BY_MODEL)) {
    if (model.startsWith(key) && key.length > bestLength) {
      best = min;
      bestLength = key.length;
    }
  }
  return best ?? UNKNOWN_MODEL_CACHE_MIN_TOKENS;
}

/**
 * Оценка размера промпта в токенах БЕЗ обращения к сети (`count_tokens` — это
 * оплачиваемый round-trip, а решение нужно принять до отправки).
 *
 * Промпты здесь преимущественно русские, а кириллица токенизируется плотнее
 * латиницы, поэтому единый коэффициент «4 символа = токен» занижал бы оценку
 * почти вдвое. Отсюда раздельный счёт. Оценка приблизительна by design и
 * используется ТОЛЬКО как порог «точно хватает / не уверены»: ошибка в меньшую
 * сторону стоит упущенной экономии, в большую — неработающего breakpoint'а,
 * и ни то, ни другое не ломает вызов.
 */
function estimateTokens(text: string): number {
  let asciiChars = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) <= 127) asciiChars++;
  }
  const nonAsciiChars = text.length - asciiChars;
  return Math.floor(asciiChars / 4 + nonAsciiChars / 2);
}

interface AnthropicCachedTextBlock {
  type: 'text';
  text: string;
  cache_control: { type: 'ephemeral' };
}

/** `system` в проводной форме: строка (без кэша) или блоки (с breakpoint'ом). */
type AnthropicSystemField = string | AnthropicCachedTextBlock[];

/**
 * TTL по умолчанию (5 минут) не указывается явно. Запись в кэш стоит ~1.25×
 * обычного входа при 5-минутном TTL и ~2× при часовом; окупаемость — со
 * ВТОРОГО чтения в первом случае и только с третьего во втором. Вызовы одного
 * прогона идут подряд, поэтому 5 минут покрывают их, а часовой TTL просто
 * удвоил бы цену записи ради окна, которое здесь никому не нужно.
 */
function buildAnthropicSystemField(
  system: string | undefined,
  model: string
): AnthropicSystemField | undefined {
  if (!system) return undefined;
  if (estimateTokens(system) < cacheMinTokensFor(model)) return system;
  return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
}

/**
 * Robustly normalize and parse JSON from AI responses, even if truncated or wrapped in markdown.
 */
export function normalizeJsonResponse(raw: string): string {
  let trimmed = raw.trim();
  if (!trimmed) return '{}';

  // Strip code fences.  Use a position-based approach that is immune to ** inside JSON bodies.
  if (trimmed.startsWith('`')) {
    // Remove the opening fence line (e.g. ```json or ```)
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline !== -1) {
      trimmed = trimmed.slice(firstNewline + 1).trim();
    } else {
      trimmed = trimmed.replace(/^`+(?:json)?\s*/i, '').trim();
    }
    // Remove a closing fence (``` at start of a line, or at end of string)
    const closingFence = trimmed.lastIndexOf('\n```');
    if (closingFence !== -1) {
      trimmed = trimmed.slice(0, closingFence).trim();
    } else if (trimmed.endsWith('`')) {
      trimmed = trimmed.replace(/`+\s*$/, '').trim();
    }
  }

  // Find the first JSON-like start
  const startIndex = trimmed.search(/[{[]/);
  if (startIndex === -1) return '{}';
  trimmed = trimmed.slice(startIndex);

  // Escape literal newlines/carriage-returns inside JSON string values.
  // The AI sometimes puts real \n in long body fields, which makes JSON.parse fail.
  trimmed = escapeControlCharsInStrings(trimmed);

  // Attempt to fix truncated JSON by closing open brackets/braces
  const balanced = balanceJson(trimmed);

  const sanitized = coerceJsonSyntax(balanced);
  return sanitized;
}

/** Escape literal newlines/CRs that appear inside JSON string values. */
function escapeControlCharsInStrings(json: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        result += char;
      } else if (char === '\\') {
        escaped = true;
        result += char;
      } else if (char === '"') {
        inString = false;
        result += char;
      } else if (char === '\n') {
        result += '\\n';
      } else if (char === '\r') {
        result += '\\r';
      } else {
        result += char;
      }
    } else {
      if (char === '"') inString = true;
      result += char;
    }
  }

  return result;
}

function balanceJson(json: string): string {
  const stack: ('{' | '[')[] = [];
  let inString = false;
  let escaped = false;
  let lastValidIndex = 0;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
        lastValidIndex = i + 1;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{' || char === '[') {
      stack.push(char);
      lastValidIndex = i + 1;
      continue;
    }

    if (char === '}' || char === ']') {
      const last = stack[stack.length - 1];
      if ((char === '}' && last === '{') || (char === ']' && last === '[')) {
        stack.pop();
        lastValidIndex = i + 1;
      }
      continue;
    }

    if (/\s/.test(char) || char === ',' || char === ':' || /[0-9.-]/.test(char) || char === 't' || char === 'f' || char === 'n') {
      // Potentially valid middle characters, though basic check
    }
  }

  let result = json.slice(0, lastValidIndex);

  // If we are still in a string, close it
  if (inString) {
    result += '"';
  }

  // Close remaining open structures in reverse order
  for (let i = stack.length - 1; i >= 0; i--) {
    result += stack[i] === '{' ? '}' : ']';
  }

  return result;
}

function coerceJsonSyntax(candidate: string): string {
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    // Basic cleanup
    let sanitized = candidate
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([,{]\s*)'([^']+?)'\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*?)'/g, ': "$1"')
      .replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":');

    // Fix balanceJson truncation artifact: "key"" → "key": ""
    // Happens when the AI response is cut off mid-value string.
    sanitized = sanitized.replace(/"([^"\\]+)""\s*([},\]])/g, '"$1": ""$2');

    try {
      JSON.parse(sanitized);
      return sanitized;
    } catch {
      return '{}';
    }
  }
}

const RETRYABLE_STATUS_CODES = [429, 529, 503, 502];
/** Policy for caller-owned bounded retries after provider-layer retries have
 *  completed. Permanent 4xx failures (bad request, auth, insufficient
 *  credit, etc.) must not be multiplied by an outer extraction/audit loop. */
export function isRetryableChatCompletionError(error: ChatCompletionError): boolean {
  const status = error.statusCode;
  if (status === undefined) return true;
  if (status >= 400 && status < 500) {
    return status === 408 || status === 409 || status === 429;
  }
  return status >= 500;
}
/** Нормализованные коды ошибок (не числа), означающие транзиентный сбой. */
const RETRYABLE_ERROR_CODES = new Set([
  'overloaded_error',
  'rate_limit_error',
  'econnreset',
  'econnrefused',
  'etimedout',
  'epipe',
]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

const ABORT_ERROR_NAMES = new Set([
  'AbortError',
  'TimeoutError',
  'APIUserAbortError',
  'APIConnectionTimeoutError',
]);

/**
 * Ошибка и её цепочка `cause`. undici прячет настоящий сетевой `code`
 * (`ECONNRESET` и подобные) на уровень глубже, чем брошенный наружу
 * `TypeError: fetch failed`, поэтому смотреть только на верхний объект мало.
 */
function* errorChain(error: unknown, maxDepth = 5): Generator<object> {
  let current = error;
  for (let depth = 0; depth < maxDepth; depth++) {
    if (typeof current !== 'object' || current === null) return;
    yield current;
    current = (current as { cause?: unknown }).cause;
  }
}

function readNumber(source: unknown, key: string): number | undefined {
  if (typeof source !== 'object' || source === null) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * HTTP-статус берётся ТОЛЬКО из структурных полей ошибки: наш
 * `ProviderRequestError.statusCode`, `status`/`statusCode` SDK-ошибок,
 * `response.status`. Разбор трёхзначного числа из текста сообщения убран
 * сознательно — сообщение провайдера это свободный текст, и «(429)» внутри
 * чужой прозы не должно ни попадать в телеметрию как статус, ни запускать
 * три ретрая с backoff по ошибке, которая ретраю не подлежит.
 */
function extractStatusCode(error: unknown): number | undefined {
  for (const node of errorChain(error)) {
    const status =
      readNumber(node, 'status') ??
      readNumber(node, 'statusCode') ??
      readNumber((node as { response?: unknown }).response, 'status');
    if (status !== undefined) return status;
  }
  return undefined;
}

function extractErrorCode(error: unknown): string | undefined {
  for (const node of errorChain(error)) {
    if (node instanceof ProviderRequestError) {
      if (node.errorCode) return node.errorCode;
      continue;
    }
    const code = (node as { code?: unknown }).code;
    if (typeof code === 'string' && code) return code;
  }
  // Имя класса — последний и наименее информативный источник. Собственную
  // обёртку сюда не пускаем: «ProviderRequestError» не код ошибки провайдера.
  if (
    error instanceof Error &&
    !(error instanceof ProviderRequestError) &&
    error.name &&
    error.name !== 'Error'
  ) {
    return error.name;
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && ABORT_ERROR_NAMES.has(name);
}

/**
 * Транзиентность определяется нормализованным сигналом — структурным статусом
 * или кодом ошибки. Текст сообщения остаётся последним рубежом только для
 * НЕчисловых маркеров: число, найденное в свободном тексте, статусом не
 * является.
 */
function isRetryableError(error: unknown): boolean {
  if (isAbortError(error)) return false;

  const status = extractStatusCode(error);
  if (status !== undefined && RETRYABLE_STATUS_CODES.includes(status)) return true;

  const code = extractErrorCode(error)?.toLowerCase();
  if (code && RETRYABLE_ERROR_CODES.has(code)) return true;

  if (error instanceof Error) {
    const msg = error.message;
    return (
      msg.includes('overloaded') ||
      msg.includes('rate_limit') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ETIMEDOUT')
    );
  }
  return false;
}

/**
 * Backoff, прерываемый внешней отменой: без этого abort во время паузы всё
 * равно ждал бы полный интервал, прежде чем вызов заметит отмену.
 */
async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

interface AttemptGate {
  signal: AbortSignal;
  /** true, если попытку прервал наш таймаут, а не внешний signal вызывающего. */
  readonly timedOut: boolean;
  /** Отмена по решению самой операции (отказ потребителя, переполнение буфера). */
  abort(): void;
  cleanup(): void;
}

/**
 * Сигнал одной попытки: внешняя отмена вызывающего ИЛИ наш таймаут.
 * `AbortSignal.any` не используется намеренно — нужно знать, КТО прервал, чтобы
 * отличить `ATTEMPT_TIMEOUT` от `ABORTED_BY_CALLER` в телеметрии.
 */
function createAttemptGate(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number | undefined
): AttemptGate {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && !controller.signal.aborted) {
    if (timeoutMs <= 0) {
      // Неположительный бюджет — это «времени нет», а не «времени сколько
      // угодно»: попытка прерывается сразу, но всё равно попадает в attempts[].
      timedOut = true;
      controller.abort();
    } else {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      // Не держим event loop живым ради висящего таймера попытки.
      (timer as unknown as { unref?: () => void }).unref?.();
    }
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    abort() {
      controller.abort();
    },
    cleanup() {
      if (timer) clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

async function postAnthropicMessages(
  apiKey: string,
  model: string,
  system: AnthropicSystemField | undefined,
  messages: ReturnType<typeof buildAnthropicPayload>['messages'],
  maxTokens: number,
  temperature: number | undefined,
  signal: AbortSignal | undefined
): Promise<Response> {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      system,
      messages,
      max_tokens: maxTokens,
      ...(temperature !== undefined && { temperature }),
    }),
    ...(signal && { signal }),
  });
}

interface ProviderCallResult {
  text: string;
  /** `null` when the provider's response didn't carry a usage block —
   *  don't fabricate zeros, a cost meter reading 0 looks like a free call. */
  usage: CompletionUsage | null;
}

async function callAnthropic(
  options: ChatCompletionOptions,
  model: string,
  defaults: ResolvedDefaults,
  signal: AbortSignal | undefined
): Promise<ProviderCallResult> {
  const apiKey = defaults.anthropicApiKey;
  if (!apiKey) {
    throw new ProviderRequestError('ANTHROPIC_API_KEY is not set', {
      errorCode: 'MISSING_API_KEY',
    });
  }

  const { system, messages } = buildAnthropicPayload(options);
  const systemField = buildAnthropicSystemField(system, model);
  const maxTokens = defaults.anthropicMaxTokens;
  const temperature = defaults.temperature;

  let response = await postAnthropicMessages(apiKey, model, systemField, messages, maxTokens, temperature, signal);

  // Reasoning/thinking-tier models (e.g. claude-sonnet-5, claude-opus-5) reject
  // an explicit temperature outright — extended thinking fixes it internally.
  // Retry once without the field instead of hardcoding a model-name allowlist,
  // so this keeps working as new model tiers ship.
  if (!response.ok && response.status === 400) {
    const errorBody = await response.clone().text();
    if (/temperature.{0,40}deprecated/i.test(errorBody)) {
      response = await postAnthropicMessages(apiKey, model, systemField, messages, maxTokens, undefined, signal);
    }
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw new ProviderRequestError(
      `Anthropic API error (${response.status}): ${errorBody || 'Unknown error'}`,
      { statusCode: response.status }
    );
  }

  const data = (await response.json()) as {
    content?: { type: string; text?: string }[];
    error?: { message?: string; type?: string };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };

  if (data.error?.message) {
    throw new ProviderRequestError(`Anthropic API error: ${data.error.message}`, {
      errorCode: data.error.type,
    });
  }

  const content = Array.isArray(data.content)
    ? data.content.map((part) => part.text || '').join('')
    : '';

  // Кэш-счётчики добавляются ТОЛЬКО когда провайдер их прислал: ключ со
  // значением undefined виден в `toEqual` и сделал бы красными уже
  // существующие моки usage в других файлах, ничего не сообщив взамен.
  const usage =
    typeof data.usage?.input_tokens === 'number' && typeof data.usage?.output_tokens === 'number'
      ? {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
          ...(typeof data.usage.cache_creation_input_tokens === 'number' && {
            cacheCreationInputTokens: data.usage.cache_creation_input_tokens,
          }),
          ...(typeof data.usage.cache_read_input_tokens === 'number' && {
            cacheReadInputTokens: data.usage.cache_read_input_tokens,
          }),
        }
      : null;

  return { text: content.trim(), usage };
}

/**
 * OpenAI отклоняет `response_format: json_object`, если ни в одном сообщении не
 * упомянут JSON — это требование их API, а не наша перестраховка. Anthropic-путь
 * такую инструкцию добавляет в `system` (см. `buildAnthropicPayload`), а
 * OpenAI-путь до этого отправлял `options.messages` как есть: любой вызывающий,
 * не написавший слово JSON в промпте сам, получал 400 на живом вызове, а на
 * моках проходил. Инструкция добавляется ТОЛЬКО когда её ещё нет, чтобы не
 * дублировать её у тех, кто уже просит JSON своими словами.
 */
function withOpenAiJsonInstruction(options: ChatCompletionOptions): ChatMessage[] {
  if (options.responseFormat !== 'json_object') return options.messages;

  const alreadyAsksForJson = options.messages.some((m) => /json/i.test(m.content));
  if (alreadyAsksForJson) return options.messages;

  return [
    ...options.messages,
    {
      role: 'system',
      content:
        'Respond with valid JSON only. Use double quotes for all keys and string values. Do not wrap in markdown or add commentary.',
    },
  ];
}

/**
 * Кэширование промпта здесь сознательно НЕ реализовано: у OpenAI другая
 * семантика — кэш префикса включается на их стороне автоматически, без
 * какого-либо аналога `cache_control` в запросе, со своим порогом и своими
 * условиями попадания. Добавить сюда «то же самое» нечего: любая разметка,
 * придуманная по аналогии с Anthropic, была бы неизвестным полем в их API.
 * Соответственно и кэш-счётчиков в `CompletionUsage` этот путь не заполняет —
 * `prompt_tokens` у OpenAI остаётся полным входом, а не остатком.
 */
async function callOpenAI(
  options: ChatCompletionOptions,
  model: string,
  defaults: ResolvedDefaults,
  signal: AbortSignal | undefined
): Promise<ProviderCallResult> {
  const requestOptions = {
    ...(signal && { signal }),
    // When the raw-attempt circuit breaker is active, chat-provider owns
    // retries. Hidden SDK retries would bypass the breaker. Unbudgeted
    // production paths omit this and preserve the shared client default.
    ...(options.beforeProviderAttempt && { maxRetries: 0 }),
  };
  const response = await openai.chat.completions.create(
    {
      model,
      messages: withOpenAiJsonInstruction(options),
      temperature: defaults.temperature,
      ...(options.maxTokens && { max_tokens: options.maxTokens }),
      ...(options.responseFormat && {
        response_format: { type: options.responseFormat },
      }),
    },
    Object.keys(requestOptions).length > 0 ? requestOptions : undefined
  );

  const text = response.choices[0]?.message?.content?.trim() || '';
  const usage =
    typeof response.usage?.prompt_tokens === 'number' &&
    typeof response.usage?.completion_tokens === 'number'
      ? { inputTokens: response.usage.prompt_tokens, outputTokens: response.usage.completion_tokens }
      : null;

  return { text, usage };
}

type AttemptResult =
  | { ok: true; text: string; rawText: string; attempt: CompletionAttempt }
  | { ok: false; error: unknown; attempt: CompletionAttempt };

async function runCompletionAttempt(
  provider: Provider,
  model: string,
  options: ChatCompletionOptions,
  defaults: ResolvedDefaults,
  timeoutMs: number | undefined,
  timeoutCode: string
): Promise<AttemptResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const gate = createAttemptGate(options.signal, timeoutMs);

  try {
    const providerResult =
      provider === 'anthropic'
        ? await callAnthropic(options, model, defaults, gate.signal)
        : await callOpenAI(options, model, defaults, gate.signal);
    const raw = providerResult.text;

    const text =
      options.responseFormat === 'json_object' ? normalizeJsonResponse(raw) : raw;

    return {
      ok: true,
      text,
      rawText: raw,
      attempt: {
        provider,
        model,
        startedAt,
        latencyMs: Date.now() - startedMs,
        outcome: 'SUCCESS',
        ...(providerResult.usage && { usage: providerResult.usage }),
      },
    };
  } catch (error) {
    const aborted = isAbortError(error) || gate.signal.aborted;
    const errorCode = aborted
      ? gate.timedOut
        ? timeoutCode
        : 'ABORTED_BY_CALLER'
      : extractErrorCode(error);

    return {
      ok: false,
      error,
      attempt: {
        provider,
        model,
        startedAt,
        latencyMs: Date.now() - startedMs,
        outcome: aborted ? 'ABORTED' : 'ERROR',
        ...(extractStatusCode(error) !== undefined && {
          statusCode: extractStatusCode(error),
        }),
        ...(errorCode && { errorCode }),
      },
    };
  } finally {
    gate.cleanup();
  }
}

/**
 * Основной вход. Возвращает не только текст, но и то, КТО и ЧЕМ его отдал —
 * без этого downstream не может честно посчитать `ModelRelationship` (A2).
 *
 * При полном отказе бросает `ChatCompletionError` с полным `attempts[]`.
 */
export async function createChatCompletionDetailed(
  options: ChatCompletionOptions
): Promise<ChatCompletionResult> {
  const callStartedMs = Date.now();
  const attempts: CompletionAttempt[] = [];

  const primaryProvider = options.provider ?? getProvider();
  const primaryModel = resolvePrimaryModel(primaryProvider, options);
  const plan = planFallback(options);
  // Один снимок env на весь вызов: см. ResolvedDefaults.
  const defaults = resolveDefaults(options);

  const remainingMs = (): number =>
    options.totalDeadlineMs === undefined
      ? Number.POSITIVE_INFINITY
      : options.totalDeadlineMs - (Date.now() - callStartedMs);

  // Дедлайн клампит таймаут попытки: попытка не должна пережить весь вызов.
  const attemptTimeout = (): { ms: number | undefined; code: string } => {
    const remaining = remainingMs();
    const request = options.requestTimeoutMs;
    if (!Number.isFinite(remaining)) {
      return { ms: request, code: 'ATTEMPT_TIMEOUT' };
    }
    if (request !== undefined && request <= remaining) {
      return { ms: request, code: 'ATTEMPT_TIMEOUT' };
    }
    // Не подтягиваем до 1мс: если бюджет уже исчерпан, попытка обязана
    // прерваться сразу и попасть в attempts[] как TOTAL_DEADLINE_EXCEEDED,
    // а не изображать гонку в одну миллисекунду.
    return { ms: remaining, code: 'TOTAL_DEADLINE_EXCEEDED' };
  };

  // Диагностика первичного провайдера — то, что сегодня улетает наружу через
  // `throw lastError`. Health-эндпоинт и consistency-gate читают именно
  // `error.message`/`String(err)`, поэтому она обязана дожить до вызывающего.
  let primaryError: unknown;
  let fallbackError: unknown;
  let callerAborted = false;
  // Факт исчерпания дедлайна фиксируется по ЗАПИСАННОМУ исходу попытки, а не
  // перемером часов: таймер libuv вправе сработать на доли миллисекунды раньше
  // срока, и повторный `remainingMs() > 0` мог показать остаток бюджета уже
  // после того, как дедлайн формально наступил — и запустить резерв.
  let deadlineExceeded = false;

  const runOne = async (
    provider: Provider,
    model: string,
    isPrimary: boolean
  ): Promise<AttemptResult> => {
    options.beforeProviderAttempt?.({ provider, model });
    const { ms, code } = attemptTimeout();
    const result = await runCompletionAttempt(
      provider,
      model,
      options,
      defaults,
      ms,
      code
    );
    attempts.push(result.attempt);
    if (!result.ok) {
      if (isPrimary) primaryError = result.error;
      else fallbackError = result.error;
      if (result.attempt.errorCode === 'ABORTED_BY_CALLER') callerAborted = true;
      if (result.attempt.errorCode === 'TOTAL_DEADLINE_EXCEEDED') deadlineExceeded = true;
    }
    return result;
  };

  // --- Первичный провайдер, с retry на транзиентных ошибках ---
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await runOne(primaryProvider, primaryModel, true);
    if (result.ok) {
      return {
        text: result.text,
        rawText: result.rawText,
        servedByProvider: primaryProvider,
        servedByModel: primaryModel,
        fallbackUsed: false,
        attempts,
        requestMessages: options.messages,
      };
    }

    if (callerAborted) break;
    if (attempt >= MAX_RETRIES || !isRetryableError(result.error)) break;

    const delay = BASE_DELAY_MS * Math.pow(2, attempt);
    // Retry не начинается, если он вместе с backoff не укладывается в дедлайн.
    if (remainingMs() <= delay) {
      console.warn(
        `[chat-provider] ${primaryProvider} retry skipped: totalDeadlineMs would be exceeded`
      );
      break;
    }
    console.warn(
      `[chat-provider] ${primaryProvider} attempt ${attempt + 1} failed (retryable), waiting ${delay}ms...`
    );
    await sleep(delay, options.signal);
  }

  // --- Резерв ---
  const fallbackTarget = plan.target;

  if (plan.requested !== plan.effective) {
    console.warn(
      `[chat-provider] fallback downgraded ${plan.requested} → ${plan.effective}: model "${options.model}" is pinned and no providerModels entry gives the fallback target a valid model ID`
    );
  }

  if (
    fallbackTarget &&
    !callerAborted &&
    !deadlineExceeded &&
    hasApiKey(fallbackTarget.provider, defaults) &&
    remainingMs() > 0
  ) {
    console.warn(
      `[chat-provider] ${primaryProvider} failed after retries, falling back to ${fallbackTarget.provider}/${fallbackTarget.model}`
    );
    const result = await runOne(fallbackTarget.provider, fallbackTarget.model, false);
    if (result.ok) {
      return {
        text: result.text,
        rawText: result.rawText,
        servedByProvider: fallbackTarget.provider,
        servedByModel: fallbackTarget.model,
        fallbackUsed: true,
        attempts,
        requestMessages: options.messages,
      };
    }
    console.error(
      `[chat-provider] Fallback ${fallbackTarget.provider} also failed:`,
      result.error
    );
  }

  // Наружу идёт СЫРОЕ сообщение первичного провайдера — ровно то, что летело
  // до provider-слоя через `throw lastError`. Ошибка резерва не приписывается к
  // тексту: она уже ушла в console.error выше, а её статус и код лежат в
  // attempts[]. Иначе health-эндпоинт и consistency-gate печатали бы
  // пользователю сводку попыток вместо причины отказа.
  const rootError = primaryError ?? fallbackError;

  throw new ChatCompletionError(rawMessageOf(rootError), attempts, {
    cause: rootError,
    errorCode: extractErrorCode(rootError),
    statusCode: extractStatusCode(rootError),
    requestMessages: options.messages,
  });
}

/**
 * Тонкая обёртка — существующие call sites не трогаются. Как и раньше, бросает
 * исключение при полном отказе; теперь это `ChatCompletionError` с `attempts[]`.
 */
export async function createChatCompletion(
  options: ChatCompletionOptions
): Promise<string> {
  return (await createChatCompletionDetailed(options)).text;
}

async function* streamProviderTokens(
  provider: Provider,
  model: string,
  options: ChatCompletionOptions,
  defaults: ResolvedDefaults,
  signal: AbortSignal | undefined
): AsyncGenerator<string> {
  const temperature = defaults.temperature;

  if (provider === 'anthropic') {
    const apiKey = defaults.anthropicApiKey;
    if (!apiKey) {
      throw new ProviderRequestError('ANTHROPIC_API_KEY is not set', {
        errorCode: 'MISSING_API_KEY',
      });
    }

    const { system, messages } = buildAnthropicPayload(options);
    const systemField = buildAnthropicSystemField(system, model);
    const maxTokens = defaults.anthropicMaxTokens;
    const buildBody = (withTemperature: boolean) =>
      JSON.stringify({
        model,
        system: systemField,
        messages,
        max_tokens: maxTokens,
        stream: true,
        ...(withTemperature && { temperature }),
      });
    const post = (withTemperature: boolean) =>
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: buildBody(withTemperature),
        ...(signal && { signal }),
      });

    let response = await post(true);

    // See callAnthropic() for why: reasoning/thinking-tier models reject an
    // explicit temperature outright, retry once without it.
    if (!response.ok && response.status === 400) {
      const errorBody = await response.clone().text();
      if (/temperature.{0,40}deprecated/i.test(errorBody)) {
        response = await post(false);
      }
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new ProviderRequestError(
        `Anthropic API error (${response.status}): ${errorBody || 'Unknown error'}`,
        { statusCode: response.status }
      );
    }

    const reader = response.body?.getReader();
    if (!reader) throw new ProviderRequestError('Failed to get response body reader');

    const decoder = new TextDecoder();
    let buffer = '';

    // finally: ранний выход потребителя обязан закрыть HTTP-соединение, иначе
    // отменённый стрим продолжает качать токены (и деньги).
    try {
      let done = false;
      while (!done) {
        const chunk = await reader.read();
        if (chunk.done) break;

        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const content = line.slice(6).trim();
          if (content === '[DONE]') {
            done = true;
            break;
          }
          try {
            const data = JSON.parse(content);
            if (data.type === 'content_block_delta' && data.delta?.text) {
              yield data.delta.text;
            }
          } catch {
            // Ignore parse errors for non-json lines
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return;
  }

  // OpenAI streaming
  const stream = await openai.chat.completions.create(
    {
      model,
      messages: options.messages,
      temperature,
      ...(options.maxTokens && { max_tokens: options.maxTokens }),
      ...(options.responseFormat && {
        response_format: { type: options.responseFormat },
      }),
      stream: true,
    },
    signal ? { signal } : undefined
  );

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || '';
    if (content) {
      yield content;
    }
  }
}

export async function* streamChatCompletionTokens(
  options: ChatCompletionOptions,
  _chunkSize = 120
): AsyncGenerator<string> {
  const provider = options.provider ?? getProvider();
  const model = resolvePrimaryModel(provider, options);
  const defaults = resolveDefaults(options);
  yield* streamProviderTokens(provider, model, options, defaults, options.signal);
}

/**
 * Верхняя граница НЕПРОЧИТАННЫХ токенов в буфере операции. Запрос к провайдеру
 * идёт на полной скорости независимо от потребителя (см.
 * `createChatCompletionStreamDetailed`), поэтому нужен потолок: он на порядки
 * выше любого реального ответа — max_tokens ограничивает провайдера сам — и
 * существует ради случая «потребитель не читает вовсе, а провайдер льёт
 * бесконечно». Иначе гарантия разрешения completion покупалась бы
 * неограниченной памятью.
 */
const STREAM_BUFFER_LIMIT_CHARS = 4_000_000;

export interface ChatCompletionStreamOperation {
  /**
   * Токены по мере поступления. Итерировать НЕобязательно: запрос к провайдеру
   * идёт независимо от потребителя, непрочитанные токены копятся в буфере
   * операции, и потребитель, подключившийся позже, получит их с начала.
   *
   * Ранний `break` (или исключение в теле `for await`) отменяет запрос к
   * провайдеру: незакрытый стрим продолжал бы качать токены и деньги.
   *
   * Потребитель ОДИН. Как и у async-генератора, все `for await` делят один
   * итератор и один буфер: второй потребитель не получит копию потока, он
   * разберёт с первым одну и ту же очередь. Полный текст прогона всегда есть в
   * `completion.text` — за ним и надо идти, если нужен «ещё один читатель».
   */
  tokens: AsyncIterable<string>;
  /**
   * Метаданные прогона. Разрешается полным текстом при нормальном конце и
   * префиксом при отказе потребителя; отклоняется `ChatCompletionError` при
   * ошибке провайдера, таймауте и явной отмене.
   *
   * ГАРАНТИЯ: операция создана ⟹ `completion` рано или поздно settles, читал
   * кто-нибудь `tokens` или нет. Единственная граница — время самого запроса к
   * провайдеру: без `requestTimeoutMs`/`totalDeadlineMs` она равна тому, сколько
   * провайдер держит соединение.
   */
  completion: Promise<ChatCompletionResult>;
  /**
   * Отменить операцию, не подключаясь к `tokens`. `completion` отклоняется
   * `ChatCompletionError` с исходом `ABORTED` — так же, как при отмене через
   * внешний `signal`. Повторный вызов и вызов после завершения ничего не делают.
   */
  abort(reason?: string): void;
}

/**
 * Стриминг без фоллбэка: подмена провайдера на середине уже отданного клиенту
 * текста склеила бы два разных ответа, поэтому `fallbackUsed` здесь всегда
 * `false`, а неудача — единственная попытка в `attempts[]`.
 *
 * Операция ЭАГЕРНАЯ: запрос уходит провайдеру в момент создания, а внутренний
 * насос перекладывает токены в буфер сам. Ленивый вариант (запрос стартовал с
 * первой итерации, `completion` разрешалась из `finally` генератора) был
 * неисправим по устройству: `.return()` у НЕ запущенного async-генератора не
 * выполняет ни тело, ни `finally`, а брошенный на `yield` генератор без
 * `.return()` не финализируется вовсе — то есть «создал операцию и не стал
 * читать токены» означало вечно висящую `completion`, удерживающую
 * AbortController и слушатель signal. Эагерность убирает само условие: у
 * разрешения `completion` больше нет предусловия со стороны потребителя.
 */
export function createChatCompletionStreamDetailed(
  options: ChatCompletionOptions
): ChatCompletionStreamOperation {
  const provider = options.provider ?? getProvider();
  const model = resolvePrimaryModel(provider, options);
  const defaults = resolveDefaults(options);
  const attempts: CompletionAttempt[] = [];

  let resolveCompletion!: (result: ChatCompletionResult) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<ChatCompletionResult>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  // Потребитель вправе не ждать `completion`; без этого её отклонение стало бы
  // unhandled rejection и уронило бы процесс.
  completion.catch(() => {});

  // Стрим — одна попытка, поэтому оба бюджета сводятся к одному таймеру. Код
  // ошибки должен называть тот бюджет, который реально сработал.
  const requestBudget = options.requestTimeoutMs ?? Number.POSITIVE_INFINITY;
  const deadlineBudget = options.totalDeadlineMs ?? Number.POSITIVE_INFINITY;
  const budget = Math.min(requestBudget, deadlineBudget);
  const timeoutMs = Number.isFinite(budget) ? budget : undefined;
  const timeoutCode =
    requestBudget <= deadlineBudget ? 'ATTEMPT_TIMEOUT' : 'TOTAL_DEADLINE_EXCEEDED';

  const gate = createAttemptGate(options.signal, timeoutMs);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();

  // --- буфер между насосом и (необязательным) потребителем ---
  const buffered: string[] = [];
  let bufferedChars = 0;
  let queueClosed = false;
  let queueFailure: unknown;
  let waiters: (() => void)[] = [];

  const wakeWaiters = () => {
    const pending = waiters;
    waiters = [];
    for (const resume of pending) resume();
  };

  // --- состояние операции ---
  let text = '';
  let settled = false;
  let cancelledByConsumer = false;
  let overflowed = false;
  let abortRequested = false;
  let abortReason: string | undefined;

  /** Единственная точка разрешения `completion`. `undefined` — нормальный конец. */
  const settle = (error: unknown) => {
    if (settled) return;
    settled = true;

    // Отказ потребителя — не сбой прогона: префикс уже получен и оплачен,
    // поэтому исход разрешающий, но с честной пометкой в телеметрии. Явный
    // `abort()` важнее: если его позвали, `completion` обязана отклониться,
    // даже когда потребитель следом вышел из `for await`.
    const consumerGaveUp =
      error !== undefined && cancelledByConsumer && !overflowed && !abortRequested;

    if (error === undefined || consumerGaveUp) {
      attempts.push({
        provider,
        model,
        startedAt,
        latencyMs: Date.now() - startedMs,
        outcome: error === undefined ? 'SUCCESS' : 'ABORTED',
        ...(consumerGaveUp && { errorCode: 'CONSUMER_CANCELLED' }),
      });
      queueClosed = true;
      wakeWaiters();
      resolveCompletion({
        text,
        servedByProvider: provider,
        servedByModel: model,
        fallbackUsed: false,
        attempts,
        requestMessages: options.messages,
      });
      return;
    }

    const aborted = !overflowed && (isAbortError(error) || gate.signal.aborted);
    const errorCode = aborted
      ? gate.timedOut
        ? timeoutCode
        : 'ABORTED_BY_CALLER'
      : extractErrorCode(error);
    const statusCode = extractStatusCode(error);
    attempts.push({
      provider,
      model,
      startedAt,
      latencyMs: Date.now() - startedMs,
      outcome: aborted ? 'ABORTED' : 'ERROR',
      ...(statusCode !== undefined && { statusCode }),
      ...(errorCode && { errorCode }),
    });

    const failure = new ChatCompletionError(
      abortReason !== undefined && errorCode === 'ABORTED_BY_CALLER'
        ? abortReason
        : rawMessageOf(error),
      attempts,
      { cause: error, errorCode, statusCode, requestMessages: options.messages }
    );
    queueFailure = failure;
    queueClosed = true;
    wakeWaiters();
    rejectCompletion(failure);
  };

  // Насос стартует СРАЗУ и разрешает `completion` из единственной точки в
  // `finally` — так гарантия «создана ⟹ settles» не зависит от полноты разбора
  // веток внутри.
  const pump = (async () => {
    let failure: unknown;
    try {
      for await (const token of streamProviderTokens(
        provider,
        model,
        options,
        defaults,
        gate.signal
      )) {
        text += token;
        if (queueClosed) continue;
        buffered.push(token);
        bufferedChars += token.length;
        wakeWaiters();
        if (bufferedChars > STREAM_BUFFER_LIMIT_CHARS) {
          overflowed = true;
          gate.abort();
          throw new ProviderRequestError(
            `Stream buffer limit of ${STREAM_BUFFER_LIMIT_CHARS} characters exceeded: tokens arrive faster than the consumer reads them`,
            { errorCode: 'STREAM_BUFFER_OVERFLOW' }
          );
        }
      }
    } catch (error) {
      failure = error ?? new Error('Stream failed without an error value');
    } finally {
      gate.cleanup();
      settle(failure);
    }
  })();

  const iterator: AsyncIterator<string> = {
    async next(): Promise<IteratorResult<string>> {
      for (;;) {
        const token = buffered.shift();
        if (token !== undefined) {
          bufferedChars -= token.length;
          return { value: token, done: false };
        }
        if (queueFailure !== undefined) {
          // Ошибку отдаём потребителю ровно один раз; дальше поток закрыт.
          const error = queueFailure;
          queueFailure = undefined;
          throw error;
        }
        if (queueClosed) return { value: undefined, done: true };
        await new Promise<void>((resume) => waiters.push(resume));
      }
    },
    async return(): Promise<IteratorResult<string>> {
      if (!settled) {
        cancelledByConsumer = true;
        gate.abort();
      }
      // Буфер закрывается сразу: токены, успевшие прийти между отменой и
      // фактическим закрытием соединения, попадут в `text` (мы их получили),
      // но не будут ждать потребителя, который уже ушёл.
      queueClosed = true;
      buffered.length = 0;
      bufferedChars = 0;
      // Дожидаемся насоса: после выхода из `for await` состояние операции должно
      // быть окончательным — `completion` разрешена, соединение закрыто.
      await pump;
      return { value: undefined, done: true };
    },
  };

  return {
    tokens: { [Symbol.asyncIterator]: () => iterator },
    completion,
    abort(reason?: string) {
      if (settled) return;
      abortRequested = true;
      // Причину фиксирует ПЕРВАЯ отмена: `abort('почему')` с последующим
      // безаргументным `abort()` не должен стирать уже названную причину.
      if (abortReason === undefined) abortReason = reason;
      gate.abort();
    },
  };
}
