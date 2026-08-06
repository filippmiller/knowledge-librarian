/**
 * Gate-семантика золотого регрессионного корпуса (Beads translation-toh,
 * docs/plans/2026-08-06-hardening-and-domain-contract-plan.md §3, PR A3).
 *
 * До этого модуля у корпуса был только `pass: boolean` на кейс. Из него
 * невозможно отличить «бот ответил неверно» от «бот молча съехал в hold»:
 * кейс, у которого в `expect` не задан hold-признак, формально PASS в обоих
 * случаях. Поэтому расположение ответа (`ActualDisposition`) вычисляется из
 * РЕАЛЬНОГО ответа движка ДО любого сравнения с ожиданием, и только потом
 * пара (ожидание, факт) отображается в вердикт по явной матрице.
 *
 * Модуль намеренно чистый: ни I/O, ни Prisma, ни движка — чтобы матрицу можно
 * было прогнать таблично в vitest без БД и без ключей моделей.
 */

import type { DeliveryDecision } from '@/lib/ai/delivery-decision';

/** Что движок фактически сделал — вычисляется из ответа, не из ожиданий. */
export type ActualDisposition = 'DIRECT_ANSWER' | 'HOLD' | 'ERROR';

/** Что мы от кейса ждём. Задаётся в корпусе явно, значения по умолчанию нет. */
export type ExpectedDisposition =
  | 'MUST_PASS' // ожидаем прямой корректный ответ
  | 'MUST_HOLD' // ожидаем hold/clarification, не прямой ответ
  | 'MAY_HOLD' // и прямой ответ (если корректный), и hold — оба приемлемы
  | 'KNOWN_FAIL'; // ожидаемо падает сегодня, не блокирует gate

export type CaseResult = 'PASS' | 'FAIL' | 'XFAIL' | 'XPASS';

export type RunMode = 'baseline' | 'gate';

export const EXPECTED_DISPOSITIONS = [
  'MUST_PASS',
  'MUST_HOLD',
  'MAY_HOLD',
  'KNOWN_FAIL',
] as const satisfies readonly ExpectedDisposition[];

export const RUN_MODES = ['baseline', 'gate'] as const satisfies readonly RunMode[];

/**
 * `KNOWN_FAIL` означает «сегодня этот кейс не проходит, но обязан проходить
 * после починки»: базовая семантика для него — `MUST_PASS`. Это единственное
 * правило, а не молчаливый default: если однажды понадобится known-fail с
 * ожидаемым hold, он добавляется сюда явно, отдельным полем корпуса.
 */
const KNOWN_FAIL_BASELINE = 'MUST_PASS' as const;

type SettledExpectation = Exclude<ExpectedDisposition, 'KNOWN_FAIL'>;

function assertNever(value: never, context: string): never {
  throw new Error(`${context}: необработанное значение ${JSON.stringify(value)}`);
}

/**
 * Результат одного прогона кейса до сравнения с ожиданием. `threw` — это
 * исключение самого движка, а не проваленная проверка: разница принципиальна,
 * потому что исключение никогда не имеет права стать XFAIL.
 */
export type EngineOutcome =
  | { kind: 'delivered'; decision: DeliveryDecision }
  | { kind: 'threw'; error: unknown };

/**
 * Расположение ответа = решение ПРОДОВОЙ политики доставки, а не собственная
 * эвристика корпуса.
 *
 * Прежний рантайм корпуса считал удержанием любое из
 * `needsClarification || requiresHumanReview || confidenceLevel === 'insufficient'`.
 * Это расходится с продом: голый `needsClarification` там удержанием НЕ
 * является — уточнением считается только сценарное (`scenarioClarification`,
 * см. `shouldSendClarification`), а всё остальное обязано пройти шлюз
 * уверенности. С той эвристикой кейс `MUST_HOLD` проходил бы, даже когда
 * прод спокойно отправил бы прямой черновик, — то есть gate сторожил бы не то.
 *
 * Отображение (единственное, полное, без ветки по умолчанию):
 *   'answer'   → DIRECT_ANSWER — прод отдаёт ответ движка адресату;
 *   'clarify'  → HOLD — уходит уточняющий вопрос с вариантами, не утверждение;
 *   'escalate' → HOLD — ответ не отправляется, вопрос уходит оператору
 *                (клиенту текст ещё и подменяется, см. `isAnswerWithheld`);
 *   исключение движка → ERROR (обрабатывается веткой `threw` выше).
 *
 * Аудитория на РАСПОЛОЖЕНИЕ не влияет — `decideDelivery` от неё не зависит.
 * Она влияет на то, КАКОЙ текст увидит адресат, и потому учитывается там, где
 * проверяются утверждения (см. `corpus.ts`, `resolveEvalDelivery`).
 */
export function dispositionOfDelivery(decision: DeliveryDecision): 'DIRECT_ANSWER' | 'HOLD' {
  switch (decision) {
    case 'answer':
      return 'DIRECT_ANSWER';
    case 'clarify':
      return 'HOLD';
    case 'escalate':
      return 'HOLD';
    default:
      return assertNever(decision, 'dispositionOfDelivery');
  }
}

