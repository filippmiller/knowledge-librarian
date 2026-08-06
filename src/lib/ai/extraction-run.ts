import { createHash } from 'node:crypto';
import {
  ChatCompletionError,
  getProvider,
  resolveRunConfig,
  type ChatCompletionResult,
  type CompletionAttempt,
  type CompletionRunConfig,
  type FallbackPolicy,
  type Provider,
} from '@/lib/ai/chat-provider';

/**
 * Версия схемы, в которой экстрактор отдаёт единицу знания
 * (`ExtractedRuleStream`). Меняется вместе с формой JSON, которую требует
 * промпт: правила, извлечённые разными схемами, нельзя сравнивать как
 * регрессию — изменится состав полей, а не качество извлечения.
 */
export const EXTRACTION_SCHEMA_VERSION = '2026-08-06-extracted-rule-stream-v1';

/**
 * Версия промпта экстрактора. В артефакт пишется по каждому вызову: вердикты,
 * полученные на разных версиях промпта, тоже несравнимы между собой.
 */
export const EXTRACTION_PROMPT_VERSION = '2026-08-06-extraction-ru-max-rules-v1';

/**
 * Фоллбэк для извлечения запрещён по умолчанию, и это не осторожность ради
 * осторожности:
 *  - первичный вызов идёт стримом, а стриминг в A1 фоллбэка не имеет вовсе
 *    (подмена провайдера на середине уже отданного текста склеила бы два
 *    ответа), поэтому «резерв только на retry» — это ровно та половинчатость,
 *    которую этот PR устраняет;
 *  - модель здесь закреплена, а `planFallback()` (A1) и так не отдаёт
 *    закреплённую модель другому провайдеру без `providerModels` — запрос
 *    `CROSS_PROVIDER` был бы понижен до `NONE` с предупреждением на каждом
 *    retry.
 * Прогон, которому фоллбэк действительно нужен, задаёт политику явно через
 * override — и получает `MIXED` в артефакте, если резерв сработал.
 */
export const DEFAULT_EXTRACTION_FALLBACK_POLICY: FallbackPolicy = 'NONE';

/**
 * Конфигурация ОДНОГО прогона извлечения. Расширяет `CompletionRunConfig` из
 * A1, а не дублирует его поля: provider/model/promptVersion/fallbackPolicy —
 * общий контракт provider-слоя, `extractionSchemaVersion` — единственное, что
 * специфично для извлечения.
 */
export interface ExtractionRunConfig extends CompletionRunConfig {
  extractionSchemaVersion: string;
  /**
   * Модели резервного провайдера. Без них `planFallback()` понижает ЛЮБОЙ
   * закреплённый прогон до `NONE` — а у прогона извлечения модель закреплена
   * всегда. То есть без этого поля `fallbackPolicy: 'CROSS_PROVIDER'` можно
   * задать, но сработать он не может никогда: настройка выглядела бы рабочей и
   * молча ничего не делала.
   */
  providerModels?: { anthropic?: string; openai?: string };
}

/**
 * Единственная точка, где выбирается модель извлечения. Первичный вызов и
 * JSON-retry берут результат ОТСЮДА, а не читают env каждый по-своему: до этого
 * primary закреплял `EXTRACTION_MODEL`, а retry уходил на дефолт провайдера, и
 * один документ мог быть наполовину извлечён одной моделью, наполовину другой.
 *
 * Модель резолвится до конкретной строки (а не остаётся `undefined` = «дефолт
 * провайдера»): артефакт должен хранить то, что фактически поехало в API.
 */
