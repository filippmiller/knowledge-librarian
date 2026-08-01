/**
 * Учёт удержанных ответов и вердиктов человека о них.
 *
 * НЕДОСТАЮЩИЙ КОНТУР. Восемь контролей качества удерживают ответы, но узнать,
 * спасли они клиента или отняли верный ответ, было нечем. Оператор разбирал
 * эскалацию, а его вывод никуда не записывался. Частота срабатывания контроля
 * не отличает верную тревогу от ложной: контроль, сработавший сто раз, может
 * быть и лучшей защитой системы, и худшим её тормозом — по частоте это
 * неразличимо.
 *
 * Пока этой записи не было, любое решение «ослабить контроль» или «добавить
 * контроль» принималось вслепую. Замер показал 14 удержаний из 156 ответов, и
 * ни об одном нельзя было сказать, был ли черновик верен. Найдено независимым
 * аудитом Kimi K3.
 *
 * Запись делается в момент удержания, вердикт проставляется позже — одной
 * кнопкой под сообщением об эскалации.
 */
import prisma from '@/lib/db';
import type { EnhancedAnswerResult } from '@/lib/ai/enhanced-answering-engine';
import type { AutoAnswerBlocker, DeliveryDecision } from '@/lib/ai/delivery-decision';
import type { ReasonDetail } from '@/lib/ai/answer-reasons';

export type HeldVerdict = 'correct' | 'wrong' | 'partial';

export function isHeldVerdict(value: unknown): value is HeldVerdict {
  return value === 'correct' || value === 'wrong' || value === 'partial';
}

export const HELD_VERDICT_LABELS: Record<HeldVerdict, string> = {
  correct: 'черновик был верен — удержали зря',
  wrong: 'черновик был неверен — удержали правильно',
  partial: 'черновик был неполон',
};

/**
 * Записать удержанный ответ.
 *
 * Возвращает идентификатор строки или `null`, если запись не удалась: учёт —
 * это наблюдение, и оно не имеет права ломать ответ собеседнику.
 *
 * Причины берутся из `debug.reasons` и потому требуют `includeDebug`. Где его
 * нет, список окажется пустым — это честнее, чем пересчитывать контроли второй
 * раз и получить объяснение, разошедшееся с решением.
 */
export async function recordHeldAnswer(params: {
  question: string;
  result: EnhancedAnswerResult;
  audience: 'client' | 'internal';
  source: 'API' | 'TELEGRAM' | 'MINI_APP';
  delivery: DeliveryDecision;
  blocker: AutoAnswerBlocker | null;
  draftAnswer: string;
  sessionId?: string | null;
}): Promise<string | null> {
  try {
    const reasons: ReasonDetail[] = params.result.debug?.reasons?.humanReview ?? [];
    const row = await prisma.heldAnswer.create({
      data: {
        question: params.question.slice(0, 4000),
        draftAnswer: params.draftAnswer.slice(0, 8000),
        audience: params.audience,
        source: params.source,
        delivery: params.delivery,
        blocker: params.blocker ?? null,
        reasons: reasons as unknown as object,
        confidence: params.result.confidence,
        confidenceLevel: params.result.confidenceLevel,
        answerSource: params.result.answerSource ?? null,
        sessionId: params.sessionId ?? null,
      },
      select: { id: true },
    });
    return row.id;
  } catch (e) {
    console.warn('[held-answers] запись удержанного ответа не удалась:', e);
    return null;
  }
}

/** Проставить вердикт человека. Повторный вердикт перезаписывает прежний. */
export async function setHeldVerdict(
  id: string,
  verdict: HeldVerdict,
  by: string,
  comment?: string
): Promise<boolean> {
  try {
    await prisma.heldAnswer.update({
      where: { id },
      data: { verdict, verdictBy: by, verdictAt: new Date(), comment: comment ?? null },
    });
    return true;
  } catch (e) {
    console.warn('[held-answers] вердикт не записан:', e);
    return false;
  }
}
