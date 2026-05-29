import crypto from 'crypto';

/**
 * Verify Telegram Web App init data
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-web-app
 */
export function verifyTelegramWebAppData(initData: string): {
  valid: boolean;
  userId?: string;
  user?: {
    id: number;
    first_name?: string;
    last_name?: string;
    username?: string;
    language_code?: string;
  };
} {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.error('[mini-app-auth] TELEGRAM_BOT_TOKEN not configured');
    return { valid: false };
  }

  try {
    // Parse init data
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { valid: false };

    // Remove hash from data_check_string
    params.delete('hash');

    // Sort params alphabetically
    const sortedParams = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = sortedParams.map(([k, v]) => `${k}=${v}`).join('\n');

    // Create secret key from bot token
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();

    // Verify hash
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (computedHash !== hash) {
      return { valid: false };
    }

    // Check auth_date is recent (within 24 hours)
    const authDate = parseInt(params.get('auth_date') || '0');
    const now = Math.floor(Date.now() / 1000);
    if (now - authDate > 86400) {
      return { valid: false };
    }

    // Parse user data
    const userJson = params.get('user');
    if (!userJson) return { valid: false };

    const user = JSON.parse(userJson);
    return {
      valid: true,
      userId: user.id.toString(),
      user,
    };
  } catch (error) {
    console.error('[mini-app-auth] Verification error:', error);
    return { valid: false };
  }
}

/**
 * Parse init data without verification (for development only)
 */
export function parseInitData(initData: string) {
  try {
    const params = new URLSearchParams(initData);
    const userJson = params.get('user');
    return {
      user: userJson ? JSON.parse(userJson) : null,
      authDate: parseInt(params.get('auth_date') || '0'),
      queryId: params.get('query_id'),
    };
  } catch {
    return null;
  }
}
