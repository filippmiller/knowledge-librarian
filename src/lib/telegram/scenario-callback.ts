// Handler for inline-keyboard clicks on scenario-clarification prompts.
//
// Flow:
//  1. Bot sends "Какой документ?" with buttons, each callback_data = "sc:<optionId>".
//  2. User clicks → Telegram → webhook → handleCallback → here.
//  3. We look up which scenario node the bot was asking at (stored in the
//     most recent ASSISTANT message metadata), find the matching option, and
//     re-query answerWithContext(). The engine's follow-up detector sees the
//     conversation history and expands the short label into a full question.
//  4. Response: either another clarification (next level of the tree) or a
//     scenario_clear answer. Either way, we send it with inline keyboard
//     again if still clarifying.

import prisma from '@/lib/db';
import {
  getOrCreateSession,
  saveChatMessage,
} from '@/lib/ai/answering-engine';
import {
  answerWithContext,
  type EnhancedAnswerResult,
} from '@/lib/ai/enhanced-answering-engine';
import { sendMessage, sendInlineKeyboard } from './telegram-api';
import { formatAnswerResponse } from './commands';
import type { TelegramUserInfo } from './access-control';

export async function handleScenarioCallback(
  chatId: number,
  telegramId: string,
  optionId: string,
  _user: TelegramUserInfo
): Promise<void> {
  const session = await getOrCreateSession('TELEGRAM', telegramId);

  // The last ASSISTANT message should carry the clarification metadata:
  // { scenarioClarification: { atNodeKey, options: [...] } }. We match
  // optionId against options to find its label and target scenarioKey.
  const lastAssistant = await prisma.chatMessage.findFirst({
    where: { sessionId: session.id, role: 'ASSISTANT' },
    orderBy: { createdAt: 'desc' },
  });

  let optionLabel: string | undefined;
  const metadata = lastAssistant?.metadata as {
    scenarioClarification?: {
      atNodeKey: string;
      options: Array<{ id: string; label: string; targetScenarioKey: string }>;
    };
  } | null;
  if (metadata?.scenarioClarification?.options) {
    const match = metadata.scenarioClarification.options.find((o) => o.id === optionId);
    if (match) optionLabel = match.label;
  }

  // Fallback: if we can't resolve from metadata (session old, restart, etc.),
  // use the optionId as-is — gate will still handle the accumulated context.
  const labelToUse = optionLabel ?? optionId;

  // Save click as a user message so answerWithContext's follow-up detector
  // can include it in the expanded query.
  await saveChatMessage(session.id, 'USER', labelToUse);

  const result = await answerWithContext(labelToUse, session.id);

  // Persist the assistant message with scenarioClarification in metadata so
  // the NEXT click (if any) can resolve its options too.
  await saveChatMessage(session.id, 'ASSISTANT', result.answer, {
    confidence: result.confidence,
    confidenceLevel: result.confidenceLevel,
    scenarioKey: result.scenarioKey,
    scenarioClarification: result.scenarioClarification,
  });

  await sendClarificationOrAnswer(chatId, result);
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
      // callback_data is limited to 64 bytes; option IDs are short (e.g.
      // "notary", "zags", "spb") so "sc:<id>" stays well under the limit.
      callback_data: `sc:${o.id}`,
    }));
    await sendInlineKeyboard(chatId, result.scenarioClarification.prompt, buttons);
    return;
  }
  await sendMessage(chatId, formatAnswerResponse(result));
}
