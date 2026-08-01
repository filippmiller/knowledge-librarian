import prisma from '@/lib/db';
import type { EnhancedAnswerResult } from '@/lib/ai/enhanced-answering-engine';
import { sendInlineKeyboard, sendMessage } from './telegram-api';
import { getAdminTelegramIds } from './access-control';
import { DEFAULT_MIN_CONFIDENCE } from './constants';
import type { AutoAnswerBlocker, DeliveryDecision } from '@/lib/ai/delivery-decision';

export interface AutoAnswerSettings {
  enabled: boolean;
  minConfidence: number;
}

/**
 * Что бот делает с результатом движка. Сам тип живёт в отдельном модуле без
 * зависимостей: его импортирует и браузер, а этот модуль ходит в базу.
 * Реэкспорт оставлен, чтобы не переписывать десяток мест вызова.
 */
export type { DeliveryDecision };

export { DEFAULT_MIN_CONFIDENCE };

/**
 * Decide whether the bot may answer a user question automatically.
 *
 * The engine's confidence LEVEL is the primary gate, not the raw score: the
 * level already folds retrieval quality and operator-approved Q&A matches
 * together, while the raw score under-reports a strong QAPair match (it
 * carries only the term-overlap value). `minConfidence` stays as an explicit
 * floor an operator can raise, applied on top of the level check.
 *
 * Even when enabled, we NEVER auto-answer if:
 * - human review is required,
 * - the answer came from general AI knowledge (unverified),
 * - the engine rated its own answer low/insufficient.
 */
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
 */
export function explainAutoAnswer(
  result: EnhancedAnswerResult,
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
  result: EnhancedAnswerResult,
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
export function shouldSendClarification(result: EnhancedAnswerResult): boolean {
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
  result: EnhancedAnswerResult,
  settings: AutoAnswerSettings
): DeliveryDecision {
  if (shouldSendClarification(result)) return 'clarify';
  return shouldAutoAnswer(result, settings) ? 'answer' : 'escalate';
}

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
