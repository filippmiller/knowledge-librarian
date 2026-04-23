import { sendMessage, sendTypingIndicator, sendWebAppButton } from './telegram-api';
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
  getAdminTelegramIds,
  getAllActiveTelegramIds,
} from './access-control';
import { addKnowledge, correctKnowledge } from './knowledge-manager';
import { answerQuestionEnhanced, type EnhancedAnswerResult } from '@/lib/ai/enhanced-answering-engine';
import { getOrCreateSession, saveChatMessage } from '@/lib/ai/answering-engine';
import prisma from '@/lib/db';

/**
 * Handle /start command.
 */
export async function handleStart(message: TelegramMessage, user: TelegramUserInfo): Promise<void> {
  const chatId = message.chat.id;
  const name = user.firstName || 'пользователь';
  const roleLabel = user.role === 'SUPER_ADMIN' ? 'Суперадмин'
    : user.role === 'ADMIN' ? 'Администратор'
    : 'Пользователь';

  let text = `Добро пожаловать, ${name}! 👋\n\n`;
  text += `Ваша роль: ${roleLabel}\n\n`;
  text += 'Я — бот базы знаний бюро переводов Аврора.\n\n';
  text += '💡 Новое: теперь есть удобное приложение с поиском и карточками правил!\n\n';
  text += '📝 Задайте мне вопрос голосом или текстом, или откройте приложение для просмотра всех правил.';

  // Send welcome message with Web App button
  await sendWebAppButton(chatId, text, '📱 Открыть базу знаний');

  // Also send a follow-up with quick tips
  let tipsText = '\n💡 *Быстрые команды:*\n\n';
  tipsText += '• Задайте вопрос — получите ответ из базы\n';
  tipsText += '• Отправьте голосовое — я распознаю и отвечу\n';
  tipsText += '• Напишите "правило R-123" — покажу детали\n';
  tipsText += '• /help — полный список команд\n';

  if (isAdmin(user.role)) {
    tipsText += '\n👨‍💼 *Для админов:*\n';
    tipsText += '• /add — добавить знание\n';
    tipsText += '• /correct — исправить знание\n';
    tipsText += '• /show R-X — просмотр правила\n';
    tipsText += '• Загрузите документ — обработаю автоматически\n';
  }

  await sendMessage(chatId, tipsText);
}

/**
 * Handle /app command - open Mini App.
 */
export async function handleApp(message: TelegramMessage, user: TelegramUserInfo): Promise<void> {
  const chatId = message.chat.id;

  const text = `📱 *База знаний Аврора*\n\n` +
    `Удобное приложение для просмотра правил, поиска и навигации по базе знаний.\n\n` +
    `Возможности:\n` +
    `• 🔍 Быстрый поиск по правилам\n` +
    `• 📂 Просмотр по категориям\n` +
    `• ⭐ Просмотр уверенности AI\n` +
    `• 📄 Детали каждого правила\n\n` +
    `Нажмите кнопку ниже, чтобы открыть:`;

  await sendWebAppButton(chatId, text, '📱 Открыть приложение');
}

/**
 * Handle /help command.
 */
