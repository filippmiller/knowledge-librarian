import prisma from '@/lib/db';
import type { TelegramUserRole } from '@prisma/client';

const TELEGRAM_SUPER_ADMIN = process.env.TELEGRAM_SUPER_ADMIN || '';

export interface TelegramUserInfo {
  id: string;
  telegramId: string;
  username: string | null;
  firstName: string | null;
  role: TelegramUserRole;
  isActive: boolean;
}

export type AccessResult =
  | { allowed: true; user: TelegramUserInfo }
  | { allowed: false; reason: string };

/**
 * Check if a Telegram user has access.
 * Auto-creates SUPER_ADMIN for the bootstrap user.
 */
export async function checkAccess(
  telegramId: string,
  username?: string,
  firstName?: string
): Promise<AccessResult> {
  // Look up user in DB
  let user = await prisma.telegramUser.findUnique({
    where: { telegramId },
  });

  // Auto-create super admin on first message
  if (!user && telegramId === TELEGRAM_SUPER_ADMIN) {
    user = await prisma.telegramUser.create({
      data: {
        telegramId,
        username: username || null,
        firstName: firstName || null,
        role: 'SUPER_ADMIN',
        isActive: true,
      },
    });
    console.log(`[access-control] Auto-created SUPER_ADMIN for ${telegramId}`);
  }

  // Not in DB and not super admin
  if (!user) {
    return {
      allowed: false,
      reason: 'not_registered',
    };
  }

  // Deactivated user
  if (!user.isActive) {
    return {
      allowed: false,
      reason: 'deactivated',
    };
  }

  // Update username/firstName if changed
  if (
    (username && username !== user.username) ||
    (firstName && firstName !== user.firstName)
  ) {
    await prisma.telegramUser.update({
      where: { telegramId },
      data: {
        ...(username && { username }),
        ...(firstName && { firstName }),
      },
    });
  }

  return {
    allowed: true,
    user: {
      id: user.id,
      telegramId: user.telegramId,
      username: user.username,
      firstName: user.firstName,
      role: user.role,
      isActive: user.isActive,
    },
  };
}

/**
 * Grant access to a new user.
 */
export async function grantAccess(
  targetTelegramId: string,
  grantedByTelegramId: string
): Promise<{ success: boolean; message: string }> {
  const existing = await prisma.telegramUser.findUnique({
    where: { telegramId: targetTelegramId },
  });

  if (existing) {
    if (existing.isActive) {
      return { success: false, message: `Пользователь ${targetTelegramId} уже имеет доступ (роль: ${existing.role})` };
    }
    // Reactivate
    await prisma.telegramUser.update({
      where: { telegramId: targetTelegramId },
      data: { isActive: true, grantedBy: grantedByTelegramId },
    });
    return { success: true, message: `Доступ восстановлен для ${targetTelegramId}` };
  }

  await prisma.telegramUser.create({
    data: {
      telegramId: targetTelegramId,
      role: 'USER',
      grantedBy: grantedByTelegramId,
      isActive: true,
    },
  });

  return { success: true, message: `Доступ предоставлен пользователю ${targetTelegramId} (роль: USER)` };
}

/**
 * Revoke access (deactivate).
 */
export async function revokeAccess(
  targetTelegramId: string,
  revokedByTelegramId: string
): Promise<{ success: boolean; message: string }> {
  const target = await prisma.telegramUser.findUnique({
    where: { telegramId: targetTelegramId },
  });

  if (!target) {
    return { success: false, message: `Пользователь ${targetTelegramId} не найден` };
  }

  // Cannot revoke super admin
  if (target.role === 'SUPER_ADMIN') {
    return { success: false, message: 'Нельзя отозвать доступ у суперадминистратора' };
  }

  // Admin cannot revoke another admin
  const revoker = await prisma.telegramUser.findUnique({
    where: { telegramId: revokedByTelegramId },
  });
  if (revoker?.role === 'ADMIN' && target.role === 'ADMIN') {
    return { success: false, message: 'Администратор не может отозвать доступ у другого администратора' };
  }

  await prisma.telegramUser.update({
    where: { telegramId: targetTelegramId },
    data: { isActive: false },
  });

  return { success: true, message: `Доступ отозван у пользователя ${targetTelegramId}` };
}

/**
 * Promote USER to ADMIN.
 */
export async function promoteUser(
  targetTelegramId: string
): Promise<{ success: boolean; message: string }> {
  const target = await prisma.telegramUser.findUnique({
    where: { telegramId: targetTelegramId },
  });

  if (!target) {
    return { success: false, message: `Пользователь ${targetTelegramId} не найден` };
  }

  if (target.role === 'ADMIN' || target.role === 'SUPER_ADMIN') {
    return { success: false, message: `Пользователь уже имеет роль ${target.role}` };
  }

  await prisma.telegramUser.update({
    where: { telegramId: targetTelegramId },
    data: { role: 'ADMIN' },
  });

  return { success: true, message: `Пользователь ${targetTelegramId} повышен до ADMIN` };
}

/**
 * Demote ADMIN to USER.
 */
export async function demoteUser(
  targetTelegramId: string
): Promise<{ success: boolean; message: string }> {
  const target = await prisma.telegramUser.findUnique({
    where: { telegramId: targetTelegramId },
  });

  if (!target) {
    return { success: false, message: `Пользователь ${targetTelegramId} не найден` };
  }

  if (target.role === 'SUPER_ADMIN') {
    return { success: false, message: 'Нельзя понизить суперадминистратора' };
  }

  if (target.role === 'USER') {
    return { success: false, message: 'Пользователь уже имеет роль USER' };
  }

  await prisma.telegramUser.update({
    where: { telegramId: targetTelegramId },
    data: { role: 'USER' },
  });

  return { success: true, message: `Пользователь ${targetTelegramId} понижен до USER` };
}

/**
 * List all active users.
 */
export async function listUsers(): Promise<TelegramUserInfo[]> {
  const users = await prisma.telegramUser.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });

  return users.map((u) => ({
    id: u.id,
    telegramId: u.telegramId,
    username: u.username,
    firstName: u.firstName,
    role: u.role,
    isActive: u.isActive,
  }));
}

/**
 * Check if a user has admin role (ADMIN or SUPER_ADMIN).
 */
export function isAdmin(role: TelegramUserRole): boolean {
  return role === 'ADMIN' || role === 'SUPER_ADMIN';
}

/**
 * Check if a user is super admin.
 */
export function isSuperAdmin(role: TelegramUserRole): boolean {
  return role === 'SUPER_ADMIN';
}

/**
 * Get Telegram IDs of all active admins (ADMIN + SUPER_ADMIN).
 */
export async function getAdminTelegramIds(): Promise<string[]> {
  const admins = await prisma.telegramUser.findMany({
    where: { isActive: true, role: { in: ['ADMIN', 'SUPER_ADMIN'] } },
    select: { telegramId: true },
  });
  return admins.map((a) => a.telegramId);
}

/**
 * Get Telegram IDs of all active users (all roles).
 */
export async function getAllActiveTelegramIds(): Promise<string[]> {
  const users = await prisma.telegramUser.findMany({
    where: { isActive: true },
    select: { telegramId: true },
  });
  return users.map((u) => u.telegramId);
}