export function resolveExtractionRunConfig(
  overrides: Partial<ExtractionRunConfig> = {}
): ExtractionRunConfig {
  // `||`, а не `??`: пустая строка в env — это «не задано», как и везде в
  // chat-provider.
  const model = overrides.model || process.env.EXTRACTION_MODEL || undefined;

  const resolved = resolveRunConfig({
    // resolveRunConfig() читает только маршрутизирующие поля; messages ему не
    // нужны, но тип ChatCompletionOptions требует их наличия.
    messages: [],
    ...(overrides.provider ? { provider: overrides.provider } : {}),
    ...(model ? { model } : {}),
    promptVersion: overrides.promptVersion ?? EXTRACTION_PROMPT_VERSION,
    fallbackPolicy: overrides.fallbackPolicy ?? DEFAULT_EXTRACTION_FALLBACK_POLICY,
    ...(overrides.requestTimeoutMs !== undefined && {
      requestTimeoutMs: overrides.requestTimeoutMs,
    }),
    ...(overrides.totalDeadlineMs !== undefined && {
      totalDeadlineMs: overrides.totalDeadlineMs,
    }),
  });

  return {
    ...resolved,
    extractionSchemaVersion:
      overrides.extractionSchemaVersion ?? EXTRACTION_SCHEMA_VERSION,
  };
}

export class GraderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraderConfigError';
  }
}

export function resolveGraderProvider(): Provider {
  const raw = (process.env.GRADER_PROVIDER || '').toLowerCase();
  // getProvider() из chat-provider — то же правило выбора провайдера, что и у
  // самих вызовов; локальная копия этой логики разъезжалась бы с ней молча.
  if (raw === '') return getProvider();
  if (raw === 'anthropic' || raw === 'openai') return raw;
  throw new GraderConfigError(
    `GRADER_PROVIDER принимает anthropic|openai, получено: ${process.env.GRADER_PROVIDER}`
  );
}

/**
 * Конфигурация судьи, разрезолвленная теми же правилами, что и конфигурация
 * экстрактора: модель — всегда конкретная строка, а не «дефолт провайдера».
 * Именно из-за сравнения НЕразрезолвленных настроек и возникал ложный вывод о
 * независимости.
 *
 * Фоллбэк запрещён намеренно: судья, молча переехавший к другому вендору на
 * середине прогона, обнулил бы смысл `ModelRelationship`, посчитанного для
 * этого прогона (и был бы честно помечен `MIXED`, что тоже не оценка).
 */
export function resolveGraderRunConfig(promptVersion: string): CompletionRunConfig {
  const model = process.env.GRADER_MODEL || undefined;
  return resolveRunConfig({
    messages: [],
    provider: resolveGraderProvider(),
    ...(model ? { model } : {}),
    promptVersion,
    fallbackPolicy: 'NONE',
  });
}

/**
 * Превращает конфигурацию прогона в опции вызова. Существует именно чтобы у
 * primary и retry не было ДВУХ мест, где эти поля собираются вручную: разойтись
 * они могут только через эту функцию, а она одна.
 */
export function toCompletionOptions(
  config: CompletionRunConfig & { providerModels?: { anthropic?: string; openai?: string } }
): {
  provider: Provider;
  model: string;
  promptVersion: string;
  fallbackPolicy: FallbackPolicy;
  providerModels?: { anthropic?: string; openai?: string };
  requestTimeoutMs?: number;
  totalDeadlineMs?: number;
} {
  return {
    provider: config.provider,
    model: config.model,
    promptVersion: config.promptVersion,
    fallbackPolicy: config.fallbackPolicy,
    ...(config.providerModels && { providerModels: config.providerModels }),
    ...(config.requestTimeoutMs !== undefined && {
      requestTimeoutMs: config.requestTimeoutMs,
    }),
    ...(config.totalDeadlineMs !== undefined && {
      totalDeadlineMs: config.totalDeadlineMs,
    }),
  };
}

// ────────────────────────────── журнал вызовов ──────────────────────────────

export type LlmCallRole = 'EXTRACTION_PRIMARY' | 'EXTRACTION_RETRY' | 'GRADER';

/**
 * Один вызов модели в рамках прогона — батч, retry или вызов судьи. Хранит
 * ЗАПРОШЕННОЕ и ФАКТИЧЕСКОЕ раздельно: расхождение между ними и есть то, ради
 * чего журнал существует.
 */
