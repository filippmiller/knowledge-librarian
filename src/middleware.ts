import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, SESSION_COOKIE } from '@/lib/session';

/**
 * Middleware protects /admin pages with cookie-based sessions.
 * Unauthenticated visitors are redirected to /login.
 * Already-authenticated visitors hitting /login are sent to /admin.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;
  const isAuthenticated = Boolean(session);

  // Redirect logged-in users away from the login page.
  if (pathname === '/login' || pathname.startsWith('/login/')) {
    if (isAuthenticated) {
      return NextResponse.redirect(new URL('/admin', request.url));
    }
    return NextResponse.next();
  }

  // Protect admin area.
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    if (!isAuthenticated) {
      const loginUrl = new URL('/login', request.url);
      loginUrl.searchParams.set('callbackUrl', request.nextUrl.pathname + request.nextUrl.search);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin/:path*', '/login', '/login/:path*'],
};
