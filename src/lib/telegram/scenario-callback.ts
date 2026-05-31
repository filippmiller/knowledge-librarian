// Handler for inline-keyboard clicks on scenario-clarification prompts.
//
// Deterministic flow (no LLM follow-up detection in the hot path):
//  1. Bot sends "Какой документ?" with buttons (callback_data = "sc:<optId>").
//     In the saved ASSISTANT message metadata we stored both:
//       - scenarioClarification.options: the list that resolves optId → label
//       - originalQuestion: the user's first question in this clarification run
//  2. User clicks → webhook → handleScenarioCallback here.
//  3. We read the last ASSISTANT's metadata to get originalQuestion and the
//     label of the clicked option.
//  4. We walk forward from originalQuestion's USER message and collect every
//     USER message since — those are the accumulated clarification clicks,
//     PLUS the current click's label.
//  5. Build effective query = `${originalQuestion}\n\nУточнение: ${chain}`
//     and call answerQuestionEnhanced directly. Same mechanism as the
//     `/api/ask` route's clarificationAnswer path — no LLM heuristics
//     involved in chain reconstruction.
//  6. Re-send as inline keyboard (if still clarifying) or plain answer.

import prisma from '@/lib/db';
import {
  getOrCreateSession,
  saveChatMessage,
} from '@/lib/ai/answering-engine';
import {
  answerQuestionEnhanced,
  type EnhancedAnswerResult,
} from '@/lib/ai/enhanced-answering-engine';
import { sendMessage, sendInlineKeyboard } from './telegram-api';
import { formatAnswerResponse } from './commands';
import type { TelegramUserInfo } from './access-control';

type ClarificationMeta = {
  atNodeKey?: string;
  options?: Array<{ id: string; label: string; targetScenarioKey: string }>;
};
type AssistantMeta = {
  scenarioClarification?: ClarificationMeta;
  originalQuestion?: string;
  /** ISO timestamp of the USER message that started this clarification run.
   *  Used to collect all USER messages since, forming the full chain. */
  originalQuestionAt?: string;
} | null;

