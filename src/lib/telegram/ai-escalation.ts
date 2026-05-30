import type { EnhancedAnswerResult } from '@/lib/ai/enhanced-answering-engine';
import prisma from '@/lib/db';
import { sendMessage, sendInlineKeyboard } from './telegram-api';
import { createKnowledgeGapSuggestion } from '@/lib/ai/knowledge-feedback';

const NOTIFICATION_THROTTLE_MS = 10 * 60 * 1000;
const recentNotifications = new Map<string, number>();

export async function escalateUnconvincingAIAnswer(params: {
  question: string;
  result: EnhancedAnswerResult;
  source: 'WEB' | 'TELEGRAM' | 'API';
  userId?: string;
  sessionId?: string;
}): Promise<void> {
  // Self-improving loop: capture low-trust answers as draft Q→A pairs for admin
  // approval. When a draft is created, send super-admins an actionable
  // Approve/Reject message (it replaces the generic escalation notice).
  const gapId = await createKnowledgeGapSuggestion({
    question: params.question,
    result: params.result,
    source: params.source,
    sessionId: params.sessionId,
  });
  if (gapId) {
    await sendKnowledgeGapForApproval(gapId, params.question, params.result.answer);
    return;
  }

  const reasons = getEscalationReasons(params.result);
  if (reasons.length === 0) return;

  const throttleKey = `${params.source}:${normalizeThrottleKey(params.question)}:${reasons.join(',')}`;
  const lastSentAt = recentNotifications.get(throttleKey) ?? 0;
  if (Date.now() - lastSentAt < NOTIFICATION_THROTTLE_MS) return;
  recentNotifications.set(throttleKey, Date.now());

  let aiQuestionId: string | undefined;
  try {
    const aiQuestion = await prisma.aIQuestion.create({
      data: {
        issueType: 'unconvincing_ai_answer',
        question: params.question,
        context: {
          source: params.source,
          userId: params.userId,
          sessionId: params.sessionId,
          reasons,
          answer: params.result.answer.slice(0, 2000),
          confidence: params.result.confidence,
          confidenceLevel: params.result.confidenceLevel,
          needsClarification: params.result.needsClarification,
          answerSource: params.result.answerSource,
          requiresHumanReview: params.result.requiresHumanReview,
          citations: params.result.citations,
          scenarioKey: params.result.scenarioKey,
          scenarioLabel: params.result.scenarioLabel,
        },
      },
    });
    aiQuestionId = aiQuestion.id;
  } catch (error) {
    console.warn('[ai-escalation] Failed to create AIQuestion:', error);
  }

  const superAdminIds = await getSuperAdminTelegramIds();
  if (superAdminIds.length === 0) return;

  const message = buildSuperAdminMessage({
    ...params,
    reasons,
    aiQuestionId,
  });

  await Promise.all(superAdminIds.map((telegramId) => sendMessage(Number(telegramId), message)));
}

function getEscalationReasons(result: EnhancedAnswerResult): string[] {
  const reasons: string[] = [];
  if (result.confidenceLevel === 'low' || result.confidenceLevel === 'insufficient') {
    reasons.push(`низкая уверенность: ${result.confidenceLevel}`);
  }
  if (result.needsClarification || result.clarificationQuestion || result.scenarioClarification) {
    reasons.push('ИИ запросил уточнение');
  }
  if (result.answerSource === 'general_ai') {
    reasons.push('ответ из общего знания ИИ');
  }
  if (result.requiresHumanReview) {
    reasons.push('нужна ручная проверка');
  }
  const hasSource =
    result.citations.length > 0 ||
    !!result.primarySource;
  if (!hasSource) reasons.push('нет убедительного источника');
  return reasons;
}

async function sendKnowledgeGapForApproval(
  id: string,
  question: string,
  draftAnswer: string
): Promise<void> {
  const superAdminIds = await getSuperAdminTelegramIds();
  if (superAdminIds.length === 0) return;
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
  const text = [
    '🆕 Черновик правила на утверждение',
    '',
    `❓ Вопрос: ${question}`,
    '',
    '💬 Ответ (из общих знаний ИИ — проверьте!):',
    draftAnswer.slice(0, 1500),
    '',
    appUrl ? `✏️ Поправить текст: ${appUrl}/admin/ai-questions` : '',
    'Утвердить = сохранить в базу как пару «вопрос-ответ».',
  ].filter(Boolean).join('\n');
  const buttons = [
    { text: '✅ Утвердить', callback_data: `kg:approve:${id}` },
    { text: '✖️ Отклонить', callback_data: `kg:reject:${id}` },
  ];
  await Promise.all(superAdminIds.map((tid) => sendInlineKeyboard(Number(tid), text, buttons)));
}

async function getSuperAdminTelegramIds(): Promise<string[]> {
  const dbSuperAdmins = await prisma.telegramUser.findMany({
    where: { isActive: true, role: 'SUPER_ADMIN' },
    select: { telegramId: true },
  });
  const ids = dbSuperAdmins.map((admin) => admin.telegramId);
  const envSuperAdmin = process.env.TELEGRAM_SUPER_ADMIN;
  if (envSuperAdmin && !ids.includes(envSuperAdmin)) ids.push(envSuperAdmin);
  return ids;
}

function buildSuperAdminMessage(params: {
  question: string;
  result: EnhancedAnswerResult;
  source: 'WEB' | 'TELEGRAM' | 'API';
  userId?: string;
  sessionId?: string;
  reasons: string[];
  aiQuestionId?: string;
}): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  const adminLink = appUrl && params.aiQuestionId
    ? `${appUrl.replace(/\/$/, '')}/admin/ai-questions`
    : undefined;

  return [
    'Требуется проверка ответа ИИ',
    '',
    `Причина: ${params.reasons.join('; ')}`,
    `Источник: ${params.source}${params.userId ? ` / ${params.userId}` : ''}`,
    params.sessionId ? `Сессия: ${params.sessionId}` : undefined,
    params.aiQuestionId ? `AIQuestion: ${params.aiQuestionId}` : undefined,
    adminLink ? `Админка: ${adminLink}` : undefined,
    '',
    `Вопрос: ${params.question}`,
    '',
    `Ответ: ${params.result.answer.slice(0, 1200)}`,
    '',
    params.result.answerSource ? `Источник ответа: ${params.result.answerSource}` : undefined,
    `Уверенность: ${Math.round(params.result.confidence * 100)}% (${params.result.confidenceLevel})`,
  ].filter(Boolean).join('\n');
}

function normalizeThrottleKey(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim().slice(0, 200);
}
