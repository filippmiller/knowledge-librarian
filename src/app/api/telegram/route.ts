import { NextRequest, NextResponse } from 'next/server';
import { answerQuestionEnhanced } from '@/lib/ai/enhanced-answering-engine';
import { getOrCreateSession, saveChatMessage } from '@/lib/ai/answering-engine';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Allowed Telegram user IDs (empty = allow all)
const ALLOWED_USER_IDS = (process.env.TELEGRAM_ALLOWED_USERS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    text?: string;
    from?: { id: number; first_name: string; username?: string };
    date: number;
  };
}

async function sendMessage(chatId: number, text: string) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN not configured');
    return;
  }

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  // Escape special Markdown characters that might break formatting
  const safeText = text
    .replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');

  try {
    // Try MarkdownV2 first
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
        body: JSON.stringify({
          chat_id: chatId,
          text,
        }),
      });
    }
  } catch (error) {
    console.error('Error sending Telegram message:', error);
  }
}

async function sendTypingIndicator(chatId: number) {
  if (!TELEGRAM_BOT_TOKEN) return;

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendChatAction`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        action: 'typing',
      }),
    });
  } catch (error) {
    // Ignore typing indicator errors
  }
}

function isUserAllowed(userId?: string): boolean {
  // If no whitelist configured, allow everyone
  if (ALLOWED_USER_IDS.length === 0) return true;
  if (!userId) return false;
  return ALLOWED_USER_IDS.includes(userId);
}

export async function POST(request: NextRequest) {
  try {
    const update: TelegramUpdate = await request.json();

    // Verify we have a message with text
    if (!update.message?.text) {
      return NextResponse.json({ ok: true });
    }

    const chatId = update.message.chat.id;
    const question = update.message.text.trim();
    const userId = update.message.from?.id?.toString();
    const username = update.message.from?.username;
    const firstName = update.message.from?.first_name || 'User';

    // Access control
    if (!isUserAllowed(userId)) {
      await sendMessage(
        chatId,
        `Извините, ${firstName}, у вас нет доступа к этому боту. Обратитесь к администратору.`
      );
      console.log(`[telegram] Access denied for user ${userId} (@${username})`);
      return NextResponse.json({ ok: true });
    }

    // Handle /start command
    if (question === '/start') {
      await sendMessage(
        chatId,
        `Добро пожаловать, ${firstName}!\n\n` +
        'Я - бот базы знаний бюро переводов Аврора.\n\n' +
        'Задайте мне любой вопрос о работе бюро: цены, процедуры, нотариальные услуги, миграционные услуги и многое другое.\n\n' +
        'Примеры вопросов:\n' +
        '- Сколько стоит нотариальный перевод?\n' +
        '- Как отправить заказ почтой России?\n' +
        '- Какие миграционные услуги вы предоставляете?\n' +
        '- Как работать с договорами юрлиц?\n\n' +
        'Команды:\n' +
        '/start - Приветствие\n' +
        '/help - Помощь'
      );
      return NextResponse.json({ ok: true });
    }

    // Handle /help command
    if (question === '/help') {
      await sendMessage(
        chatId,
        'Команды:\n' +
        '/start - Приветствие\n' +
        '/help - Эта справка\n\n' +
        'Просто напишите свой вопрос, и я найду ответ в базе знаний.'
      );
      return NextResponse.json({ ok: true });
    }

    // Validate question length
    if (question.length > 2000) {
      await sendMessage(chatId, 'Вопрос слишком длинный. Максимум 2000 символов.');
      return NextResponse.json({ ok: true });
    }

    // Show typing indicator while processing
    await sendTypingIndicator(chatId);

    console.log(`[telegram] Question from ${userId} (@${username}): ${question.substring(0, 100)}`);

    // Create or get session for this user
    const session = await getOrCreateSession('TELEGRAM', userId);

    // Save user message
    await saveChatMessage(session.id, 'USER', question);

    // Process the question using the enhanced engine
    const result = await answerQuestionEnhanced(question, session.id);

    // Save assistant message
    await saveChatMessage(session.id, 'ASSISTANT', result.answer, {
      confidence: result.confidence,
      confidenceLevel: result.confidenceLevel,
      domainsUsed: result.domainsUsed,
      citationCount: result.citations.length,
    });

    // Format response for Telegram
    let response = result.answer;

    // Add citations if available
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

    // Add confidence indicator
    const confLabel = result.confidenceLevel === 'high' ? 'Высокая'
      : result.confidenceLevel === 'medium' ? 'Средняя'
      : result.confidenceLevel === 'low' ? 'Низкая'
      : 'Недостаточная';
    response += `\n\nУверенность: ${confLabel} (${(result.confidence * 100).toFixed(0)}%)`;

    // Send the response
    await sendMessage(chatId, response);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook error:', error);
    // Try to send error message to user
    try {
      const update: TelegramUpdate = await request.clone().json();
      if (update.message?.chat?.id) {
        await sendMessage(
          update.message.chat.id,
          'Произошла ошибка при обработке вашего вопроса. Попробуйте позже.'
        );
      }
    } catch {
      // Ignore - can't parse the request again
    }
    // Always return 200 to Telegram to prevent retries
    return NextResponse.json({ ok: true });
  }
}

// Health check for webhook verification
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    bot: TELEGRAM_BOT_TOKEN ? 'configured' : 'not configured',
    accessControl: ALLOWED_USER_IDS.length > 0 ? 'whitelist' : 'open',
  });
}
