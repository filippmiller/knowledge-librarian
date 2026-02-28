import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const users = await prisma.telegramUser.findMany({ orderBy: { createdAt: 'desc' }, take: 20 });
console.log(JSON.stringify(users, null, 2));
await prisma.$disconnect();
