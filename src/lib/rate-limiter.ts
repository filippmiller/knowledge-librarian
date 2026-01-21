/**
 * Rate Limiter Module
 *
 * Provides token bucket rate limiting for API endpoints.
 * Uses in-memory storage by default, designed to be easily upgraded to Redis.
 */

export interface RateLimitConfig {
  windowMs: number;      // Time window in milliseconds
  maxRequests: number;   // Max requests per window
  keyPrefix?: string;    // Prefix for rate limit keys
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  retryAfterMs?: number;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory store (can be replaced with Redis)
const store = new Map<string, RateLimitEntry>();

// Cleanup old entries periodically
const CLEANUP_INTERVAL = 60000; // 1 minute
let cleanupTimer: NodeJS.Timeout | null = null;

function startCleanup() {
  if (cleanupTimer) return;

  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store.entries()) {
      if (entry.resetAt < now) {
        store.delete(key);
      }
    }
  }, CLEANUP_INTERVAL);

  // Don't keep process alive just for cleanup
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

startCleanup();

/**
 * Check rate limit for a key
 */
export function checkRateLimit(
  key: string,
  config: RateLimitConfig
): RateLimitResult {
  const now = Date.now();
  const fullKey = config.keyPrefix ? `${config.keyPrefix}:${key}` : key;

  let entry = store.get(fullKey);

  // Create new entry or reset if window expired
  if (!entry || entry.resetAt < now) {
    entry = {
      count: 0,
      resetAt: now + config.windowMs,
    };
    store.set(fullKey, entry);
  }

  // Check if limit exceeded
  if (entry.count >= config.maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: new Date(entry.resetAt),
      retryAfterMs: entry.resetAt - now,
    };
  }

  // Increment count
  entry.count++;

  return {
    allowed: true,
    remaining: config.maxRequests - entry.count,
    resetAt: new Date(entry.resetAt),
  };
}

/**
 * Get client identifier from request
 */
export function getClientKey(request: Request): string {
  // Try various headers for client identification
  const forwarded = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');
  const cfIp = request.headers.get('cf-connecting-ip');

  // Use first IP from forwarded header
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  return cfIp || realIp || 'unknown';
}

/**
 * Default rate limit configurations
 */
export const RATE_LIMITS = {
  // Public question endpoint - generous but protected
  askQuestion: {
    windowMs: 60 * 1000,   // 1 minute
    maxRequests: 20,       // 20 requests per minute
    keyPrefix: 'ask',
  } as RateLimitConfig,

  // Admin API - more generous
  adminApi: {
    windowMs: 60 * 1000,
    maxRequests: 100,
    keyPrefix: 'admin',
  } as RateLimitConfig,

  // Document upload - strict
  documentUpload: {
    windowMs: 60 * 60 * 1000,  // 1 hour
    maxRequests: 10,           // 10 uploads per hour
    keyPrefix: 'upload',
  } as RateLimitConfig,

  // Embedding generation - expensive operation
  embedding: {
    windowMs: 60 * 1000,
    maxRequests: 50,
    keyPrefix: 'embed',
  } as RateLimitConfig,

  // Librarian search - public endpoint with rate limiting
  librarianSearch: {
    windowMs: 60 * 1000,   // 1 minute
    maxRequests: 30,       // 30 searches per minute
    keyPrefix: 'librarian-search',
  } as RateLimitConfig,
};

/**
 * Rate limit middleware helper
 */
export function withRateLimit(
  handler: (request: Request) => Promise<Response>,
  config: RateLimitConfig
): (request: Request) => Promise<Response> {
  return async (request: Request) => {
    const clientKey = getClientKey(request);
    const result = checkRateLimit(clientKey, config);

    if (!result.allowed) {
      return new Response(
        JSON.stringify({
          error: 'Rate limit exceeded',
          retryAfterMs: result.retryAfterMs,
          resetAt: result.resetAt.toISOString(),
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(Math.ceil((result.retryAfterMs || 0) / 1000)),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': result.resetAt.toISOString(),
          },
        }
      );
    }

    // Add rate limit headers to successful response
    const response = await handler(request);

    // Clone response to add headers
    const newResponse = new Response(response.body, response);
    newResponse.headers.set('X-RateLimit-Remaining', String(result.remaining));
    newResponse.headers.set('X-RateLimit-Reset', result.resetAt.toISOString());

    return newResponse;
  };
}

/**
 * Reset rate limit for a key (useful for testing)
 */
export function resetRateLimit(key: string, prefix?: string): void {
  const fullKey = prefix ? `${prefix}:${key}` : key;
  store.delete(fullKey);
}

/**
 * Get current rate limit status (for monitoring)
 */
export function getRateLimitStatus(
  key: string,
  config: RateLimitConfig
): { currentCount: number; limit: number; resetAt: Date | null } {
  const fullKey = config.keyPrefix ? `${config.keyPrefix}:${key}` : key;
  const entry = store.get(fullKey);

  if (!entry || entry.resetAt < Date.now()) {
    return { currentCount: 0, limit: config.maxRequests, resetAt: null };
  }

  return {
    currentCount: entry.count,
    limit: config.maxRequests,
    resetAt: new Date(entry.resetAt),
  };
}
