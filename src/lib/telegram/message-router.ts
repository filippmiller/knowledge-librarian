import { sendMessage, sendTypingIndicator } from './telegram-api';
import type { TelegramUpdate, TelegramMessage } from './telegram-api';
import { checkAccess, isAdmin, isSuperAdmin } from './access-control';
import type { TelegramUserInfo } from './access-control';
import {
  handleStart,
  handleHelp,
  handleGrant,
  handleRevoke,
  handlePromote,
  handleDemote,
  handleUsers,
  handleAdd,
  handleCorrect,
  handleConfirm,
  handleShow,
  handleEdit,
  handleDelete,
  handleReport,
  handleHelpMe,
  handleQuestion,
} from './commands';
import { handleVoiceMessage } from './voice-handler';
import { handleDocumentUpload } from './document-handler';
import { addKnowledge, correctKnowledge } from './knowledge-manager';
import {
  hasPendingConfirmation,
  handleConfirmationResponse,
  classifyAdminIntent,
  handleSmartAdminAction,
} from './smart-admin';
import prisma from '@/lib/db';
import { ADD_KEYWORDS, CORRECT_KEYWORDS, PRICE_CHANGE_PATTERN, RULE_LOOKUP_PATTERN } from './constants';

/**
 * Main entry point for all Telegram updates.
 * Checks access, then routes to the appropriate handler.
 */
export async function handleUpdate(update: TelegramUpdate): Promise<void> {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;
  const telegramId = message.from?.id?.toString();
  const username = message.from?.username;
  const firstName = message.from?.first_name;

  if (!telegramId) return;

  // Check access
  const accessResult = await checkAccess(telegramId, username, firstName);

  if (!accessResult.allowed) {
    const name = firstName || 'пользователь';
    if (accessResult.reason === 'deactivated') {
      await sendMessage(chatId, `${name}, ваш доступ был отозван. Обратитесь к администратору.`);
    } else {
      await sendMessage(
        chatId,
        `Извините, ${name}, у вас нет доступа к этому боту.\n\n` +
        `Попросите администратора выдать доступ для вашего ID: ${telegramId}`
      );
    }
    console.log(`[telegram] Access denied for ${telegramId} (@${username}): ${accessResult.reason}`);
    return;
  }

  const user = accessResult.user;

  // Route by content type
  try {
    // Voice message — all users can ask questions by voice;
    // admin-only actions (add/correct) are gated inside the handler
    if (message.voice) {
      await handleVoiceMessage(message, user);
      return;
    }

    // Document upload
    if (message.document) {
      if (isAdmin(user.role)) {
        await handleDocumentUpload(message, user);
      } else {
        await sendMessage(chatId, 'Загрузка документов доступна только администраторам.');
      }
      return;
    }

    // Text message
    if (message.text) {
      await routeTextMessage(message, user);
      return;
    }
  } catch (error) {
    console.error('[message-router] Unhandled error:', error);
    await sendMessage(chatId, 'Произошла ошибка. Попробуйте позже.');
  }
}

/**
 * Route text messages: commands vs plain questions.
 *
 * For SUPER_ADMIN:
 *  1. Check pending confirmations first (да/нет response)
 *  2. /commands route as normal
 *  3. Plain text → AI intent classifier → smart action or Q&A fallback
 *
 * For others: commands + Q&A (unchanged)
 */