export async function handleHelp(message: TelegramMessage, user: TelegramUserInfo): Promise<void> {
  const chatId = message.chat.id;

  let text = '📚 *Команды бота:*\n\n';
  text += '/start — Приветствие и меню\n';
  text += '/app — Открыть приложение базы знаний\n';
  text += '/help — Эта справка\n';
  text += '/report <текст> — Сообщить об ошибке (уведомит админов)\n';
  text += '/helpme <вопрос> — Отправить вопрос всем сотрудникам\n\n';
  text += '💡 Просто напишите вопрос, и я найду ответ в базе знаний.';

  if (isAdmin(user.role)) {
    text += '\n\n👨‍💼 *Админ-команды:*\n';
    text += '/add <текст> — Добавить знание (AI извлечёт правила)\n';
    text += '/correct <текст> — Исправить знание\n';
    text += '/show — Список правил, /show R-X для деталей\n';
    text += '/edit R-X <текст> — Заменить текст правила\n';
    text += '/delete R-X — Пометить правило как удалённое\n';
    text += '/confirm R-X — Подтвердить правило (100%)\n';
    text += '/grant <telegram_id> — Выдать доступ пользователю\n';
    text += '/revoke <telegram_id> — Отозвать доступ\n';
    text += '/users — Список всех активных пользователей\n\n';
    text += '🎙 *Голосовые:* "добавь/запомни..." = добавление; "поменяй/измени..." = исправление\n';
    text += '📎 *Документы:* PDF/DOCX/TXT для обработки AI';
  }

  if (isSuperAdmin(user.role)) {
    text += '\n\n🔑 *Суперадмин:*\n';
    text += '/promote <telegram_id> — Повысить до админа\n';
    text += '/demote <telegram_id> — Понизить до пользователя\n';
    text += '\n🧠 *Умный режим:* пишите на русском без команд.\n';
    text += 'Примеры: "Подтверди R-24", "Удали правило R-5", "Покажи правила про апостиль", "Статистика"';
  }

  text += '\n\n🆔 Ваш Telegram ID: `' + user.telegramId + '`';

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

  let text = `👥 Активные пользователи (${users.length}):\n\n`;
  for (const u of users) {
    const name = u.firstName || u.username || 'Без имени';
    const usernameStr = u.username ? ` (@${u.username})` : '';
    const roleEmoji = u.role === 'SUPER_ADMIN' ? '🔑' : u.role === 'ADMIN' ? '👨‍💼' : '👤';
    text += `${roleEmoji} ${u.role} | ${u.telegramId} | ${name}${usernameStr}\n`;
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
  await sendMessage(chatId, '⏳ Обрабатываю...');

  try {
    const result = await addKnowledge(text, user.telegramId);
    await sendMessage(chatId, `✅ ${result.summary}`);
  } catch (error) {
    console.error('[commands] /add error:', error);
    await sendMessage(chatId, '❌ Ошибка при добавлении знания. Попробуйте позже.');
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
  await sendMessage(chatId, '🔍 Ищу и обновляю...');

  try {
    const result = await correctKnowledge(text, user.telegramId);
    await sendMessage(chatId, `✅ ${result.summary}`);
  } catch (error) {
    console.error('[commands] /correct error:', error);
    await sendMessage(chatId, '❌ Ошибка при обновлении знания. Попробуйте позже.');
  }
}

/**
 * Handle /confirm command — set rule confidence to 1.0 (human-verified).
 */
export async function handleConfirm(message: TelegramMessage, user: TelegramUserInfo, args: string): Promise<void> {
  const chatId = message.chat.id;

  if (!isAdmin(user.role)) {
    await sendMessage(chatId, 'У вас нет прав для этой команды.');
    return;
  }

  const code = args.trim().toUpperCase();

  if (!code || !code.match(/^R-\d+$/)) {
    await sendMessage(chatId, 'Использование: /confirm R-X\n\nПодтверждает правило — устанавливает уверенность 100%.');
    return;
  }

  const existing = await prisma.rule.findFirst({
    where: { ruleCode: code, status: 'ACTIVE' },
  });

  if (!existing) {
    await sendMessage(chatId, `❌ Правило ${code} не найдено (или не активно).`);
    return;
  }

  if (existing.confidence >= 1.0) {
    await sendMessage(chatId, `✓ Правило ${code} уже подтверждено (100%).`);
    return;
  }

  await prisma.rule.update({
    where: { id: existing.id },
    data: {
      confidence: 1.0,
      sourceSpan: {
        ...(typeof existing.sourceSpan === 'object' && existing.sourceSpan !== null ? existing.sourceSpan : {}),
        confirmedBy: user.telegramId,
        confirmedAt: new Date().toISOString(),
      },
    },
  });

  await sendMessage(chatId, `✅ Правило ${code} подтверждено (100%).\n\n${existing.title}`);
}

/**
 * Handle /show command — show a rule by code.
 */
export async function handleShow(message: TelegramMessage, user: TelegramUserInfo, args: string): Promise<void> {
  const chatId = message.chat.id;

  if (!isAdmin(user.role)) {
    await sendMessage(chatId, 'У вас нет прав для этой команды.');
    return;
  }

  const code = args.trim().toUpperCase();

  // If no argument, list recent rules
  if (!code) {
    const recent = await prisma.rule.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { ruleCode: true, title: true },
    });

    if (recent.length === 0) {
      await sendMessage(chatId, 'Нет активных правил.');
      return;
    }

    let text = '📋 Последние правила:\n\n';
    for (const r of recent) {
      text += `${r.ruleCode} — ${r.title}\n`;
    }
    text += '\n💡 Используйте /show R-X для просмотра деталей.';
    await sendMessage(chatId, text);
    return;
  }

  const rule = await prisma.rule.findFirst({
    where: { ruleCode: code, status: 'ACTIVE' },
    include: {
      document: { select: { title: true } },
      domains: { include: { domain: { select: { slug: true, title: true } } } },
      qaPairs: { where: { status: 'ACTIVE' }, select: { question: true, answer: true } },
    },
  });

  if (!rule) {
    await sendMessage(chatId, `❌ Правило ${code} не найдено (или не активно).`);
    return;
  }

  let text = `📌 *${rule.ruleCode}*: ${rule.title}\n\n`;
  text += `${rule.body}\n\n`;
  text += `⭐ Уверенность: ${(rule.confidence * 100).toFixed(0)}%`;
  if (rule.confidence < 1.0) {
    text += ` (/confirm ${rule.ruleCode} для подтверждения)`;
  }
  text += '\n';
  text += `📝 Статус: ${rule.status}\n`;
  if (rule.document) text += `📄 Документ: ${rule.document.title}\n`;
  if (rule.domains.length > 0) {
    text += `🏷 Домены: ${rule.domains.map((d) => d.domain.slug).join(', ')}\n`;
  }
  if (rule.qaPairs.length > 0) {
    text += `\n💬 Связанные вопросы (${rule.qaPairs.length}):\n`;
    for (const qa of rule.qaPairs.slice(0, 5)) {
      text += `  ❓ ${qa.question}\n  ✓ ${qa.answer}\n\n`;
    }
  }
  text += `\n📅 Создано: ${rule.createdAt.toISOString().slice(0, 10)}`;

  await sendMessage(chatId, text);
}

