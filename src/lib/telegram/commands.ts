import { sendMessage, sendTypingIndicator } from './telegram-api';
import type { TelegramMessage } from './telegram-api';
import type { TelegramUserInfo } from './access-control';
import {
  grantAccess,
  revokeAccess,
  promoteUser,
  demoteUser,
  listUsers,
  isAdmin,
  isSuperAdmin,
} from './access-control';
import { addKnowledge, correctKnowledge } from './knowledge-manager';
import { answerQuestionEnhanced, type EnhancedAnswerResult } from '@/lib/ai/enhanced-answering-engine';
import { getOrCreateSession, saveChatMessage } from '@/lib/ai/answering-engine';

/**
 * Handle /start command.
 */
export async function handleStart(message: TelegramMessage, user: TelegramUserInfo): Promise<void> {
  const chatId = message.chat.id;
  const name = user.firstName || 'пользователь';
  const roleLabel = user.role === 'SUPER_ADMIN' ? 'Суперадмин'
    : user.role === 'ADMIN' ? 'Администратор'
    : 'Пользователь';

  let text = `Добро пожаловать, ${name}!\n\n`;
  text += `Ваша роль: ${roleLabel}\n\n`;
  text += 'Я - бот базы знаний бюро переводов Аврора.\n\n';
  text += 'Задайте мне любой вопрос о работе бюро.\n\n';
  text += 'Примеры вопросов:\n';
  text += '- Сколько стоит нотариальный перевод?\n';
  text += '- Как отправить заказ почтой России?\n';
  text += '- Какие миграционные услуги вы предоставляете?\n\n';

  text += 'Основные команды:\n';
  text += '/help - Справка по командам\n';

  if (isAdmin(user.role)) {
    text += '\nАдмин-команды:\n';
    text += '/add <текст> - Добавить знание\n';
    text += '/correct <текст> - Исправить знание\n';
    text += '/grant <id> - Дать доступ\n';
    text += '/revoke <id> - Отозвать доступ\n';
    text += '/users - Список пользователей\n';
    text += 'Голосовое сообщение - Добавить знание голосом\n';
    text += 'Документ (PDF/DOCX/TXT) - Загрузить в базу\n';
  }

  if (isSuperAdmin(user.role)) {
    text += '\nСуперадмин:\n';
    text += '/promote <id> - Повысить до админа\n';
    text += '/demote <id> - Понизить до пользователя\n';
  }

  await sendMessage(chatId, text);
}

/**
 * Handle /help command.
 */
export async function handleHelp(message: TelegramMessage, user: TelegramUserInfo): Promise<void> {
  const chatId = message.chat.id;

  let text = 'Команды бота:\n\n';
  text += '/start - Приветствие\n';
  text += '/help - Эта справка\n\n';
  text += 'Просто напишите вопрос, и я найду ответ в базе знаний.\n';

  if (isAdmin(user.role)) {
    text += '\nАдмин-команды:\n';
    text += '/add <текст> - Добавить новое знание в базу. AI извлечёт правила и QA пары.\n';
    text += '/correct <текст> - Исправить существующее знание. AI найдёт и обновит.\n';
    text += '/grant <telegram_id> - Выдать доступ пользователю\n';
    text += '/revoke <telegram_id> - Отозвать доступ\n';
    text += '/users - Список всех активных пользователей\n\n';
    text += 'Голосовые сообщения: отправьте голосовое, оно будет расшифровано и добавлено как знание.\n';
    text += 'Документы: отправьте PDF/DOCX/TXT файл для полной обработки через AI.\n';
  }

  if (isSuperAdmin(user.role)) {
    text += '\nСуперадмин:\n';
    text += '/promote <telegram_id> - Повысить пользователя до админа\n';
    text += '/demote <telegram_id> - Понизить админа до пользователя\n';
  }

  text += '\nВаш Telegram ID: ' + user.telegramId;

  await sendMessage(chatId, text);
}

/**
 * Handle /grant command.
 */
export async function handleGrant(message: TelegramMessage, user: TelegramUserInfo, args: string): Promise<void> {
  const chatId = message.chat.id;

  if (!isAdmin(user.role)) {
    await sendMessage(chatId, 'У вас нет прав для этой команды.');
    return;
  }

  const targetId = args.trim();
  if (!targetId || !/^\d+$/.test(targetId)) {
    await sendMessage(chatId, 'Использование: /grant <telegram_id>\n\nУкажите числовой Telegram ID пользователя.');
    return;
  }

  const result = await grantAccess(targetId, user.telegramId);
  await sendMessage(chatId, result.message);
}

/**
 * Handle /revoke command.
 */
export async function handleRevoke(message: TelegramMessage, user: TelegramUserInfo, args: string): Promise<void> {
  const chatId = message.chat.id;

  if (!isAdmin(user.role)) {
    await sendMessage(chatId, 'У вас нет прав для этой команды.');
    return;
  }

  const targetId = args.trim();
  if (!targetId || !/^\d+$/.test(targetId)) {
    await sendMessage(chatId, 'Использование: /revoke <telegram_id>');
    return;
  }

  const result = await revokeAccess(targetId, user.telegramId);
  await sendMessage(chatId, result.message);
}

/**
 * Handle /promote command.
 */
export async function handlePromote(message: TelegramMessage, user: TelegramUserInfo, args: string): Promise<void> {
  const chatId = message.chat.id;

  if (!isSuperAdmin(user.role)) {
    await sendMessage(chatId, 'Только суперадминистратор может повышать пользователей.');
    return;
  }

  const targetId = args.trim();
  if (!targetId || !/^\d+$/.test(targetId)) {
    await sendMessage(chatId, 'Использование: /promote <telegram_id>');
    return;
  }

  const result = await promoteUser(targetId);
  await sendMessage(chatId, result.message);
}

