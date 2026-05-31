import { NextRequest, NextResponse } from 'next/server';
import { compare, hash } from 'bcryptjs';
import type { UserRole } from '@prisma/client';
import { prisma } from './db';

export interface AuthenticatedUser {
  username: string;
  role: UserRole;
}

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

export async function validateUser(username: string, password: string): Promise<boolean> {
  try {
    const user = await prisma.user.findUnique({
      where: { username: username.toLowerCase() },
    });

    if (!user) {
      return false;
    }

    const isValid = await compare(password, user.passwordHash);

    if (isValid) {
      // Update last login time
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
    }

    return isValid;
  } catch (error) {
    console.error('Auth validation error:', error);
    return false;
  }
}

export async function requireAdminAuth(request: NextRequest): Promise<NextResponse | null> {
  const credentials = getBasicAuthCredentials(request);

  if (!credentials) {
    return createAuthResponse();
  }

  const isValid = await validateUser(credentials.username, credentials.password);

  if (!isValid) {
    return createAuthResponse();
  }

  return null;
}

/**
 * Validate Basic-Auth credentials and return the authenticated principal
 * (username + role) WITHOUT mutating lastLoginAt. Use for authorization
 * decisions where the role matters or the acting user must be recorded — e.g.
 * who may write to the knowledge base, and whose name to stamp as approver.
 * Returns null when the header is missing or the credentials are invalid.
 */
export async function getAuthenticatedUser(
  request: NextRequest
): Promise<AuthenticatedUser | null> {
  const credentials = getBasicAuthCredentials(request);
  if (!credentials) return null;
  try {
    const user = await prisma.user.findUnique({
      where: { username: credentials.username.toLowerCase() },
    });
    if (!user) return null;
    const ok = await compare(credentials.password, user.passwordHash);
    return ok ? { username: user.username, role: user.role } : null;
  } catch (error) {
    console.error('Auth principal lookup error:', error);
    return null;
  }
}

export function createAuthResponse(): NextResponse {
  return new NextResponse('Unauthorized', {
    status: 401,
    headers: {
      'WWW-Authenticate': 'Basic realm="Admin Area"',
    },
  });
}

// Utility function to hash passwords (for seeding/user creation)
export async function hashPassword(password: string): Promise<string> {
  return hash(password, 12);
}