/**
 * Handle /edit command — edit a rule's body.
 */
export async function handleEdit(message: TelegramMessage, user: TelegramUserInfo, args: string): Promise<void> {
  const chatId = message.chat.id;

  if (!isAdmin(user.role)) {
    await sendMessage(chatId, 'У вас нет прав для этой команды.');
    return;
  }

  // Parse: /edit R-5 новый текст правила
  const match = args.match(/^(R-\d+)\s+([\s\S]+)$/i);

  if (!match) {
    await sendMessage(chatId, 'Использование: /edit R-X <новый текст правила>\n\nПример: /edit R-5 Стоимость перевода паспорта - 2000 руб');
    return;
  }

  const code = match[1].toUpperCase();
  const newBody = match[2].trim();

  const existing = await prisma.rule.findFirst({
    where: { ruleCode: code, status: 'ACTIVE' },
  });

  if (!existing) {
    await sendMessage(chatId, `❌ Правило ${code} не найдено (или не активно).`);
    return;
  }

  await sendTypingIndicator(chatId);

  // Supersede old rule, create new version
  await prisma.rule.update({
    where: { id: existing.id },
    data: { status: 'SUPERSEDED' },
  });

  // Get next rule code (numeric sort — string sort gives wrong max with R-1..R-492)
  const allCodes = await prisma.rule.findMany({
    where: { ruleCode: { startsWith: 'R-' } },
    select: { ruleCode: true },
  });
  const maxNum = allCodes.reduce((max, r) => {
    const n = parseInt(r.ruleCode.replace(/^R-/i, '')) || 0;
    return n > max ? n : max;
  }, 0);
  const newCode = `R-${maxNum + 1}`;

  const newRule = await prisma.rule.create({
    data: {
      ruleCode: newCode,
      title: existing.title,
      body: newBody,
      confidence: 1.0,
      documentId: existing.documentId,
      supersedesRuleId: existing.id,
      sourceSpan: { quote: newBody.slice(0, 200), locationHint: `Отредактировано через Telegram` },
    },
  });

  // Copy domain links
  const domainLinks = await prisma.ruleDomain.findMany({
    where: { ruleId: existing.id },
  });
  for (const link of domainLinks) {
    await prisma.ruleDomain.create({
      data: { ruleId: newRule.id, domainId: link.domainId, confidence: link.confidence },
    });
  }

  await sendMessage(
    chatId,
    `✅ Правило обновлено.\n\n` +
    `Старое: ${code} (SUPERSEDED)\n` +
    `Новое: ${newCode}\n\n` +
    `${existing.title}\n${newBody}`
  );
}

