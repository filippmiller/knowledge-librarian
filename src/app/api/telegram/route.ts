import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { handleUpdate } from '@/lib/telegram/message-router';
import type { TelegramUpdate } from '@/lib/telegram/telegram-api';
import { sendMessage, setBotCommands, setMenuButton } from '@/lib/telegram/telegram-api';

// Register slash commands once on module load
let commandsRegistered = false;

/**
 * Verify the request actually originates from Telegram.
 * Telegram echoes the `secret_token` configured via setWebhook in this header.
 * Without this, anyone could POST forged updates with an arbitrary `telegramId`
 * and drive the bot's admin command handlers (access control trusts that id).
 */
function isFromTelegram(request: NextRequest): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
  if (!expected) {
    // Refuse to process unverifiable traffic rather than trusting it.
    console.error('[telegram] TELEGRAM_WEBHOOK_SECRET not set — rejecting webhook call');
    return false;
  }
  const provided = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  // Reject anything that isn't a verified Telegram callback. Return 200 + ok so
  // we don't leak whether the secret matched or hand attackers a retry signal.
  if (!isFromTelegram(request)) {
    return NextResponse.json({ ok: true });
  }

  // Register commands on first incoming message (lazy init)
  if (!commandsRegistered) {
    commandsRegistered = true;
    setBotCommands().catch(() => {});
    setMenuButton().catch(() => {});
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
    await setMenuButton();
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://avrora-library-production.up.railway.app';

  return NextResponse.json({
    status: 'ok',
    bot: process.env.TELEGRAM_BOT_TOKEN ? 'configured' : 'not configured',
    accessControl: 'database',
    commandsRegistered,
    miniApp: {
      url: `${appUrl}/telegram-app`,
      status: 'active',
    },
  });
}
