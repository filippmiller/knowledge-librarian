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
    // Escape special Markdown characters
    const safeText = part.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');

    try {
      let resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: safeText,
          parse_mode: 'MarkdownV2',
        }),
      });

      // If MarkdownV2 fails, send as plain text
      if (!resp.ok) {
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: part }),
        });
      }
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
