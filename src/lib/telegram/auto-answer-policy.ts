import prisma from '@/lib/db';
import type { EnhancedAnswerResult } from '@/lib/ai/enhanced-answering-engine';
import { sendMessage } from './telegram-api';
import { getAdminTelegramIds } from './access-control';
import { DEFAULT_MIN_CONFIDENCE } from './constants';

export interface AutoAnswerSettings {
  enabled: boolean;
  minConfidence: number;
}

/** What the bot does with an engine result on Telegram. */
export type DeliveryDecision = 'clarify' | 'answer' | 'escalate';

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
export function shouldAutoAnswer(
  result: EnhancedAnswerResult,
  settings: AutoAnswerSettings
): boolean {
  if (!settings.enabled) return false;
  if (result.requiresHumanReview) return false;
  if (result.answerSource === 'general_ai') return false;
  if (result.confidenceLevel === 'low' || result.confidenceLevel === 'insufficient') return false;
  return result.confidence >= settings.minConfidence;
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
  userTelegramId: string
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
      await sendMessage(Number(adminId), adminMessage);
    } catch {
      // Skip unreachable admins
    }
  }

  await sendMessage(
    chatId,
    'Передал ваш вопрос коллеге — он разберётся и ответит вам лично. Обычно это занимает несколько минут.'
  );
}
