/**
 * Registers the Telegram webhook WITH a secret_token so the /api/telegram
 * endpoint can verify that incoming updates genuinely come from Telegram.
 *
 * Run with Railway env (so the bot token never leaves the platform):
 *   railway run node scripts/set-telegram-webhook.mjs
 *
 * Requires env: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, NEXT_PUBLIC_APP_URL
 * Re-run after rotating TELEGRAM_WEBHOOK_SECRET.
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const appUrl = process.env.NEXT_PUBLIC_APP_URL;

if (!token || !secret || !appUrl) {
  console.error('Missing env: need TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, NEXT_PUBLIC_APP_URL');
  process.exit(1);
}

const api = (method) => `https://api.telegram.org/bot${token}/${method}`;
const webhookUrl = `${appUrl.replace(/\/$/, '')}/api/telegram`;

const j = async (res) => {
  const data = await res.json();
  if (!data.ok) throw new Error(`${data.error_code}: ${data.description}`);
  return data.result;
};

// Preserve any existing allowed_updates so we don't silently change delivery.
const info = await j(await fetch(api('getWebhookInfo')));
const allowed = info.allowed_updates;

const body = {
  url: webhookUrl,
  secret_token: secret,
  drop_pending_updates: false,
  ...(allowed && allowed.length ? { allowed_updates: allowed } : {}),
};

await j(await fetch(api('setWebhook'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}));

const after = await j(await fetch(api('getWebhookInfo')));
console.log('Webhook registered with secret_token.');
console.log('  url:', after.url);
console.log('  has_custom_certificate:', after.has_custom_certificate);
console.log('  pending_update_count:', after.pending_update_count);
console.log('  last_error_message:', after.last_error_message || '(none)');
