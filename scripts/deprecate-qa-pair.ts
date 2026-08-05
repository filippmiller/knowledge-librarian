import prisma from '../src/lib/db';

async function main() {
  const id = process.argv[2];
  await prisma.qAPair.update({ where: { id }, data: { status: 'DEPRECATED' } });
  console.log('deprecated', id);
  await prisma.$disconnect();
}
main();
