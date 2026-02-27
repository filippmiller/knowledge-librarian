const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  text?: string;
  from?: { id: number; first_name: string; username?: string };
  date: number;
  voice?: {
    file_id: string;
    file_unique_id: string;
    duration: number;
    mime_type?: string;
    file_size?: number;
  };
  document?: {
    file_id: string;
    file_unique_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  caption?: string;
}

export async function sendMessage(chatId: number, text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN not configured');
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  // Telegram has a 4096 char limit per message; split if needed
  const maxLen = 4000;
  const parts = text.length > maxLen
    ? splitMessage(text, maxLen)
    : [text];

  for (const part of parts) {
    try {
      // Send as plain text — avoids MarkdownV2 escaping issues and message bloat
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: part }),
      });
    } catch (error) {
      console.error('Error sending Telegram message:', error);
    }
  }
}

function splitMessage(text: string, maxLen: number): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      parts.push(remaining);
      break;
    }
    // Try to split at newline
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen / 2) splitAt = maxLen;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return parts;
}

export async function sendTypingIndicator(chatId: number): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) return;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
    });
  } catch {
    // Ignore typing indicator errors
  }
}

export async function sendUploadingIndicator(chatId: number): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) return;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'upload_document' }),
    });
  } catch {
    // Ignore
  }
}

/**
 * Register bot commands with Telegram so they appear in the slash menu.
 * Safe to call multiple times — Telegram just overwrites.
 */
export async function setBotCommands(): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) return;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands`;

  // Default commands visible to all users (no admin commands)
  const userCommands = [
    { command: 'start', description: 'Приветствие и информация о боте' },
    { command: 'help', description: 'Справка по командам' },
    { command: 'app', description: 'Открыть приложение базы знаний' },
    { command: 'report', description: 'Сообщить об ошибке в базе знаний' },
    { command: 'helpme', description: 'Отправить вопрос всем сотрудникам' },
  ];

  try {
    // Set default commands (visible to all users)
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands: userCommands }),
    });

    if (resp.ok) {
      console.log('[telegram-api] Bot commands registered successfully');
    } else {
      const err = await resp.text();
      console.error('[telegram-api] Failed to set commands:', err);
    }
  } catch (error) {
    console.error('[telegram-api] Error setting commands:', error);
  }
}

/**
 * Send a message with a Web App button (Mini App)
 */
export async function sendWebAppButton(
  chatId: number,
  text: string,
  buttonText: string = '📱 Открыть приложение'
): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) return;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://avrora-library-production.up.railway.app';

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: buttonText,
                web_app: { url: `${appUrl}/telegram-app` },
              },
            ],
          ],
        },
      }),
    });
  } catch (error) {
    console.error('[telegram-api] Error sending web app button:', error);
  }
}

/**
 * Set the menu button for the bot to open the Mini App
 */
export async function setMenuButton(): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) return;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setChatMenuButton`;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://avrora-library-production.up.railway.app';

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        menu_button: {
          type: 'web_app',
          text: '📚 База знаний',
          web_app: { url: `${appUrl}/telegram-app` },
        },
      }),
    });
    console.log('[telegram-api] Menu button set successfully');
  } catch (error) {
    console.error('[telegram-api] Error setting menu button:', error);
  }
}

export async function downloadFile(fileId: string): Promise<{ buffer: Buffer; filePath: string }> {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN not configured');

  // Step 1: Get file path from Telegram
  const fileInfoUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile`;
  const fileInfoResp = await fetch(fileInfoUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });

  if (!fileInfoResp.ok) {
    throw new Error(`Failed to get file info: ${fileInfoResp.status}`);
  }

  const fileInfo = (await fileInfoResp.json()) as {
    ok: boolean;
    result?: { file_path?: string };
  };

  if (!fileInfo.ok || !fileInfo.result?.file_path) {
    throw new Error('Failed to get file path from Telegram');
  }

  // Step 2: Download the file
  const downloadUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`;
  const downloadResp = await fetch(downloadUrl);

  if (!downloadResp.ok) {
    throw new Error(`Failed to download file: ${downloadResp.status}`);
  }

  const arrayBuffer = await downloadResp.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    filePath: fileInfo.result.file_path,
  };
}
