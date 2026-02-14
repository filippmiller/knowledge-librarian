import { PrismaClient } from '../src/generated/prisma/index.js';
const p = new PrismaClient();
const users = await p.telegramUser.findMany({ orderBy: { createdAt: 'asc' } });
for (const u of users) {
  console.log(`${u.telegramId} | ${u.username || '-'} | ${u.role} | ${u.isActive ? 'active' : 'inactive'}`);
}
await p.$disconnect();
