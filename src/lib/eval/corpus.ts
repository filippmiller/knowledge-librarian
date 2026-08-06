/**
 * Схема, загрузка и прогон золотого регрессионного корпуса
 * (Beads translation-toh, план §3 PR A3).
 *
 * Здесь живёт всё, что нужно проверить без БД и без ключей моделей: разбор
 * фикстуры, проверки утверждений и оркестрация прогона с ВНЕДРЯЕМЫМ движком.
 * Сам вызов `answerQuestionEnhanced` подставляет CLI (scripts/run-eval-corpus.ts),
 * поэтому тесты гоняют ту же оркестрацию на подставном движке.
 */

import type { Audience } from '@/lib/knowledge/audience';
import type { EnhancedAnswerResult } from '@/lib/ai/enhanced-answering-engine';
import type { TelemetryMode } from '@/lib/ai/answer-telemetry';
import {
  CLIENT_HOLDING_ANSWER,
  decideDelivery,
  isAnswerWithheld,
  type AutoAnswerSettings,
  type DeliveryDecision,
} from '@/lib/ai/delivery-decision';
import { DEFAULT_MIN_CONFIDENCE } from '@/lib/telegram/constants';
import {
  computeActualDisposition,
  isGateBlocking,
  resolveCaseResult,
  EXPECTED_DISPOSITIONS,
  type ActualDisposition,
  type CaseResult,
  type ExpectedDisposition,
} from './disposition';

const ANSWER_SOURCES = ['knowledge_base', 'general_ai', 'deterministic_guardrail'] as const;
type AnswerSource = (typeof ANSWER_SOURCES)[number];

const AUDIENCES = ['internal', 'client'] as const;

const EXPECT_KEYS = [
  'forbiddenSubstrings',
  'expectedSubstrings',
  'minConfidence',
  'answerSourceIn',
] as const;

const CASE_KEYS = [
  'id',
  'category',
  'question',
  'audience',
  'source',
  'expectedDisposition',
  'expect',
  'notes',
] as const;

export interface EvalCaseExpect {
  /** Ответ НЕ должен содержать ни одной из этих подстрок (без учёта регистра). Safety. */
  forbiddenSubstrings?: string[];
  /** Ответ должен содержать ХОТЯ БЫ ОДНУ из этих подстрок (без учёта регистра). */
  expectedSubstrings?: string[];
  /** `result.confidence` не ниже этого значения. */
  minConfidence?: number;
  /** `result.answerSource` входит в этот список. */
  answerSourceIn?: AnswerSource[];
}

export interface EvalCase {
  id: string;
  category: string;
  question: string;
  audience: Audience;
  source: string;
  /** Обязательно и явно у КАЖДОГО кейса: значения по умолчанию нет by design. */
  expectedDisposition: ExpectedDisposition;
  expect: EvalCaseExpect;
  notes?: string;
}

/** Ответ движка целиком: политика доставки читает его же, а не выжимку. */
export type EvalAnswer = EnhancedAnswerResult;

export interface EvalEngineRequest {
  question: string;
  audience: Audience;
  includeDebug: boolean;
  telemetryMode: TelemetryMode;
}

export type AskFn = (evalCase: EvalCase) => Promise<EvalAnswer>;

/**
 * Настройки доставки для прогона корпуса — ЗАКРЕПЛЁННЫЕ, не из базы.
 *
 * `resolveDelivery()` в проде читает живой тумблер автоответа (`AISettings`).
 * Регрессионному шлюзу это не подходит: при выключенном тумблере каждый ответ
 * стал бы `escalate`, то есть HOLD, и весь корпус упал бы по причине, не
 * имеющей отношения к качеству ответов. Поэтому корпус спрашивает у той же
 * политики другой, воспроизводимый вопрос: «отправил бы прод этот ответ, будь
 * автоответ включён?» Порог — тот же общий `DEFAULT_MIN_CONFIDENCE`, что и у
 * настроек по умолчанию, а не собственное число.
 */
export const EVAL_DELIVERY_SETTINGS: AutoAnswerSettings = {
  enabled: true,
  minConfidence: DEFAULT_MIN_CONFIDENCE,
};

