import { NextRequest, NextResponse } from 'next/server';

/**
 * Middleware to protect admin pages with HTTP Basic Auth.
 *
 * When the browser receives a 401 with WWW-Authenticate: Basic,
 * it prompts for credentials and caches them for the domain.
 * All subsequent requests (including fetch() from JS) will
 * automatically include the cached Authorization header.
 */
export function middleware(request: NextRequest) {
  const authHeader = request.headers.get('authorization');

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return new NextResponse('Unauthorized', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Admin Area"',
      },
    });
  }

  // Let the request through - API routes will validate the actual credentials
  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*'],
};
