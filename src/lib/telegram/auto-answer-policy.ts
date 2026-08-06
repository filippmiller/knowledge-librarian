import prisma from '@/lib/db';
import type { EnhancedAnswerResult } from '@/lib/ai/enhanced-answering-engine';
import { sendInlineKeyboard, sendMessage } from './telegram-api';
import { getAdminTelegramIds } from './access-control';
import { DEFAULT_MIN_CONFIDENCE } from './constants';
import {
  type AutoAnswerSettings,
  type DeliveryDecision,
} from '@/lib/ai/delivery-decision';

/**
 * Само РЕШЕНИЕ о доставке живёт в отдельном модуле без зависимостей
 * (`@/lib/ai/delivery-decision`): его читает и браузер, и золотой корпус, а
 * этот модуль ходит в базу и в Telegram. Реэкспорт оставлен, чтобы не
 * переписывать десяток мест вызова.
 */
export {
  decideDelivery,
  explainAutoAnswer,
  shouldAutoAnswer,
  shouldSendClarification,
  isAnswerWithheld,
} from '@/lib/ai/delivery-decision';
export type { AutoAnswerSettings, DeliveryDecision };

export { DEFAULT_MIN_CONFIDENCE };

export async function getAutoAnswerSettings(): Promise<AutoAnswerSettings> {
  try {
    const settings = await prisma.aISettings.findFirst({
      where: { isActive: true },
      select: { autoAnswerEnabled: true, autoAnswerMinConfidence: true },
    });
    if (!settings) {
      // A missing row is a deployment gap, not an operator decision, and it
      // silently mutes the bot completely. Fail closed, but say so loudly.
      console.warn(
        '[auto-answer-policy] No active AISettings row — auto-answer is OFF, every question goes to an operator. Create the row at /admin/ai-settings.'
      );
      return { enabled: false, minConfidence: DEFAULT_MIN_CONFIDENCE };
    }
    return {
      enabled: settings.autoAnswerEnabled,
      minConfidence: settings.autoAnswerMinConfidence,
    };
  } catch (error) {
    console.warn('[auto-answer-policy] Failed to load settings, defaulting to disabled:', error);
    return { enabled: false, minConfidence: DEFAULT_MIN_CONFIDENCE };
  }
}

/**
 * Escalate a question to human operators instead of sending an AI answer.
 * Notifies admins and tells the user their question was forwarded.
 */
export async function escalateToHuman(
  chatId: number,
  question: string,
  result: EnhancedAnswerResult,
  userTelegramId: string,
  /**
   * Идентификатор записи об удержании. С ним под сообщением появляются кнопки
   * вердикта: без ответа человека «был ли черновик верен» нельзя отличить
   * контроль, спасший клиента, от контроля, отнявшего верный ответ.
   */
  heldAnswerId?: string | null
): Promise<void> {
  const adminIds = await getAdminTelegramIds();
  const confidenceLabel = `${Math.round(result.confidence * 100)}% (${result.confidenceLevel})`;
  const sourceLabel = result.answerSource ?? 'unknown';

  const adminMessage = [
    '🔔 Вопрос передан оператору (автоответ отключён или уверенность низкая)',
    '',
    `👤 От пользователя: ${userTelegramId}`,
    `📊 Уверенность: ${confidenceLabel}`,
    `📚 Источник: ${sourceLabel}`,
    '',
    `❓ Вопрос:\n${question}`,
    '',
    `🤖 Черновик ответа ИИ:\n${result.answer.slice(0, 1200)}`,
  ].join('\n');

  for (const adminId of adminIds) {
    if (adminId === userTelegramId) continue;
    try {
      if (heldAnswerId) {
        // Вердикт спрашивается ОДНОЙ кнопкой и прямо здесь: оператор уже читает
        // черновик, и это единственный момент, когда его вывод стоит дёшево.
        // Отдельная страница для разметки не будет открыта никогда.
        await sendInlineKeyboard(Number(adminId), adminMessage, [
          { text: '✅ Черновик был верен', callback_data: `hv:correct:${heldAnswerId}` },
          { text: '❌ Черновик был неверен', callback_data: `hv:wrong:${heldAnswerId}` },
          { text: '➖ Неполон', callback_data: `hv:partial:${heldAnswerId}` },
        ]);
      } else {
        await sendMessage(Number(adminId), adminMessage);
      }
    } catch {
      // Skip unreachable admins
    }
  }

  await sendMessage(
    chatId,
    'Передал ваш вопрос коллеге — он разберётся и ответит вам лично. Обычно это занимает несколько минут.'
  );
}
