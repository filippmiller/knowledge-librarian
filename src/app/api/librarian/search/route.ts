import { NextRequest, NextResponse } from 'next/server';
import { searchKnowledge } from '@/lib/librarian-service';
import { checkRateLimit, getClientKey, RATE_LIMITS } from '@/lib/rate-limiter';

export async function POST(request: NextRequest): Promise<Response> {
  // Rate limiting for public endpoint
  const clientKey = getClientKey(request);
  const rateLimitResult = checkRateLimit(clientKey, RATE_LIMITS.librarianSearch);

  if (!rateLimitResult.allowed) {
    return NextResponse.json(
      {
        error: 'Rate limit exceeded',
        retryAfterMs: rateLimitResult.retryAfterMs,
        resetAt: rateLimitResult.resetAt.toISOString(),
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(Math.ceil((rateLimitResult.retryAfterMs || 0) / 1000)),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Reset': rateLimitResult.resetAt.toISOString(),
        },
      }
    );
  }

  try {
    const body = await request.json();

    // Validate required fields
    if (!body.query || typeof body.query !== 'string') {
      return NextResponse.json({ error: 'query is required' }, { status: 400 });
    }
    if (body.query.length > 2000) {
      return NextResponse.json({ error: 'query exceeds 2000 characters' }, { status: 400 });
    }

    // Validate verificationStatuses if provided
    const validStatuses = ['UNVERIFIED', 'VERIFIED', 'CANONICAL', 'DISPUTED', 'STALE'];
    if (body.verificationStatuses) {
      if (!Array.isArray(body.verificationStatuses)) {
        return NextResponse.json(
          { error: 'verificationStatuses must be an array' },
          { status: 400 }
        );
      }
      for (const status of body.verificationStatuses) {
        if (!validStatuses.includes(status)) {
          return NextResponse.json(
            { error: `Invalid status: ${status}. Must be one of: ${validStatuses.join(', ')}` },
            { status: 400 }
          );
        }
      }
    }

    const result = await searchKnowledge({
      query: body.query,
      domainSlug: body.domainSlug,
      limit: Math.min(body.limit ?? 10, 50),
      minFreshness: body.minFreshness,
      verificationStatuses: body.verificationStatuses,
      agentId: body.agentId,
    });

    const response = NextResponse.json(result);
    response.headers.set('X-RateLimit-Remaining', String(rateLimitResult.remaining));
    response.headers.set('X-RateLimit-Reset', rateLimitResult.resetAt.toISOString());

    return response;
  } catch (error) {
    console.error('Error searching knowledge:', error);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}
