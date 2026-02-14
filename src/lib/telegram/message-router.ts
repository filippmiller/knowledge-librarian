import { sendMessage } from './telegram-api';
import type { TelegramUpdate, TelegramMessage } from './telegram-api';
import { checkAccess, isAdmin } from './access-control';
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
  handleShow,
  handleEdit,
  handleDelete,
  handleReport,
  handleHelpMe,
  handleQuestion,
} from './commands';
import { handleVoiceMessage } from './voice-handler';
import { handleDocumentUpload } from './document-handler';

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
    // Voice message
    if (message.voice) {
      if (isAdmin(user.role)) {
        await handleVoiceMessage(message, user);
      } else {
        await sendMessage(chatId, 'Голосовые сообщения доступны только администраторам.');
      }
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
 */
async function routeTextMessage(message: TelegramMessage, user: TelegramUserInfo): Promise<void> {
  const text = message.text?.trim() || '';

  // Parse command and arguments
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
    const adminCommands = ['grant', 'revoke', 'promote', 'demote', 'users', 'add', 'correct', 'show', 'edit', 'delete'];
    if (adminCommands.includes(command)) {
      if (!isAdmin(user.role)) {
        await sendMessage(message.chat.id, 'У вас нет прав для этой команды.');
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
        case 'show':
          return handleShow(message, user, args);
        case 'edit':
          return handleEdit(message, user, args);
        case 'delete':
          return handleDelete(message, user, args);
      }
      return;
    }

    await sendMessage(message.chat.id, `Неизвестная команда: /${command}\n\nИспользуйте /help для списка команд.`);
    return;
  }

  // Not a command — treat as a question
  await handleQuestion(message, user);
}
