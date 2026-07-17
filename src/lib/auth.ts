import { NextRequest, NextResponse } from 'next/server';
import { compare, hash } from 'bcryptjs';
import type { UserRole } from '@prisma/client';
import { prisma } from './db';
import { getSession } from './session';

export interface AuthenticatedUser {
  userId: string;
  username: string;
  role: UserRole;
}

export function getBasicAuthCredentials(
  request: NextRequest
): { username: string; password: string } | null {
  const authHeader = request.headers.get('authorization');

  if (!authHeader || !authHeader.startsWith('Basic ')) {
    return null;
  }

  const base64Credentials = authHeader.split(' ')[1];
  const credentials = Buffer.from(base64Credentials, 'base64').toString('utf-8');
  const [username, password] = credentials.split(':');

  return { username, password };
}

export async function validateUser(
  username: string,
  password: string
): Promise<{ id: string; username: string; role: UserRole } | null> {
  try {
    const user = await prisma.user.findUnique({
      where: { username: username.toLowerCase() },
    });

    if (!user) {
      return null;
    }

    const isValid = await compare(password, user.passwordHash);

    if (isValid) {
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });
    }

    return isValid
      ? { id: user.id, username: user.username, role: user.role }
      : null;
  } catch (error) {
    console.error('Auth validation error:', error);
    return null;
  }
}

async function resolveUser(
  request: NextRequest
): Promise<AuthenticatedUser | null> {
  // Prefer cookie-based session (normal browser flow).
  const session = await getSession(request);
  if (session) {
    return {
      userId: session.userId,
      username: session.username,
      role: session.role,
    };
  }

  // Fall back to Basic Auth for scripts/integrations that already use it.
  const credentials = getBasicAuthCredentials(request);
  if (!credentials) return null;

  const user = await validateUser(credentials.username, credentials.password);
  return user
    ? { userId: user.id, username: user.username, role: user.role }
    : null;
}

/**
 * Require a valid admin session or Basic Auth credentials for API routes.
 * Returns a JSON 401 response (no browser prompt) on failure.
 */
export async function requireAdminAuth(
  request: NextRequest
): Promise<NextResponse | null> {
  const user = await resolveUser(request);

  if (!user) {
    return createAuthResponse();
  }

  return null;
}

/**
 * Return the authenticated principal (user id + username + role) for
 * authorization decisions and audit logging.
 */
export async function getAuthenticatedUser(
  request: NextRequest
): Promise<AuthenticatedUser | null> {
  return resolveUser(request);
}

export function createAuthResponse(): NextResponse {
  return NextResponse.json(
    { error: 'Unauthorized' },
    { status: 401 }
  );
}

// Utility function to hash passwords (for seeding/user creation)
export async function hashPassword(password: string): Promise<string> {
  return hash(password, 12);
}