export interface LlmCallRecord {
  role: LlmCallRole;
  /** 1-based номер батча для extraction-вызовов; null для вызовов судьи. */
  batchIndex: number | null;
  /** Что оценивалось/извлекалось: метка батча, id кейса, ruleCode. */
  label: string;
  requestedProvider: Provider;
  requestedModel: string;
  promptVersion: string;
  /** ФАКТИЧЕСКАЯ (effective) политика фоллбэка из A1 `planFallback()`. */
  fallbackPolicy: FallbackPolicy;
  /** sha256 (16 hex) текста, о котором был вызов. */
  sourceHash: string;
  startedAt: string;
  outcome: 'SUCCESS' | 'FAILED';
  /** Кто фактически ответил. null — только если не ответил никто. */
  servedByProvider: Provider | null;
  servedByModel: string | null;
  /**
   * Ответ пришёл от РЕЗЕРВНОГО таргета. На упавшем вызове всегда `false`: не
   * ответил никто, и «резерв использован» тут значило бы другое, чем на
   * успешном вызове. Какие таргеты были ПОПРОБОВАНЫ (включая неудачный резерв)
   * — в `attempts[]`, это единственный источник правды по попыткам.
   */
  fallbackUsed: boolean;
  /** Каждая попытка, включая неудачные и прерванные (A1). */
  attempts: CompletionAttempt[];
  error?: string;
}

export interface LlmCallContext {
  role: LlmCallRole;
  batchIndex: number | null;
  label: string;
  config: CompletionRunConfig;
  /** Текст, к которому относится вызов — из него считается sourceHash. */
  sourceText: string;
}