/**
 * Handle /delete command — deactivate (deprecate) a rule.
 */
export async function handleDelete(message: TelegramMessage, user: TelegramUserInfo, args: string): Promise<void> {
  const chatId = message.chat.id;

  if (!isAdmin(user.role)) {
    await sendMessage(chatId, 'У вас нет прав для этой команды.');
    return;
  }

  const code = args.trim().toUpperCase();

  if (!code || !code.match(/^R-\d+$/)) {
    await sendMessage(chatId, 'Использование: /delete R-X\n\nПравило будет помечено как DEPRECATED (не удалено физически).');
    return;
  }

  const existing = await prisma.rule.findFirst({
    where: { ruleCode: code, status: 'ACTIVE' },
  });

  if (!existing) {
    await sendMessage(chatId, `❌ Правило ${code} не найдено (или уже не активно).`);
    return;
  }

  await prisma.rule.update({
    where: { id: existing.id },
    data: { status: 'DEPRECATED' },
  });

  // Also deprecate linked QA pairs
  const deprecated = await prisma.qAPair.updateMany({
    where: { ruleId: existing.id, status: 'ACTIVE' },
    data: { status: 'DEPRECATED' },
  });

  await sendMessage(
    chatId,
    `🗑 Правило ${code} помечено как DEPRECATED.\n` +
    `Также помечено QA пар: ${deprecated.count}\n\n` +
    `${existing.title}`
  );
}

/**
 * Handle a plain text question (not a command).
 */
export async function handleQuestion(message: TelegramMessage, user: TelegramUserInfo): Promise<void> {
  const chatId = message.chat.id;
  const question = message.text?.trim();

  if (!question) return;

  if (question.length > 10000) {
    await sendMessage(chatId, 'Текст слишком длинный. Максимум 10000 символов.');
    return;
  }

  await sendTypingIndicator(chatId);

  console.log(`[telegram] Question from ${user.telegramId} (@${user.username}): ${question.substring(0, 100)}`);

  try {
    const session = await getOrCreateSession('TELEGRAM', user.telegramId);
    await saveChatMessage(session.id, 'USER', question);

    const result = await answerQuestionEnhanced(question, session.id);

    // Persist scenarioClarification in metadata so the callback handler
    // can resolve option IDs to their labels on the next button click.
    await saveChatMessage(session.id, 'ASSISTANT', result.answer, {
      confidence: result.confidence,
      confidenceLevel: result.confidenceLevel,
      domainsUsed: result.domainsUsed,
      citationCount: result.citations.length,
      scenarioKey: result.scenarioKey,
      scenarioClarification: result.scenarioClarification,
    });

    // Use the shared helper so text path and callback path format identically.
    const { sendClarificationOrAnswer } = await import('./scenario-callback');
    await sendClarificationOrAnswer(chatId, result);
  } catch (error) {
    console.error('[commands] Question error:', error);
    await sendMessage(chatId, '❌ Произошла ошибка при обработке вопроса. Попробуйте позже.');
  }
}

/**
 * Handle /report command — any user can report wrong information to admins.
 */
