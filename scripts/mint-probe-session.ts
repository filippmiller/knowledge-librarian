/**
 * Печатает готовую cookie-строку для PROBE_COOKIE (scripts/live-corpus-run.mjs,
 * scripts/probe-live-contours.ts), не трогая пароль владельца. Использует ТОТ ЖЕ
 * createSessionToken, что и /api/auth/login — просто минует шаг проверки пароля,
 * потому что у нас уже есть прямой доступ к БД и SESSION_SECRET.
 */
import prisma from '../src/lib/db';
import { createSessionToken, SESSION_COOKIE } from '../src/lib/session';

async function main() {
  const username = process.argv[2] ?? 'filipp';
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) throw new Error(`User ${username} not found`);
  const token = await createSessionToken({ userId: user.id, username: user.username, role: user.role });
  console.log(`${SESSION_COOKIE}=${token}`);
  await prisma.$disconnect();
}
main();