export function hashSource(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

function baseRecord(context: LlmCallContext): Omit<
  LlmCallRecord,
  'startedAt' | 'outcome' | 'servedByProvider' | 'servedByModel' | 'fallbackUsed' | 'attempts'
> {
  return {
    role: context.role,
    batchIndex: context.batchIndex,
    label: context.label,
    requestedProvider: context.config.provider,
    requestedModel: context.config.model,
    promptVersion: context.config.promptVersion,
    fallbackPolicy: context.config.fallbackPolicy,
    sourceHash: hashSource(context.sourceText),
  };
}

export function recordSuccessfulCall(
  context: LlmCallContext,
  result: ChatCompletionResult
): LlmCallRecord {
  return {
    ...baseRecord(context),
    startedAt: result.attempts[0]?.startedAt ?? new Date().toISOString(),
    outcome: 'SUCCESS',
    servedByProvider: result.servedByProvider,
    servedByModel: result.servedByModel,
    fallbackUsed: result.fallbackUsed,
    attempts: result.attempts,
  };
}

/**
 * Упавший вызов тоже попадает в журнал. Без этого «модель X отработала весь
 * прогон» означало бы «модель X отработала всё, что не упало», а упавшее просто
 * исчезало бы из артефакта.
 */
export function recordFailedCall(
  context: LlmCallContext,
  error: unknown
): LlmCallRecord {
  const attempts = error instanceof ChatCompletionError ? error.attempts : [];
  return {
    ...baseRecord(context),
    startedAt: attempts[0]?.startedAt ?? new Date().toISOString(),
    outcome: 'FAILED',
    servedByProvider: null,
    servedByModel: null,
    fallbackUsed: false,
    attempts,
    error: error instanceof Error ? error.message : String(error),
  };
}

// ─────────────────────────── отношение моделей ───────────────────────────

/**
 * ФАКТ об отношении двух сторон прогона, а не оценка их независимости.
 * Предыдущая шкала (FULL/PARTIAL/NONE) называла бы Haiku против Sonnet «полной
 * независимостью», хотя это одно семейство одного вендора с коррелированными
 * ошибками. Слово «независимый» — вывод, который строится ПОВЕРХ этого факта
 * (`assessGraderIndependence`), а не хранится вместо него.
 */
export type ModelRelationship =
  | 'SAME_MODEL'
  | 'SAME_PROVIDER_DIFFERENT_MODEL'
  | 'DIFFERENT_PROVIDER'
  /** Батчи/retry внутри одного прогона обслужены разными моделями. */
  | 'MIXED'
  /** Не хватает attempt-метаданных: прогоны до A1, полностью упавшая сторона. */
  | 'UNKNOWN';

/** Однороден ли сам прогон — до всякого сравнения с другой стороной. */
export type RunModelConsistency = 'CONSISTENT' | 'MIXED' | 'UNKNOWN';

export interface ModelIdentity {
  provider: Provider;
  model: string;
}

function identityKey(identity: ModelIdentity): string {
  return `${identity.provider}/${identity.model}`;
}

/**
 * Различные ФАКТИЧЕСКИЕ исполнители среди вызовов. Упавшие вызовы не дают
 * исполнителя и в набор не входят — иначе полностью упавший прогон выглядел бы
 * однородным.
 */
export function servedIdentities(records: LlmCallRecord[]): ModelIdentity[] {
  const seen = new Map<string, ModelIdentity>();
  for (const record of records) {
    if (!record.servedByProvider || !record.servedByModel) continue;
    const identity: ModelIdentity = {
      provider: record.servedByProvider,
      model: record.servedByModel,
    };
    const key = identityKey(identity);
    if (!seen.has(key)) seen.set(key, identity);
  }
  return [...seen.values()];
}

export function computeRunModelConsistency(
  records: LlmCallRecord[]
): RunModelConsistency {
  const identities = servedIdentities(records);
  if (identities.length === 0) return 'UNKNOWN';
  return identities.length === 1 ? 'CONSISTENT' : 'MIXED';
}

/** Отношение двух конкретных исполнителей. */
export function relateIdentities(
  left: ModelIdentity,
  right: ModelIdentity
): ModelRelationship {
  if (left.provider !== right.provider) return 'DIFFERENT_PROVIDER';
  return left.model === right.model ? 'SAME_MODEL' : 'SAME_PROVIDER_DIFFERENT_MODEL';
}

/**
 * Считается по ФАКТИЧЕСКИМ `servedByProvider`/`servedByModel` из журнала
 * вызовов, а не по наличию env-переменных. Старая проверка сравнивала сырые
 * `process.env.EXTRACTION_MODEL` и `process.env.GRADER_MODEL`: при
 * `ANTHROPIC_MODEL=X`, `GRADER_MODEL=X` и незаданном `EXTRACTION_MODEL`
 * сравнение `null !== 'X'` объявляло судью независимым, хотя обе стороны
 * фактически ехали на одной модели X.
 *
 * Неоднородность ЛЮБОЙ из сторон даёт `MIXED`: если половина батчей ушла на
 * другую модель, «отношение экстрактора к судье» — не одно отношение, и
 * называть его одним значением было бы той же ложью в другом месте.
 */
export function computeModelRelationship(
  extractionCalls: LlmCallRecord[],
  graderCalls: LlmCallRecord[]
): ModelRelationship {
  const extraction = servedIdentities(extractionCalls);
  const grader = servedIdentities(graderCalls);

  if (extraction.length === 0 || grader.length === 0) return 'UNKNOWN';
  if (extraction.length > 1 || grader.length > 1) return 'MIXED';

  return relateIdentities(extraction[0], grader[0]);
}

// ─────────────────── policy-вывод ПОВЕРХ факта, не вместо ───────────────────

export type GraderIndependenceVerdict =
  | 'INDEPENDENT'
  | 'PARTIALLY_INDEPENDENT'
  | 'NOT_INDEPENDENT'
  | 'UNDETERMINED';

/**
 * Отдельная функция, а не поле артефакта: интерпретация может меняться (сегодня
 * «разные вендоры = независим», завтра появятся основания считать иначе), факт
 * `ModelRelationship` — нет. Прогоны, записанные разными версиями этой политики,
 * остаются сравнимыми, потому что сравнивается сохранённый факт.
 */
export function assessGraderIndependence(
  relationship: ModelRelationship
): GraderIndependenceVerdict {
  switch (relationship) {
    case 'DIFFERENT_PROVIDER':
      return 'INDEPENDENT';
    case 'SAME_PROVIDER_DIFFERENT_MODEL':
      return 'PARTIALLY_INDEPENDENT';
    case 'SAME_MODEL':
    case 'MIXED':
      return 'NOT_INDEPENDENT';
    case 'UNKNOWN':
      return 'UNDETERMINED';
  }
}

const RELATIONSHIP_RU: Record<ModelRelationship, string> = {
  SAME_MODEL: 'та же модель того же провайдера',
  SAME_PROVIDER_DIFFERENT_MODEL: 'тот же провайдер, другая модель',
  DIFFERENT_PROVIDER: 'разные провайдеры',
  MIXED: 'внутри прогона вызовы обслужены разными моделями',
  UNKNOWN: 'фактических данных о вызовах не хватает',
};

const VERDICT_RU: Record<GraderIndependenceVerdict, string> = {
  INDEPENDENT: 'судья независим от экстрактора',
  PARTIALLY_INDEPENDENT: 'судья независим ЧАСТИЧНО (одно семейство моделей одного вендора — ошибки коррелируют)',
  NOT_INDEPENDENT: 'судья НЕ независим',
  UNDETERMINED: 'независимость судьи не установлена',
};

/**
 * Единственная разрешённая формулировка про независимость в отчётах и логах:
 * слово «независим» здесь физически не существует без `ModelRelationship=...`
 * рядом с ним, потому что обе части собирает одна и та же строка.
 */
export function describeGraderIndependence(relationship: ModelRelationship): string {
  const verdict = assessGraderIndependence(relationship);
  return `${VERDICT_RU[verdict]} [ModelRelationship=${relationship}: ${RELATIONSHIP_RU[relationship]}]`;
}

export interface RunSideSummary {
  calls: number;
  /**
   * Вызовы, которые не получили ответа. Стоит рядом с `modelConsistency`
   * намеренно: однородность считается по УСПЕШНЫМ вызовам, и прогон, где три
   * батча из четырёх упали, тоже даёт `CONSISTENT` — честно про исполнителя,
   * но «весь документ отработан чисто» из этого не следует.
   */
  failedCalls: number;
  /**
   * Успешные вызовы, где фактический исполнитель отличался от запрошенного в
   * run config (сработал резерв). Если резерв сработал ОДИНАКОВО на всех
   * вызовах, прогон однороден и `MIXED` не возникает — но он весь ушёл не на
   * той модели, которую заказывали, и это должно быть видно в сводке, а не
   * только при построчном чтении журнала.
   */
  divergedFromRequest: number;
  modelConsistency: RunModelConsistency;
  servedIdentities: ModelIdentity[];
}

export interface RunModelSummary {
  extraction: RunSideSummary;
  grader: RunSideSummary;
  /** ФАКТ. */
  relationship: ModelRelationship;
  /** Интерпретация факта — отдельным полем, чтобы её можно было пересчитать. */
  independence: GraderIndependenceVerdict;
  /** Готовая формулировка для отчёта, всегда с указанием отношения. */
  statement: string;
}

/** Успешный вызов, чей исполнитель не совпал с запрошенным в run config. */
export function divergedFromRequest(record: LlmCallRecord): boolean {
  if (!record.servedByProvider || !record.servedByModel) return false;
  return (
    record.servedByProvider !== record.requestedProvider ||
    record.servedByModel !== record.requestedModel
  );
}

function summarizeSide(records: LlmCallRecord[]): RunSideSummary {
  return {
    calls: records.length,
    failedCalls: records.filter((record) => record.outcome === 'FAILED').length,
    divergedFromRequest: records.filter(divergedFromRequest).length,
    modelConsistency: computeRunModelConsistency(records),
    servedIdentities: servedIdentities(records),
  };
}

/**
 * Блок артефакта про модели прогона. Собирается ОДНОЙ функцией, чтобы то, что
 * печатается в консоль, и то, что уходит в JSON, не могли разойтись.
 */
export function summarizeRunModels(
  extractionCalls: LlmCallRecord[],
  graderCalls: LlmCallRecord[]
): RunModelSummary {
  const relationship = computeModelRelationship(extractionCalls, graderCalls);
  return {
    extraction: summarizeSide(extractionCalls),
    grader: summarizeSide(graderCalls),
    relationship,
    independence: assessGraderIndependence(relationship),
    statement: describeGraderIndependence(relationship),
  };
}
