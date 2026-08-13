/**
 * Политика доставки — отдельным модулем без единой рантайм-зависимости.
 *
 * Тип нужен и серверу, и браузеру: песочница `/admin/bot-lab` показывает
 * решение, принятое сервером, и обязана знать его список значений. Пока тип жил
 * рядом с самой политикой, клиентскому компоненту приходилось импортировать
 * модуль, который тянет за собой Prisma. `import type` стирается при сборке и
 * потому безопасен, но это хрупко: достаточно одному человеку убрать слово
 * `type`, и клиентская сборка потянет базу. Здесь тянуть нечего.
 *
 * Сюда же переехали САМИ РЕШАЮЩИЕ ФУНКЦИИ — они всегда были чистыми (читают
 * результат движка и настройки, больше ничего). Раньше они жили в
 * `telegram/auto-answer-policy.ts` вместе с походом в базу и отправкой в
 * Telegram, из-за чего любой потребитель — включая золотой корпус и юнит-тесты —
 * обязан был поднимать Prisma, чтобы спросить «а отправили бы этот ответ?».
 * `auto-answer-policy.ts` реэкспортирует их, поэтому все прежние места вызова
 * работают без правок.
 *
 * Значений ровно три, и это не оформление, а контракт: клиенту либо уходит
 * ответ, либо уточняющий вопрос, либо ответ не уходит вовсе.
 */
import type { AnswerSource } from '@/lib/ai/answer-source';

export type DeliveryDecision = 'clarify' | 'answer' | 'escalate';

/** Проверка значения, пришедшего с сервера или из старой записи. */
export function isDeliveryDecision(value: unknown): value is DeliveryDecision {
  return value === 'clarify' || value === 'answer' || value === 'escalate';
}

/**
 * Что помешало отправить ответ. Порядок значений — порядок проверок в политике:
 * возвращается ПЕРВАЯ сработавшая причина, а не все сразу. Так и принимается
 * решение, и объяснение обязано совпадать с ним, а не быть полнее.
 */
export type AutoAnswerBlocker =
  /** Тумблер автоответа в настройках выключен. Ответ может быть отличным. */
  | 'auto_answer_disabled'
  /** Сработал один из контролей качества — какой именно, см. `humanReviewReasons`. */
  | 'human_review_required'
  /** Ответ собран из общих знаний модели, а не из базы знаний. */
  | 'general_ai_source'
  /** Движок сам оценил свой ответ как слабый. */
  | 'confidence_level_too_low'
  /** Уверенность ниже порога, выставленного оператором в настройках. */
  | 'below_min_confidence';

export const AUTO_ANSWER_BLOCKER_LABELS: Record<AutoAnswerBlocker, string> = {
  auto_answer_disabled: 'Автоответ выключен в настройках — дело не в качестве ответа',
  human_review_required: 'Сработал контроль качества',
  general_ai_source: 'Ответ из общих знаний модели, а не из базы знаний',
  confidence_level_too_low: 'Движок сам оценил ответ как слабый',
  below_min_confidence: 'Уверенность ниже порога из настроек',
};

export interface AutoAnswerSettings {
  enabled: boolean;
  minConfidence: number;
}

/**
 * Поля результата движка, от которых зависит решение о доставке, — и ничего
 * сверх них.
 *
 * Намеренно структурный тип, а не `EnhancedAnswerResult`: этот модуль читает и
 * браузер, а `import type` из движка (который тянет Prisma и SDK моделей)
 * держится ровно на одном слове `type` — той самой хрупкости, о которой
 * предупреждает шапка файла. `EnhancedAnswerResult` структурно подходит сюда,
 * поэтому ни одно место вызова не меняется.
 */
export interface DeliverableAnswer {
  confidence: number;
  confidenceLevel: 'high' | 'medium' | 'low' | 'insufficient';
  requiresHumanReview?: boolean;
  answerSource?: AnswerSource;
  /** Уточнение сценарного шлюза: промпт + варианты. Здесь важен только факт наличия. */
  scenarioClarification?: unknown;
}

