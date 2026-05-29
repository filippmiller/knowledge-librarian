import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const users = await p.telegramUser.findMany({
    select: { telegramId: true, username: true, firstName: true, role: true, isActive: true },
    take: 20,
  });
  console.log(`Total TelegramUser rows: ${users.length}`);
  for (const u of users) {
    console.log(`  ${u.telegramId}  @${u.username ?? '—'}  (${u.firstName ?? '?'})  role=${u.role} active=${u.isActive}`);
  }
}
main().catch((e)=>{console.error(e);process.exit(1);}).finally(()=>p.$disconnect());
