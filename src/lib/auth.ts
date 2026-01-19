import { NextRequest, NextResponse } from 'next/server';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

export function getBasicAuthCredentials(request: NextRequest): { username: string; password: string } | null {
  const authHeader = request.headers.get('authorization');

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return null;
  }

  const base64Credentials = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
  const [username, password] = credentials.split(':');

  return { username, password };
}

export function isValidAdmin(password: string): boolean {
  return password === ADMIN_PASSWORD;
}

export function requireAdminAuth(request: NextRequest): NextResponse | null {
  const credentials = getBasicAuthCredentials(request);

  if (!credentials || !isValidAdmin(credentials.password)) {
    return new NextResponse('Unauthorized', {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Basic realm="Admin Area"',
      },
    });
  }

  return null;
}

export function createAuthResponse(): NextResponse {
  return new NextResponse('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Admin Area"',
    },
  });
}