export interface EvalDelivery {
  decision: DeliveryDecision;
  /** Текст подменён, потому что клиенту черновик показывать нельзя. */
  withheld: boolean;
  /** Что реально увидит аудитория этого кейса. На нём и проверяется safety. */
  outboundAnswer: string;
  /** Черновик движка. Клиенту при `withheld` не показывается, оператору — да. */
  draftAnswer: string;
}

/**
 * Что прод сделал бы с этим ответом для аудитории кейса.
 *
 * Повторяет `resolveDelivery()` из `@/lib/ai/delivery`, но синхронно и на
 * закреплённых настройках: обе функции зовут ОДНИ И ТЕ ЖЕ `decideDelivery` и
 * `isAnswerWithheld`, поэтому второй реализации политики здесь нет.
 */
export function resolveEvalDelivery(answer: EvalAnswer, audience: Audience): EvalDelivery {
  const decision = decideDelivery(answer, EVAL_DELIVERY_SETTINGS);
  const withheld = isAnswerWithheld(decision, audience);
  return {
    decision,
    withheld,
    draftAnswer: answer.answer,
    outboundAnswer: withheld ? CLIENT_HOLDING_ANSWER : answer.answer,
  };
}

/**
 * Разбор фикстуры без внешних зависимостей.
 *
 * Валидатор написан руками намеренно: этот модуль — путь запуска шлюза, от
 * которого зависит решение «ехать или нет», и лишняя рантайм-зависимость в нём
 * означает лишний способ не стартовать вовсе. Проверок ровно столько, сколько
 * нужно, и они строгие.
 *
 * Неизвестный ключ — ошибка, а не тихо игнорируемое поле: именно это ловит
 * остатки снятого `requiresClarificationOrHold` (его заменила
 * `expectedDisposition`) и опечатки в именах проверок, которые иначе
 * превратили бы кейс в бессодержательный PASS.
 */
export function parseCorpus(raw: unknown): EvalCase[] {
  const issues: string[] = [];

  if (!Array.isArray(raw)) throw new Error('Корпус не прошёл разбор:\n  · <root>: ожидался массив кейсов');
  if (raw.length === 0) throw new Error('Корпус не прошёл разбор:\n  · <root>: корпус пуст');

  const cases: EvalCase[] = [];
  const seen = new Set<string>();

  raw.forEach((entry, index) => {
    const at = (field: string) => `${index}.${field}`;
    const push = (field: string, message: string) => issues.push(`  · ${at(field)}: ${message}`);

    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      issues.push(`  · ${index}: ожидался объект кейса`);
      return;
    }
    const rec = entry as Record<string, unknown>;

    for (const key of Object.keys(rec)) {
      if (!(CASE_KEYS as readonly string[]).includes(key)) {
        push(key, 'неизвестное поле кейса');
      }
    }

    // Строка из одних пробелов — не значение: id из пробелов стал бы ключом
    // снимка, а вопрос из пробелов ушёл бы в движок как есть.
    const str = (field: string): string | null => {
      const value = rec[field];
      if (typeof value !== 'string' || value.trim().length === 0) {
        push(field, 'ожидалась непустая строка');
        return null;
      }
      return value;
    };

    const id = str('id');
    const category = str('category');
    const question = str('question');
    const source = str('source');

    const audience = rec.audience;
    if (!(AUDIENCES as readonly unknown[]).includes(audience)) {
      push('audience', `ожидалось одно из [${AUDIENCES.join(', ')}]`);
    }

    const expectedDisposition = rec.expectedDisposition;
    if (!(EXPECTED_DISPOSITIONS as readonly unknown[]).includes(expectedDisposition)) {
      push(
        'expectedDisposition',
        `обязательное поле; ожидалось одно из [${EXPECTED_DISPOSITIONS.join(', ')}]`
      );
    }

    if (rec.notes !== undefined && typeof rec.notes !== 'string') {
      push('notes', 'ожидалась строка');
    }

    const expect = parseExpect(rec.expect, at, issues);

    // Дубликат id копится как обычная проблема, а не бросается сразу: иначе
    // он глушил бы все уже собранные ошибки полей, и починка корпуса
    // превращалась бы в починку по одной проблеме за прогон.
    if (id !== null) {
      if (seen.has(id)) push('id', `дублирующийся id кейса: "${id}"`);
      else seen.add(id);
    }

    if (
      id !== null &&
      category !== null &&
      question !== null &&
      source !== null &&
      expect !== null &&
      (AUDIENCES as readonly unknown[]).includes(audience) &&
      (EXPECTED_DISPOSITIONS as readonly unknown[]).includes(expectedDisposition)
    ) {
      cases.push({
        id,
        category,
        question,
        audience: audience as Audience,
        source,
        expectedDisposition: expectedDisposition as ExpectedDisposition,
        expect,
        ...(typeof rec.notes === 'string' ? { notes: rec.notes } : {}),
      });
    }
  });

  if (issues.length > 0) {
    throw new Error(`Корпус не прошёл разбор:\n${issues.join('\n')}`);
  }
  return cases;
}

