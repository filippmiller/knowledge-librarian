import { NextRequest, NextResponse } from 'next/server';
import { answerQuestion, getOrCreateSession, saveChatMessage } from '@/lib/ai/answering-engine';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

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

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
      }),
    });
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

    // Handle /start command
    if (question === '/start') {
      await sendMessage(
        chatId,
        '*Welcome to the Knowledge Librarian Bot!*\n\n' +
        'Ask me any question about translation bureau operations, ' +
        'pricing, notary services, and more.\n\n' +
        'Just type your question and I will answer based on our knowledge base.\n\n' +
        '_Examples:_\n' +
        '- Сколько стоит НЗП?\n' +
        '- Как оформить нотариальный перевод?\n' +
        '- Какие языки поддерживаются?'
      );
      return NextResponse.json({ ok: true });
    }

    // Handle /help command
    if (question === '/help') {
      await sendMessage(
        chatId,
        '*Available Commands:*\n\n' +
        '/start - Welcome message\n' +
        '/help - Show this help\n\n' +
        'Or just type any question to search the knowledge base.'
      );
      return NextResponse.json({ ok: true });
    }

    // Show typing indicator while processing
    await sendTypingIndicator(chatId);

    // Create or get session for this user
    const session = await getOrCreateSession('TELEGRAM', userId);

    // Save user message
    await saveChatMessage(session.id, 'USER', question);

    // Process the question
    const result = await answerQuestion(question);

    // Save assistant message
    await saveChatMessage(session.id, 'ASSISTANT', result.answer, {
      confidence: result.confidence,
      domainsUsed: result.domainsUsed,
    });

    // Format response for Telegram
    let response = result.answer;

    // Add citations if available
    if (result.citations.length > 0) {
      response += '\n\n*Sources:*';
      for (const citation of result.citations.slice(0, 3)) {
        if (citation.ruleCode) {
          response += `\n• ${citation.ruleCode}`;
          if (citation.documentTitle) {
            response += ` (${citation.documentTitle})`;
          }
        }
      }
    }

    // Add confidence indicator
    const confidenceEmoji = result.confidence >= 0.8 ? 'High' : result.confidence >= 0.5 ? 'Medium' : 'Low';
    response += `\n\n_Confidence: ${confidenceEmoji} (${(result.confidence * 100).toFixed(0)}%)_`;

    // Send the response
    await sendMessage(chatId, response);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook error:', error);
    // Always return 200 to Telegram to prevent retries
    return NextResponse.json({ ok: true });
  }
}

// Health check for webhook verification
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    bot: TELEGRAM_BOT_TOKEN ? 'configured' : 'not configured',
  });
}