/** ActualDisposition из фактического исхода прогона. Ожидания сюда не попадают. */
export function computeActualDisposition(outcome: EngineOutcome): ActualDisposition {
  switch (outcome.kind) {
    case 'threw':
      return 'ERROR';
    case 'delivered':
      return dispositionOfDelivery(outcome.decision);
    default:
      return assertNever(outcome, 'computeActualDisposition');
  }
}

export interface CaseVerdictInput {
  expected: ExpectedDisposition;
  actual: ActualDisposition;
  /**
   * Прошли ли проверки качества ответа (expectedSubstrings / minConfidence /
   * answerSourceIn). По матрице они смотрятся только у DIRECT_ANSWER: у hold
   * низкая уверенность и отсутствие источника — норма, а не провал.
   */
  assertionsPassed: boolean;
  /**
   * Прошли ли safety-проверки (`forbiddenSubstrings`).
   *
   * ЕДИНСТВЕННОЕ намеренное ужесточение относительно матрицы из плана: она
   * описывает `HOLD → PASS` без оговорок, но удержание не означает, что текст
   * никто не увидит. При `escalate` внутренней аудитории уходит ПОЛНЫЙ
   * черновик (подмена работает только для клиента, см. `isAnswerWithheld`), а
   * утечка внутреннего адреса партнёра — ровно та регрессия, которую сторожат
   * кейсы wrong-scope/client-leakage. Поэтому запрещённые подстроки
   * проверяются на ИСХОДЯЩЕМ тексте при любом расположении и никогда не
   * понижаются до XFAIL.
   */
  safetyPassed: boolean;
}

/**
 * Матрица §3 PR A3 для «решённых» ожиданий. Каждая пара перечислена явно;
 * ветки `default` возвращают `assertNever`, поэтому ни одно значение не может
 * провалиться в неявное поведение — новый член любого из союзов ломает сборку.
 */
function settledResult(
  expected: SettledExpectation,
  actual: ActualDisposition,
  assertionsPassed: boolean
): 'PASS' | 'FAIL' {
  switch (expected) {
    case 'MUST_PASS':
      switch (actual) {
        case 'DIRECT_ANSWER':
          return assertionsPassed ? 'PASS' : 'FAIL';
        case 'HOLD':
          return 'FAIL';
        case 'ERROR':
          return 'FAIL';
        default:
          return assertNever(actual, 'settledResult/MUST_PASS');
      }
    case 'MUST_HOLD':
      switch (actual) {
        case 'HOLD':
          return 'PASS';
        case 'DIRECT_ANSWER':
          return 'FAIL';
        case 'ERROR':
          return 'FAIL';
        default:
          return assertNever(actual, 'settledResult/MUST_HOLD');
      }
    case 'MAY_HOLD':
      switch (actual) {
        case 'HOLD':
          return 'PASS';
        case 'DIRECT_ANSWER':
          return assertionsPassed ? 'PASS' : 'FAIL';
        case 'ERROR':
          return 'FAIL';
        default:
          return assertNever(actual, 'settledResult/MAY_HOLD');
      }
    default:
      return assertNever(expected, 'settledResult');
  }
}

/**
 * Вердикт кейса по матрице. Порядок проверок важен:
 * 1. исключение движка — всегда FAIL, ни при каком ожидании не XFAIL;
 * 2. нарушение safety — всегда FAIL (см. `safetyPassed`);
 * 3. KNOWN_FAIL — базовый вердикт по MUST_PASS, затем XFAIL/XPASS;
 * 4. остальное — прямо по матрице.
 */
export function resolveCaseResult({
  expected,
  actual,
  assertionsPassed,
  safetyPassed,
}: CaseVerdictInput): CaseResult {
  if (actual === 'ERROR') return 'FAIL';
  if (!safetyPassed) return 'FAIL';

  if (expected === 'KNOWN_FAIL') {
    const base = settledResult(KNOWN_FAIL_BASELINE, actual, assertionsPassed);
    switch (base) {
      case 'FAIL':
        return 'XFAIL';
      case 'PASS':
        return 'XPASS';
      default:
        return assertNever(base, 'resolveCaseResult/KNOWN_FAIL');
    }
  }

  return settledResult(expected, actual, assertionsPassed);
}

/** Какие вердикты роняют gate. XFAIL — нет, XPASS — да (нужен ручной пересмотр baseline). */
export function isGateBlocking(result: CaseResult): boolean {
  switch (result) {
    case 'FAIL':
      return true;
    case 'XPASS':
      return true;
    case 'PASS':
      return false;
    case 'XFAIL':
      return false;
    default:
      return assertNever(result, 'isGateBlocking');
  }
}

/**
 * Код возврата прогона. `baseline` не падает из-за содержимого кейсов НИКОГДА —
 * его работа снять снимок текущего состояния. Операционные сбои (нечитаемый
 * корпус, несуществующий --id, неудачная запись артефакта) обрабатываются
 * вызывающим скриптом отдельно и к этой функции отношения не имеют.
 */
export function computeExitCode(mode: RunMode, results: readonly CaseResult[]): 0 | 1 {
  switch (mode) {
    case 'baseline':
      return 0;
    case 'gate':
      return results.some(isGateBlocking) ? 1 : 0;
    default:
      return assertNever(mode, 'computeExitCode');
  }
}
