import prisma from '@/lib/db';
import type { EnhancedAnswerResult } from '@/lib/ai/enhanced-answering-engine';
import { sendMessage } from './telegram-api';
import { getAdminTelegramIds } from './access-control';

export interface AutoAnswerSettings {
  enabled: boolean;
  minConfidence: number;
}

/**
 * Decide whether the bot may answer a user question automatically.
 *
 * Even when enabled, we NEVER auto-answer if:
 * - the engine asked for clarification,
 * - human review is required,
 * - the answer came from general AI knowledge (unverified),
 * - confidence is below the configured threshold.
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

export function shouldSendClarification(result: EnhancedAnswerResult): boolean {
  return Boolean(result.needsClarification || result.scenarioClarification);
}

export async function getAutoAnswerSettings(): Promise<AutoAnswerSettings> {
  try {
    const settings = await prisma.aISettings.findFirst({
      where: { isActive: true },
      select: { autoAnswerEnabled: true, autoAnswerMinConfidence: true },
    });
    return {
      enabled: settings?.autoAnswerEnabled ?? false,
      minConfidence: settings?.autoAnswerMinConfidence ?? 0.7,
    };
  } catch (error) {
    console.warn('[auto-answer-policy] Failed to load settings, defaulting to disabled:', error);
    return { enabled: false, minConfidence: 0.7 };
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
