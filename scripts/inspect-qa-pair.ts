import prisma from '../src/lib/db';

async function main() {
  const id = process.argv[2];
  const qa = await prisma.qAPair.findUnique({ where: { id } });
  console.log(JSON.stringify(qa, null, 2));
  await prisma.$disconnect();
}
main();
