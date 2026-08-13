/**
 * Deprecate (status=DEPRECATED) all QAPair rows whose question contains a marker
 * substring. Used to clean up temp benchmark data after the retrieval audit.
 *
 * Usage: railway run npx tsx scripts/deprecate-qa-pair.ts "TESTBENCH:"
 */
import prisma from '../src/lib/db';

async function main() {
  const marker = process.argv[2] || 'TESTBENCH:';
  const matches = await prisma.qAPair.findMany({
    where: { question: { contains: marker } },
    select: { id: true },
  });
  if (matches.length === 0) {
    console.log(`No QAPair rows found matching "${marker}". Nothing to deprecate.`);
    await prisma.$disconnect();
    return;
  }
  const result = await prisma.qAPair.updateMany({
    where: { id: { in: matches.map((m) => m.id) } },
    data: { status: 'DEPRECATED' },
  });
  console.log(`Deprecated ${result.count} QAPair rows matching "${marker}".`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
