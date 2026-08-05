/**
 * Telegram API для ТЕСТОВОГО бота (тренировка клиентского контура).
 *
 * Намеренно отдельный файл, а не параметризация src/lib/telegram/telegram-api.ts
 * токеном: прод-бот — зрелый, боевой код, к которому ходят реальные сотрудники
 * и реальные документы. Смешивать его с экспериментальным инструментом ради
 * тренировки — риск без пользы. Если тестовый бот приживётся и станет частью
 * штатного процесса, тогда стоит объединить оба клиента параметром token —
 * не раньше.
 */
const TOKEN = process.env.TELEGRAM_TEST_BOT_TOKEN;

function api(method: string): string {
  return `https://api.telegram.org/bot${TOKEN}/${method}`;
}

export function isTestBotConfigured(): boolean {
  return Boolean(TOKEN);
}

export async function sendTestMessage(
  chatId: number,
  text: string,
  buttons?: Array<{ text: string; callback_data: string }>
): Promise<void> {
  if (!TOKEN) {
    console.error('[telegram-test] TELEGRAM_TEST_BOT_TOKEN not configured');
    return;
  }
  const maxLen = 4000;
  const parts = text.length > maxLen ? splitMessage(text, maxLen) : [text];
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    try {
      await fetch(api('sendMessage'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: parts[i],
          // Кнопки — только под последней частью, иначе они повисают
          // посреди разбитого сообщения.
          ...(isLast && buttons ? { reply_markup: { inline_keyboard: buttons.map((b) => [b]) } } : {}),
        }),
      });
    } catch (error) {
      console.error('[telegram-test] sendMessage error:', error);
    }
  }
}

export async function answerTestCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
  if (!TOKEN) return;
  try {
    await fetch(api('answerCallbackQuery'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
    });
  } catch (error) {
    console.error('[telegram-test] answerCallbackQuery error:', error);
  }
}

/** Убрать клавиатуру после того, как сотрудник сделал выбор — чтобы не жали дважды. */
export async function editTestMessageReplyMarkup(chatId: number, messageId: number): Promise<void> {
  if (!TOKEN) return;
  try {
    await fetch(api('editMessageReplyMarkup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
    });
  } catch (error) {
    console.error('[telegram-test] editMessageReplyMarkup error:', error);
  }
}

export async function setTestBotCommands(): Promise<void> {
  if (!TOKEN) return;
  try {
    await fetch(api('setMyCommands'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'start', description: 'Как пользоваться тестовым ботом' },
          { command: 'stats', description: 'Сводка по накопленной тренировке' },
        ],
      }),
    });
  } catch (error) {
    console.error('[telegram-test] setMyCommands error:', error);
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { parts.push(remaining); break; }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return parts;
}
