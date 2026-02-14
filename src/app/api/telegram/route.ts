import { NextRequest, NextResponse } from 'next/server';
import { handleUpdate } from '@/lib/telegram/message-router';
import type { TelegramUpdate } from '@/lib/telegram/telegram-api';
import { sendMessage } from '@/lib/telegram/telegram-api';

export async function POST(request: NextRequest) {
  try {
    const update: TelegramUpdate = await request.json();
    await handleUpdate(update);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook error:', error);
    // Try to send error message to user
    try {
      const update: TelegramUpdate = await request.clone().json();
      if (update.message?.chat?.id) {
        await sendMessage(
          update.message.chat.id,
          'Произошла ошибка. Попробуйте позже.'
        );
      }
    } catch {
      // Ignore
    }
    // Always return 200 to Telegram to prevent retries
    return NextResponse.json({ ok: true });
  }
}

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    bot: process.env.TELEGRAM_BOT_TOKEN ? 'configured' : 'not configured',
    accessControl: 'database',
  });
}
