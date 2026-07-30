/** Идёт ли прогон: свежие записи, которые движок оставляет по ходу работы. */
import prisma from '../src/lib/db';

async function main() {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const logs = await prisma.hallucinationLog.findMany({
    where: { createdAt: { gte: since } },
    select: { createdAt: true, question: true },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  console.log(`Записей HallucinationLog за последний час: ${logs.length}`);
  for (const l of logs) {
    console.log(`  ${l.createdAt.toISOString().slice(11, 19)}  ${l.question.slice(0, 70)}`);
  }
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(String(e).slice(0, 300));
  await prisma.$disconnect();
  process.exit(1);
});
