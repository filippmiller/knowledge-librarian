import prisma from '../src/lib/db';

async function main() {
  const users = await prisma.user.findMany({ select: { username: true, role: true } });
  console.log(JSON.stringify(users, null, 2));
  await prisma.$disconnect();
}
main();