export async function handleScenarioCallback(
  chatId: number,
  telegramId: string,
  optionId: string,
  _user: TelegramUserInfo
): Promise<void> {
  const session = await getOrCreateSession('TELEGRAM', telegramId);

  // Find the most recent ASSISTANT messages and pick the first one that has
  // a scenarioClarification in metadata — that's the one this click answers.
  // Keeping the filter out of Prisma avoids JSONB path-syntax pitfalls.
  const recentAssts = await prisma.chatMessage.findMany({
    where: { sessionId: session.id, role: 'ASSISTANT' },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  const lastClarifyingAsst = recentAssts.find((m) => {
    const meta = m.metadata as AssistantMeta;
    return Boolean(meta?.scenarioClarification?.options?.length);
  });

  if (!lastClarifyingAsst) {
    await sendMessage(
      chatId,
      'Не нашёл контекст для этого варианта. Пожалуйста, задайте вопрос заново.'
    );
    return;
  }

  const meta = lastClarifyingAsst.metadata as AssistantMeta;
  const options = meta?.scenarioClarification?.options ?? [];
  const clickedOption = options.find((o) => o.id === optionId);
  const clickedLabel = clickedOption?.label ?? optionId;

  // Save the click as a USER message. Must happen BEFORE building the chain
  // so the current click ends up in it.
  await saveChatMessage(session.id, 'USER', clickedLabel);

  // Resolve the anchor for this clarification run: either the explicit
  // timestamp stored when we started the run, or a best-effort fallback to
  // the oldest USER message in the session (for pre-finale message metadata).
  let originalAt: Date | null = meta?.originalQuestionAt
    ? new Date(meta.originalQuestionAt)
    : null;
  let original = meta?.originalQuestion;
  if (!originalAt || !original) {
    const firstUser = await prisma.chatMessage.findFirst({
      where: { sessionId: session.id, role: 'USER' },
      orderBy: { createdAt: 'asc' },
    });
    if (firstUser) {
      originalAt ??= firstUser.createdAt;
      original ??= firstUser.content;
    }
  }
  if (!original || !originalAt) {
    // Nothing to anchor on — answer the click alone and move on.
    original = clickedLabel;
    originalAt = new Date(0);
  }

  const effectiveQuestion = await buildClarificationQuery(session.id, original, originalAt);

  const result = await answerQuestionEnhanced(effectiveQuestion, session.id);

  // Persist ASSISTANT with the same anchor threaded forward so the next
  // click (if any) still has the original-question timestamp to rebuild
  // against. Same shape as the initial handleQuestion save.
  await saveChatMessage(session.id, 'ASSISTANT', result.answer, {
    confidence: result.confidence,
    confidenceLevel: result.confidenceLevel,
    scenarioKey: result.scenarioKey,
    scenarioClarification: result.scenarioClarification,
    originalQuestion: original,
    originalQuestionAt: originalAt.toISOString(),
  });

  await sendClarificationOrAnswer(chatId, result);
}

/**
 * Effective query for a clarification run = the original question + the chain of
 * every USER message since the anchor (all accumulated clarification replies,
 * whether tapped as buttons or typed as free text). Single source of truth for
 * both the button path (handleScenarioCallback) and the typed-reply path
 * (handleQuestion).
 */
export async function buildClarificationQuery(
  sessionId: string,
  original: string,
  originalAt: Date
): Promise<string> {
  const chainMsgs = await prisma.chatMessage.findMany({
    where: { sessionId, role: 'USER', createdAt: { gt: originalAt } },
    orderBy: { createdAt: 'asc' },
    select: { content: true },
  });
  const chain = chainMsgs.map((m) => m.content).join(' → ');
  return chain ? `${original}\n\nУточнение пользователя: ${chain}` : original;
}

/**
 * If the LATEST assistant turn in the session is an unanswered scenario
 * clarification, return its anchor (original question + timestamp); else null.
 * Used by the typed-reply path to detect "the user is answering my last
 * clarification with text instead of tapping a button".
 */
export async function getPendingClarificationAnchor(
  sessionId: string
): Promise<{ original: string; originalAt: Date } | null> {
  const lastAsst = await prisma.chatMessage.findFirst({
    where: { sessionId, role: 'ASSISTANT' },
    orderBy: { createdAt: 'desc' },
  });
  const meta = lastAsst?.metadata as AssistantMeta;
  if (!meta?.scenarioClarification?.options?.length) return null;

  let originalAt: Date | null = meta.originalQuestionAt ? new Date(meta.originalQuestionAt) : null;
  let original: string | undefined = meta.originalQuestion;
  if (!original || !originalAt) {
    const firstUser = await prisma.chatMessage.findFirst({
      where: { sessionId, role: 'USER' },
      orderBy: { createdAt: 'asc' },
    });
    if (firstUser) {
      originalAt ??= firstUser.createdAt;
      original ??= firstUser.content;
    }
  }
  if (!original || !originalAt) return null;
  return { original, originalAt };
}

/** Send a result to the chat: inline keyboard if clarification, plain
 *  formatted message otherwise. */
export async function sendClarificationOrAnswer(
  chatId: number,
  result: EnhancedAnswerResult
): Promise<void> {
  if (result.scenarioClarification) {
    const buttons = result.scenarioClarification.options.map((o) => ({
      text: o.label,
      // callback_data is limited to 64 bytes; option IDs are short ("notary",
      // "zags", "spb", "lo") so "sc:<id>" stays well under the limit.
      callback_data: `sc:${o.id}`,
    }));
    await sendInlineKeyboard(chatId, result.scenarioClarification.prompt, buttons);
    return;
  }
  await sendMessage(chatId, formatAnswerResponse(result));
}
