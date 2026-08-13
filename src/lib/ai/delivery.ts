import type { EnhancedAnswerResult } from '@/lib/ai/enhanced-answering-engine';
import type { Audience } from '@/lib/knowledge/audience';
import { getAutoAnswerSettings } from '@/lib/telegram/auto-answer-policy';
import {
  CLIENT_HOLDING_ANSWER,
  decideDelivery,
  explainAutoAnswer,
  isAnswerWithheld,
  type AutoAnswerBlocker,
  type DeliveryDecision,
} from '@/lib/ai/delivery-decision';

/**
 * Реэкспорт: текст удержания переехал в `delivery-decision` вместе с правилом,
 * которое решает, когда его подставлять, — чтобы у золотого корпуса и тестов
 * был доступ к обоим без Prisma.
 */
export { CLIENT_HOLDING_ANSWER };

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
  /**
   * Что помешало отправить ответ. `null` — ничто.
   *
   * Без этого «передано оператору» одинаково выглядит и когда ответ плох, и
   * когда просто выключен тумблер автоответа. Это два разных вывода и два
   * разных следующих действия оператора.
   */
  blocker: AutoAnswerBlocker | null;
}

export async function resolveDelivery(
  result: EnhancedAnswerResult,
  audience: Audience
): Promise<DeliveryOutcome> {
  const settings = await getAutoAnswerSettings();
  const decision = decideDelivery(result, settings);
  // Причина спрашивается у той же политики, а не выводится заново. Уточняющий
  // вопрос помехой не является: он уходит собеседнику независимо от тумблера.
  const blocker = decision === 'clarify' ? null : explainAutoAnswer(result, settings);
  const draftAnswer = result.answer;

  // Уточняющий вопрос — это вопрос клиенту, а не утверждение о фактах: его
  // подменять нечем и незачем. Само правило — в `delivery-decision`, единственной
  // реализацией: тот же предикат спрашивает золотой корпус, вычисляя, увидел бы
  // клиент этот текст вообще.
  const withheld = isAnswerWithheld(decision, audience);

  return {
    decision,
    draftAnswer,
    outboundAnswer: withheld ? CLIENT_HOLDING_ANSWER : draftAnswer,
    withheld,
    blocker,
  };
}

/**
 * Собрать тело ответа API так, чтобы наивный потребитель не смог отправить
 * клиенту то, что отправлять нельзя: поле `answer` уже безопасно для своей
 * аудитории, а решение приложено явно.
 */
export function applyDelivery(
  result: EnhancedAnswerResult,
  outcome: DeliveryOutcome,
  opts: {
    /**
     * Прикладывать ли черновик. Только для авторизованного сотрудника: отдать
     * его анониму значит вернуть тем же ответом текст, который мы только что
     * признали для него недопустимым, — тогда подмена превращается в косметику.
     */
    includeDraft: boolean;
  }
): EnhancedAnswerResult & {
  delivery: DeliveryDecision;
  draftAnswer?: string;
  answerWithheld: boolean;
  deliveryBlocker?: AutoAnswerBlocker | null;
} {
  return {
    ...result,
    answer: outcome.outboundAnswer,
    delivery: outcome.decision,
    ...(opts.includeDraft ? { draftAnswer: outcome.draftAnswer } : {}),
    answerWithheld: outcome.withheld,
    // Причина решения — рядом с решением и по тем же правилам, что черновик:
    // анониму она не нужна и способна рассказать о внутренних настройках.
    ...(opts.includeDraft ? { deliveryBlocker: outcome.blocker } : {}),
  };
}