function parseExpect(
  raw: unknown,
  at: (field: string) => string,
  issues: string[]
): EvalCaseExpect | null {
  const push = (field: string, message: string) => issues.push(`  · ${at(field)}: ${message}`);

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    push('expect', 'ожидался объект проверок');
    return null;
  }
  const rec = raw as Record<string, unknown>;
  const expect: EvalCaseExpect = {};
  let ok = true;

  for (const key of Object.keys(rec)) {
    if (!(EXPECT_KEYS as readonly string[]).includes(key)) {
      push(`expect.${key}`, 'неизвестная проверка');
      ok = false;
    }
  }

  for (const key of ['forbiddenSubstrings', 'expectedSubstrings'] as const) {
    const value = rec[key];
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((s) => typeof s !== 'string' || s.length === 0)
    ) {
      push(`expect.${key}`, 'ожидался непустой массив непустых строк');
      ok = false;
      continue;
    }
    expect[key] = value as string[];
  }

  if (rec.minConfidence !== undefined) {
    const value = rec.minConfidence;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      push('expect.minConfidence', 'ожидалось число в диапазоне [0, 1]');
      ok = false;
    } else {
      expect.minConfidence = value;
    }
  }

  if (rec.answerSourceIn !== undefined) {
    const value = rec.answerSourceIn;
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      value.some((s) => !(ANSWER_SOURCES as readonly unknown[]).includes(s))
    ) {
      push('expect.answerSourceIn', `ожидался непустой массив из [${ANSWER_SOURCES.join(', ')}]`);
      ok = false;
    } else {
      expect.answerSourceIn = value as AnswerSource[];
    }
  }

  return ok ? expect : null;
}

export interface AssertionOutcome {
  /**
   * Нарушения `forbiddenSubstrings` в ИСХОДЯЩЕМ тексте — то, что реально
   * увидит аудитория кейса. Проверяются при любом расположении и роняют gate.
   */
  safetyFailures: string[];
  /**
   * Те же запрещённые подстроки, но в ЧЕРНОВИКЕ, который клиенту не ушёл
   * (`withheld`). Gate не роняют — прод сработал правильно и текст не показал, —
   * но остаются в снимке: сама wrong-scope выдача никуда не делась, и молча
   * терять этот сигнал нельзя.
   */
  draftSafetyWarnings: string[];
  /**
   * Проверки качества прямого ответа. Считаются по черновику движка (это
   * утверждения о его выдаче), а по матрице смотрятся только у DIRECT_ANSWER —
   * где черновик и исходящий текст в любом случае совпадают.
   */
  qualityFailures: string[];
}

function findForbidden(text: string, forbidden: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return forbidden.filter((s) => lower.includes(s.toLowerCase()));
}

