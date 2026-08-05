/**
 * Read-only inspector for QAPair rows, filtered by a substring in `question`.
 * Used to find/verify temp benchmark QAPairs (marker prefix "TESTBENCH:").
 *
 * Usage: railway run npx tsx scripts/inspect-qa-pair.ts "TESTBENCH:"
 */
import prisma from '../src/lib/db';

async function main() {
  const marker = process.argv[2] || 'TESTBENCH:';
  const rows = await prisma.qAPair.findMany({
    where: { question: { contains: marker } },
    orderBy: { createdAt: 'desc' },
  });
  console.log(`Found ${rows.length} QAPair rows matching "${marker}":\n`);
  for (const r of rows) {
    console.log(`id=${r.id}  status=${r.status}  audience=${r.audience}  scenarioKey=${r.scenarioKey}`);
    console.log(`  Q: ${r.question.slice(0, 120)}`);
    console.log(`  A: ${r.answer.slice(0, 100)}`);
    console.log('');
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
