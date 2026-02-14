import { NextRequest, NextResponse } from 'next/server';
import { handleUpdate } from '@/lib/telegram/message-router';
import type { TelegramUpdate } from '@/lib/telegram/telegram-api';
import { sendMessage, setBotCommands } from '@/lib/telegram/telegram-api';

// Register slash commands once on module load
let commandsRegistered = false;

export async function POST(request: NextRequest) {
  // Register commands on first incoming message (lazy init)
  if (!commandsRegistered) {
    commandsRegistered = true;
    setBotCommands().catch(() => {});
  }

  try {
    const update: TelegramUpdate = await request.json();
    await handleUpdate(update);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Telegram webhook error:', error);
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
    return NextResponse.json({ ok: true });
  }
}

export async function GET() {
  // Register commands on health check too
  if (!commandsRegistered) {
    commandsRegistered = true;
    await setBotCommands();
  }

  return NextResponse.json({
    status: 'ok',
    bot: process.env.TELEGRAM_BOT_TOKEN ? 'configured' : 'not configured',
    accessControl: 'database',
    commandsRegistered,
  });
}