/** Проверки утверждений кейса. Вердикт здесь не выносится — только факты. */
export function evaluateAssertions(
  evalCase: EvalCase,
  answer: EvalAnswer,
  delivery: EvalDelivery
): AssertionOutcome {
  const { expect } = evalCase;
  const forbidden = expect.forbiddenSubstrings ?? [];
  const draftLower = delivery.draftAnswer.toLowerCase();
  const qualityFailures: string[] = [];

  const safetyFailures = findForbidden(delivery.outboundAnswer, forbidden).map(
    (s) => `исходящий ответ содержит запрещённую подстроку "${s}"`
  );
  const draftSafetyWarnings = delivery.withheld
    ? findForbidden(delivery.draftAnswer, forbidden).map(
        (s) => `черновик содержит запрещённую подстроку "${s}" (клиенту не отправлен: удержан)`
      )
    : [];

  if (expect.expectedSubstrings) {
    const hasAny = expect.expectedSubstrings.some((s) => draftLower.includes(s.toLowerCase()));
    if (!hasAny) {
      qualityFailures.push(
        `ответ не содержит ни одной из ожидаемых подстрок [${expect.expectedSubstrings.join(', ')}]`
      );
    }
  }

  if (expect.minConfidence !== undefined && answer.confidence < expect.minConfidence) {
    qualityFailures.push(
      `уверенность ${answer.confidence.toFixed(2)} ниже ожидаемого минимума ${expect.minConfidence}`
    );
  }

  if (expect.answerSourceIn) {
    if (!answer.answerSource || !expect.answerSourceIn.includes(answer.answerSource)) {
      qualityFailures.push(
        `answerSource=${answer.answerSource ?? 'undefined'} не входит в ожидаемое [${expect.answerSourceIn.join(', ')}]`
      );
    }
  }

  return { safetyFailures, draftSafetyWarnings, qualityFailures };
}

export interface CaseRecord {
  id: string;
  category: string;
  question: string;
  audience: Audience;
  expectedDisposition: ExpectedDisposition;
  actualDisposition: ActualDisposition;
  /** Решение продовой политики, из которого получено `actualDisposition`. */
  deliveryDecision: DeliveryDecision | null;
  caseResult: CaseResult;
  gateBlocking: boolean;
  safetyFailures: string[];
  draftSafetyWarnings: string[];
  assertionFailures: string[];
  engineError: string | null;
  answer: {
    /** Черновик движка. */
    draft: string;
    /** Что увидела бы аудитория кейса. Отличается от черновика только при `withheld`. */
    outbound: string;
    withheld: boolean;
    confidence: number;
    confidenceLevel: EvalAnswer['confidenceLevel'];
    needsClarification: boolean;
    requiresHumanReview: boolean;
    hasScenarioClarification: boolean;
    answerSource: EvalAnswer['answerSource'] | null;
  } | null;
}

/** Один кейс: прогон движка → ActualDisposition → проверки → вердикт по матрице. */
export async function runCase(evalCase: EvalCase, ask: AskFn): Promise<CaseRecord> {
  let answer: EvalAnswer | null = null;
  let engineError: string | null = null;

  try {
    answer = await ask(evalCase);
  } catch (error) {
    engineError = error instanceof Error ? error.message : String(error);
  }

  const delivery = answer === null ? null : resolveEvalDelivery(answer, evalCase.audience);

  // Расположение считается ПЕРВЫМ и только из фактического исхода — решения
  // продовой политики доставки. Ожидания кейса в это вычисление не входят.
  const actualDisposition = computeActualDisposition(
    delivery === null
      ? { kind: 'threw', error: engineError }
      : { kind: 'delivered', decision: delivery.decision }
  );

  const assertions: AssertionOutcome =
    answer === null || delivery === null
      ? { safetyFailures: [], draftSafetyWarnings: [], qualityFailures: [] }
      : evaluateAssertions(evalCase, answer, delivery);

  const caseResult = resolveCaseResult({
    expected: evalCase.expectedDisposition,
    actual: actualDisposition,
    assertionsPassed: assertions.qualityFailures.length === 0,
    safetyPassed: assertions.safetyFailures.length === 0,
  });

  return {
    id: evalCase.id,
    category: evalCase.category,
    question: evalCase.question,
    audience: evalCase.audience,
    expectedDisposition: evalCase.expectedDisposition,
    actualDisposition,
    deliveryDecision: delivery?.decision ?? null,
    caseResult,
    gateBlocking: isGateBlocking(caseResult),
    safetyFailures: assertions.safetyFailures,
    draftSafetyWarnings: assertions.draftSafetyWarnings,
    assertionFailures: assertions.qualityFailures,
    engineError,
    answer:
      answer === null || delivery === null
        ? null
        : {
            draft: delivery.draftAnswer,
            outbound: delivery.outboundAnswer,
            withheld: delivery.withheld,
            confidence: answer.confidence,
            confidenceLevel: answer.confidenceLevel,
            needsClarification: answer.needsClarification === true,
            requiresHumanReview: answer.requiresHumanReview === true,
            hasScenarioClarification: Boolean(answer.scenarioClarification),
            answerSource: answer.answerSource ?? null,
          },
  };
}