async function routeTextMessage(message: TelegramMessage, user: TelegramUserInfo): Promise<void> {
  const text = message.text?.trim() || '';
  const chatId = message.chat.id;

  // 1. SUPER_ADMIN pending confirmation intercept
  if (isSuperAdmin(user.role) && hasPendingConfirmation(chatId)) {
    await handleConfirmationResponse(chatId, text, user);
    return;
  }

  // 2. Parse command and arguments
  const commandMatch = text.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);

  if (commandMatch) {
    const command = commandMatch[1].toLowerCase();
    const args = commandMatch[2] || '';

    // Commands available to all users
    switch (command) {
      case 'start':
        return handleStart(message, user);
      case 'help':
        return handleHelp(message, user);
      case 'report':
        return handleReport(message, user, args);
      case 'helpme':
        return handleHelpMe(message, user, args);
    }

    // Admin-only commands
    const adminCommands = ['grant', 'revoke', 'promote', 'demote', 'users', 'add', 'correct', 'confirm', 'show', 'edit', 'delete'];
    if (adminCommands.includes(command)) {
      if (!isAdmin(user.role)) {
        await sendMessage(chatId, 'У вас нет прав для этой команды.');
        return;
      }

      switch (command) {
        case 'grant':
          return handleGrant(message, user, args);
        case 'revoke':
          return handleRevoke(message, user, args);
        case 'promote':
          return handlePromote(message, user, args);
        case 'demote':
          return handleDemote(message, user, args);
        case 'users':
          return handleUsers(message, user);
        case 'add':
          return handleAdd(message, user, args);
        case 'correct':
          return handleCorrect(message, user, args);
        case 'confirm':
          return handleConfirm(message, user, args);
        case 'show':
          return handleShow(message, user, args);
        case 'edit':
          return handleEdit(message, user, args);
        case 'delete':
          return handleDelete(message, user, args);
      }
      return;
    }

    await sendMessage(chatId, `Неизвестная команда: /${command}\n\nИспользуйте /help для списка команд.`);
    return;
  }

  // 3. Admin keyword detection: "сохрани/добавь" and "поменяй/измени" in plain text
  if (isAdmin(user.role)) {
    if (CORRECT_KEYWORDS.test(text) || PRICE_CHANGE_PATTERN.test(text)) {
      await sendTypingIndicator(chatId);
      try {
        const result = await correctKnowledge(text, user.telegramId);
        await sendMessage(chatId, result.summary);
        return;
      } catch (error) {
        console.error('[message-router] correctKnowledge error:', error);
        await sendMessage(chatId, 'Ошибка при обработке команды изменения.');
        return;
      }
    }

    if (ADD_KEYWORDS.test(text)) {
      await sendTypingIndicator(chatId);
      try {
        const knowledgeText = text.replace(ADD_KEYWORDS, '').trim() || text;
        const result = await addKnowledge(knowledgeText, user.telegramId);
        await sendMessage(chatId, result.summary);
        return;
      } catch (error) {
        console.error('[message-router] addKnowledge error:', error);
        await sendMessage(chatId, 'Ошибка при сохранении знания.');
        return;
      }
    }
  }

  // 4. Direct rule lookup: "правило 100", "правило R-100", "покажи правило 100"
  const ruleLookupMatch = text.match(RULE_LOOKUP_PATTERN);
  if (ruleLookupMatch) {
    const ruleCode = `R-${ruleLookupMatch[1]}`;
    const rule = await prisma.rule.findFirst({
      where: { ruleCode, status: 'ACTIVE' },
      select: { ruleCode: true, title: true, body: true, confidence: true },
    });

    if (rule) {
      const conf = rule.confidence >= 1.0 ? '(подтверждено)' : `(${(rule.confidence * 100).toFixed(0)}%)`;
      await sendMessage(chatId, `${rule.ruleCode} ${conf}\n\n${rule.title}\n\n${rule.body}`);
      return;
    }
    // Rule not found — fall through to RAG, maybe it can find something relevant
  }

  // 5. SUPER_ADMIN plain text → AI intent classification
  if (isSuperAdmin(user.role)) {
    try {
      const classified = await classifyAdminIntent(text);
      console.log(`[message-router] Smart admin: "${text.substring(0, 60)}" → ${classified.intent} (${classified.confidence})`);

      if (classified.confidence > 0.7 && classified.intent !== 'question') {
        await handleSmartAdminAction(chatId, classified, user);
        return;
      }
    } catch (error) {
      console.error('[message-router] Smart admin classification error:', error);
      // Fall through to regular Q&A
    }
  }

  // 6. Regular Q&A for everyone
  await handleQuestion(message, user);
}