/**
 * Что именно помешало отправить ответ. `null` — ничто не помешало.
 *
 * Это ЕДИНСТВЕННАЯ реализация условий: `shouldAutoAnswer` теперь спрашивает её,
 * а не повторяет проверки. Иначе объяснение разошлось бы с решением, которое
 * оно объясняет, — та же болезнь, что была у песочницы со второй копией
 * политики, только незаметнее.
 *
 * Причина нужна оператору: без неё «передано оператору» одинаково выглядит и
 * когда ответ плох, и когда просто выключен тумблер автоответа. Это два разных
 * вывода и два разных следующих действия.
 *
 * Уровень уверенности — главный шлюз, а не сырой скор: уровень уже складывает
 * качество retrieval и совпадение с одобренной оператором парой, тогда как
 * сырой скор недооценивает сильное совпадение с QAPair. `minConfidence`
 * остаётся явным полом, который оператор может поднять.
 */
export function explainAutoAnswer(
  result: DeliverableAnswer,
  settings: AutoAnswerSettings
): AutoAnswerBlocker | null {
  if (!settings.enabled) return 'auto_answer_disabled';
  if (result.requiresHumanReview) return 'human_review_required';
  if (result.answerSource === 'general_ai') return 'general_ai_source';
  if (result.confidenceLevel === 'low' || result.confidenceLevel === 'insufficient') {
    return 'confidence_level_too_low';
  }
  if (result.confidence < settings.minConfidence) return 'below_min_confidence';
  return null;
}

export function shouldAutoAnswer(
  result: DeliverableAnswer,
  settings: AutoAnswerSettings
): boolean {
  return explainAutoAnswer(result, settings) === null;
}

/**
 * Only the scenario decision gate produces a clarification the user can act on
 * (a prompt plus inline-keyboard options). A bare `needsClarification` flag has
 * no prompt attached — the engine is merely signalling it is unsure, and that
 * answer must still pass the confidence gate instead of slipping past it.
 */
export function shouldSendClarification(result: DeliverableAnswer): boolean {
  return Boolean(result.scenarioClarification);
}

/**
 * Single source of truth for the delivery decision. The text, voice and
 * scenario-callback paths all route through this so they cannot drift apart.
 *
 * A clarification ships regardless of the auto-answer toggle: it is a question
 * back to the user, not a factual claim, and escalating it instead sends the
 * question to the one person who cannot answer it.
 */
export function decideDelivery(
  result: DeliverableAnswer,
  settings: AutoAnswerSettings
): DeliveryDecision {
  if (shouldSendClarification(result)) return 'clarify';
  return shouldAutoAnswer(result, settings) ? 'answer' : 'escalate';
}

/**
 * Подменяется ли текст ответа для этой аудитории.
 *
 * Единственная реализация правила: клиенту нельзя показывать черновик, который
 * политика только что забраковала. Уточняющий вопрос подменять нечем и незачем —
 * это вопрос собеседнику, а не утверждение о фактах, поэтому только `escalate`.
 */
export function isAnswerWithheld(
  decision: DeliveryDecision,
  audience: 'internal' | 'client'
): boolean {
  return decision === 'escalate' && audience === 'client';
}

/**
 * Что видит клиент вместо забракованного черновика.
 *
 * Не извинение и не «в базе нет данных»: цель клиентского контура — привести
 * человека в бюро, а не отчитаться о своём устройстве. Поэтому обещание
 * персонального ответа и удержание контакта.
 */
export const CLIENT_HOLDING_ANSWER =
  'Уточню детали по вашему вопросу у коллеги и вернусь с точным ответом — обычно это занимает несколько минут. ' +
  'Чтобы не терять время, пришлите, пожалуйста, скан или фото документа: так я сразу назову стоимость и срок.';