/** Последовательный прогон корпуса. Порядок вывода — файловый, ключ результата — id. */
export async function runCorpus(
  cases: readonly EvalCase[],
  ask: AskFn,
  onCaseDone?: (record: CaseRecord) => void
): Promise<CaseRecord[]> {
  const records: CaseRecord[] = [];
  for (const evalCase of cases) {
    const record = await runCase(evalCase, ask);
    records.push(record);
    onCaseDone?.(record);
  }
  return records;
}

/**
 * Результаты по СТАБИЛЬНЫМ id, а не по порядковому номеру в файле: перестановка
 * кейсов не имеет права сдвинуть diff двух baseline-снимков.
 */
export function indexById(records: readonly CaseRecord[]): Record<string, CaseRecord> {
  const byId: Record<string, CaseRecord> = {};
  for (const record of records) {
    if (byId[record.id]) {
      throw new Error(`Дублирующийся id кейса в результатах: "${record.id}"`);
    }
    byId[record.id] = record;
  }
  return byId;
}

export interface CorpusSummary {
  total: number;
  byCaseResult: Record<CaseResult, number>;
  byActualDisposition: Record<ActualDisposition, number>;
  holdRate: number;
  errorIds: string[];
  failedIds: string[];
  xfailIds: string[];
  xpassIds: string[];
  blockingIds: string[];
}

export function summarize(records: readonly CaseRecord[]): CorpusSummary {
  const byCaseResult: Record<CaseResult, number> = { PASS: 0, FAIL: 0, XFAIL: 0, XPASS: 0 };
  const byActualDisposition: Record<ActualDisposition, number> = {
    DIRECT_ANSWER: 0,
    HOLD: 0,
    ERROR: 0,
  };

  for (const record of records) {
    byCaseResult[record.caseResult] += 1;
    byActualDisposition[record.actualDisposition] += 1;
  }

  return {
    total: records.length,
    byCaseResult,
    byActualDisposition,
    holdRate: records.length === 0 ? 0 : byActualDisposition.HOLD / records.length,
    errorIds: records.filter((r) => r.actualDisposition === 'ERROR').map((r) => r.id),
    failedIds: records.filter((r) => r.caseResult === 'FAIL').map((r) => r.id),
    xfailIds: records.filter((r) => r.caseResult === 'XFAIL').map((r) => r.id),
    xpassIds: records.filter((r) => r.caseResult === 'XPASS').map((r) => r.id),
    blockingIds: records.filter((r) => r.gateBlocking).map((r) => r.id),
  };
}

/**
 * Переходник к реальному движку. Телеметрия глушится ЗДЕСЬ, в одном месте:
 * прогон корпуса бьёт по продовой базе, и его сотни синтетических вопросов не
 * должны подмешиваться в HallucinationLog, по которому считают реальную
 * статистику галлюцинаций. На путь обычного пользователя это не влияет —
 * там `telemetryMode` не задаётся и остаётся 'enabled'.
 */
export function createEngineAsk(
  answerFn: (request: EvalEngineRequest) => Promise<EvalAnswer>
): AskFn {
  return (evalCase) =>
    answerFn({
      question: evalCase.question,
      audience: evalCase.audience,
      includeDebug: false,
      telemetryMode: 'disabled',
    });
}
