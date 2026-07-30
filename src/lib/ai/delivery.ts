import type { EnhancedAnswerResult } from '@/lib/ai/enhanced-answering-engine';
import type { Audience } from '@/lib/knowledge/audience';
import {
  decideDelivery,
  getAutoAnswerSettings,
  type DeliveryDecision,
} from '@/lib/telegram/auto-answer-policy';

/**
 * Одна политика доставки на все каналы.
 *
 * Раньше решение о том, можно ли отдать ответ наружу, применялось ТОЛЬКО в
 * телеграм-ветке. `/api/ask` и мини-приложение отдавали сырой результат движка,
 * и потребитель обязан был сам догадаться его не отправлять. На практике это
 * означало, что интеграция с Битриксом отправила бы платящему клиенту строку
 * «В базе знаний нет данных по этому вопросу» — в замере она возникала три раза
 * из пятнадцати.
 *
 * Поэтому решение принимается здесь и возвращается вместе с ответом, а для
 * клиентского контура текст ответа ПОДМЕНЯЕТСЯ на удерживающий, если движок сам
 * себе не доверяет. Черновик при этом не теряется — он уходит оператору полем
 * `draftAnswer`.
 */
export interface DeliveryOutcome {
  decision: DeliveryDecision;
  /** Текст, который допустимо показать этой аудитории. */
  outboundAnswer: string;
  /** Исходный черновик движка. Для оператора и отладки, не для клиента. */
  draftAnswer: string;
  /** Текст ответа подменён, потому что черновик клиенту показывать нельзя. */
  withheld: boolean;
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

export async function resolveDelivery(
  result: EnhancedAnswerResult,
  audience: Audience
): Promise<DeliveryOutcome> {
  const settings = await getAutoAnswerSettings();
  const decision = decideDelivery(result, settings);
  const draftAnswer = result.answer;

  // Уточняющий вопрос — это вопрос клиенту, а не утверждение о фактах: его
  // подменять нечем и незачем.
  const withheld = decision === 'escalate' && audience === 'client';

  return {
    decision,
    draftAnswer,
    outboundAnswer: withheld ? CLIENT_HOLDING_ANSWER : draftAnswer,
    withheld,
  };
}

/**
 * Собрать тело ответа API так, чтобы наивный потребитель не смог отправить
 * клиенту то, что отправлять нельзя: поле `answer` уже безопасно для своей
 * аудитории, а решение приложено явно.
 */
export function applyDelivery(
  result: EnhancedAnswerResult,
  outcome: DeliveryOutcome
): EnhancedAnswerResult & {
  delivery: DeliveryDecision;
  draftAnswer: string;
  answerWithheld: boolean;
} {
  return {
    ...result,
    answer: outcome.outboundAnswer,
    delivery: outcome.decision,
    draftAnswer: outcome.draftAnswer,
    answerWithheld: outcome.withheld,
  };
}