/**
 * Handle /demote command.
 */
export async function handleDemote(message: TelegramMessage, user: TelegramUserInfo, args: string): Promise<void> {
  const chatId = message.chat.id;

  if (!isSuperAdmin(user.role)) {
    await sendMessage(chatId, 'Только суперадминистратор может понижать пользователей.');
    return;
  }

  const targetId = args.trim();
  if (!targetId || !/^\d+$/.test(targetId)) {
    await sendMessage(chatId, 'Использование: /demote <telegram_id>');
    return;
  }

  const result = await demoteUser(targetId);
  await sendMessage(chatId, result.message);
}

/**
 * Handle /users command.
 */
export async function handleUsers(message: TelegramMessage, user: TelegramUserInfo): Promise<void> {
  const chatId = message.chat.id;

  if (!isAdmin(user.role)) {
    await sendMessage(chatId, 'У вас нет прав для этой команды.');
    return;
  }

  const users = await listUsers();

  if (users.length === 0) {
    await sendMessage(chatId, 'Нет зарегистрированных пользователей.');
    return;
  }

  let text = `Активные пользователи (${users.length}):\n\n`;
  for (const u of users) {
    const name = u.firstName || u.username || 'Без имени';
    const usernameStr = u.username ? ` (@${u.username})` : '';
    text += `${u.role} | ${u.telegramId} | ${name}${usernameStr}\n`;
  }

  await sendMessage(chatId, text);
}

/**
 * Handle /add command.
 */
export async function handleAdd(message: TelegramMessage, user: TelegramUserInfo, args: string): Promise<void> {
  const chatId = message.chat.id;

  if (!isAdmin(user.role)) {
    await sendMessage(chatId, 'У вас нет прав для этой команды.');
    return;
  }

  const text = args.trim();
  if (!text) {
    await sendMessage(chatId, 'Использование: /add <текст знания>\n\nПример: /add Стоимость перевода паспорта - 1500 руб');
    return;
  }

  await sendTypingIndicator(chatId);
  await sendMessage(chatId, 'Обрабатываю...');

  try {
    const result = await addKnowledge(text, user.telegramId);
    await sendMessage(chatId, result.summary);
  } catch (error) {
    console.error('[commands] /add error:', error);
    await sendMessage(chatId, 'Ошибка при добавлении знания. Попробуйте позже.');
  }
}

/**
 * Handle /correct command.
 */
export async function handleCorrect(message: TelegramMessage, user: TelegramUserInfo, args: string): Promise<void> {
  const chatId = message.chat.id;

  if (!isAdmin(user.role)) {
    await sendMessage(chatId, 'У вас нет прав для этой команды.');
    return;
  }

  const text = args.trim();
  if (!text) {
    await sendMessage(chatId, 'Использование: /correct <описание исправления>\n\nПример: /correct Стоимость перевода паспорта теперь 2000 руб (было 1500)');
    return;
  }

  await sendTypingIndicator(chatId);
  await sendMessage(chatId, 'Ищу и обновляю...');

  try {
    const result = await correctKnowledge(text, user.telegramId);
    await sendMessage(chatId, result.summary);
  } catch (error) {
    console.error('[commands] /correct error:', error);
    await sendMessage(chatId, 'Ошибка при обновлении знания. Попробуйте позже.');
  }
}

/**
 * Handle a plain text question (not a command).
 */
export async function handleQuestion(message: TelegramMessage, user: TelegramUserInfo): Promise<void> {
  const chatId = message.chat.id;
  const question = message.text?.trim();

  if (!question) return;

  if (question.length > 2000) {
    await sendMessage(chatId, 'Вопрос слишком длинный. Максимум 2000 символов.');
    return;
  }

  await sendTypingIndicator(chatId);

  console.log(`[telegram] Question from ${user.telegramId} (@${user.username}): ${question.substring(0, 100)}`);

  try {
    const session = await getOrCreateSession('TELEGRAM', user.telegramId);
    await saveChatMessage(session.id, 'USER', question);

    const result = await answerQuestionEnhanced(question, session.id);

    await saveChatMessage(session.id, 'ASSISTANT', result.answer, {
      confidence: result.confidence,
      confidenceLevel: result.confidenceLevel,
      domainsUsed: result.domainsUsed,
      citationCount: result.citations.length,
    });

    const response = formatAnswerResponse(result);
    await sendMessage(chatId, response);
  } catch (error) {
    console.error('[commands] Question error:', error);
    await sendMessage(chatId, 'Произошла ошибка при обработке вопроса. Попробуйте позже.');
  }
}

/**
 * Format an answer result for Telegram.
 */
export function formatAnswerResponse(result: EnhancedAnswerResult): string {
  let response = result.answer;

  if (result.citations.length > 0) {
    response += '\n\nИсточники:';
    for (const citation of result.citations.slice(0, 3)) {
      if (citation.ruleCode) {
        response += `\n  ${citation.ruleCode}`;
        if (citation.documentTitle) {
          response += ` (${citation.documentTitle})`;
        }
      }
    }
  }

  const confLabel = result.confidenceLevel === 'high' ? 'Высокая'
    : result.confidenceLevel === 'medium' ? 'Средняя'
    : result.confidenceLevel === 'low' ? 'Низкая'
    : 'Недостаточная';
  response += `\n\nУверенность: ${confLabel} (${(result.confidence * 100).toFixed(0)}%)`;

  return response;
}