export async function handleReport(message: TelegramMessage, user: TelegramUserInfo, args: string): Promise<void> {
  const chatId = message.chat.id;

  const text = args.trim();
  if (!text) {
    await sendMessage(chatId, 'Использование: /report <описание ошибки>\n\nОпишите, какая информация в базе знаний неверна.\n\nПример: /report Бот сказал что перевод паспорта стоит 1500, но на самом деле 2000');
    return;
  }

  const senderName = user.firstName || user.username || user.telegramId;
  const senderInfo = user.username ? `${senderName} (@${user.username})` : senderName;

  // Notify all admins
  const adminIds = await getAdminTelegramIds();

  if (adminIds.length === 0) {
    await sendMessage(chatId, '⚠️ Нет активных администраторов для отправки отчёта. Попробуйте позже.');
    return;
  }

  const reportMessage = [
    '🚨 Сообщение об ошибке в базе знаний',
    '',
    `👤 От: ${senderInfo} (ID: ${user.telegramId})`,
    `📅 Дата: ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })}`,
    '',
    `📝 Описание:`,
    text,
  ].join('\n');

  let notified = 0;
  for (const adminId of adminIds) {
    // Don't notify the sender if they're also an admin
    if (adminId === user.telegramId) continue;
    try {
      await sendMessage(Number(adminId), reportMessage);
      notified++;
    } catch {
      // Skip unreachable admins
    }
  }

  await sendMessage(chatId, `✅ Спасибо! Ваше сообщение отправлено администраторам (${notified}).`);
}

/**
 * Handle /helpme command — broadcast a question to all active users.
 */
export async function handleHelpMe(message: TelegramMessage, user: TelegramUserInfo, args: string): Promise<void> {
  const chatId = message.chat.id;

  const text = args.trim();
  if (!text) {
    await sendMessage(chatId, 'Использование: /helpme <ваш вопрос>\n\nВаш вопрос будет отправлен всем сотрудникам.\n\nПример: /helpme Кто-нибудь знает, как оформить апостиль на свидетельство?');
    return;
  }

  const senderName = user.firstName || user.username || user.telegramId;
  const senderInfo = user.username ? `${senderName} (@${user.username})` : senderName;

  // Get all active users
  const allIds = await getAllActiveTelegramIds();

  const helpMessage = [
    '🆘 Просьба о помощи',
    '',
    `👤 От: ${senderInfo}`,
    '',
    text,
    '',
    `💬 Ответьте ${senderInfo} напрямую в Telegram.`,
  ].join('\n');

  let notified = 0;
  for (const userId of allIds) {
    // Don't send to the requester
    if (userId === user.telegramId) continue;
    try {
      await sendMessage(Number(userId), helpMessage);
      notified++;
    } catch {
      // Skip unreachable users
    }
  }

  await sendMessage(chatId, `✅ Ваш вопрос отправлен ${notified} сотрудникам.`);
}

/**
 * Format an answer result for Telegram.
 *
 * Three shapes:
 *   - Scenario clarification → just the question + numbered options, no meta
 *   - Out of scope            → just the short "no data" message
 *   - Scenario_clear answer   → answer + scenario badge + sources + confidence
 */
export function formatAnswerResponse(result: EnhancedAnswerResult): string {
  // Decision-gate short-circuit responses already contain a clean question +
  // options list. Adding citations/confidence to them is noise.
  if (result.scenarioClarification) {
    return result.answer;
  }
  if (result.confidenceLevel === 'insufficient' && !result.scenarioKey) {
    return result.answer;
  }

  const lines: string[] = [];
  if (result.scenarioLabel) {
    lines.push(`✦ Ответ для: ${result.scenarioLabel}`);
    lines.push('');
  }
  lines.push(result.answer);

  if (result.citations.length > 0) {
    lines.push('');
    lines.push('📚 Источники:');
    for (const citation of result.citations.slice(0, 3)) {
      if (citation.ruleCode) {
        const title = citation.documentTitle ? ` (${citation.documentTitle})` : '';
        lines.push(`  ${citation.ruleCode}${title}`);
      }
    }
  }

  const confLabel = result.confidenceLevel === 'high' ? 'Высокая'
    : result.confidenceLevel === 'medium' ? 'Средняя'
    : result.confidenceLevel === 'low' ? 'Низкая'
    : 'Недостаточная';
  lines.push('');
  lines.push(`⭐ Уверенность: ${confLabel} (${(result.confidence * 100).toFixed(0)}%)`);

  return lines.join('\n');
}
