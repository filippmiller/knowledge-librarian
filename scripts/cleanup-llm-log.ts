/**
 * Retention for LlmCallLog.
 *
 * The table logs every model call (system prompt + raw response, up to
 * 20000 chars each) — useful for debugging prod incidents, but unbounded
 * growth turns it into a storage/cost problem within weeks at this call
 * volume (5-9 rows per user question). Default retention: 30 days, matching
 * the horizon incidents actually get investigated in. Run periodically
 * (e.g. weekly) via a scheduled task or manually after an investigation.
 *
 * Usage (DB lives on Railway, so wrap with `railway run`):
 *   railway run npx tsx scripts/cleanup-llm-log.ts            # delete rows older than 30 days
 *   railway run npx tsx scripts/cleanup-llm-log.ts --days=14  # custom retention window
 *   railway run npx tsx scripts/cleanup-llm-log.ts --dry-run  # count only, no delete
 */

import prisma from '../src/lib/db';

function parseArgs(argv: string[]) {
  let days = 30;
  let dryRun = false;
  for (const raw of argv) {
    if (raw === '--dry-run') dryRun = true;
    const m = raw.match(/^--days=(\d+)$/);
    if (m) days = Number(m[1]);
  }
  return { days, dryRun };
}

async function main() {
  const { days, dryRun } = parseArgs(process.argv.slice(2));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const count = await prisma.llmCallLog.count({ where: { createdAt: { lt: cutoff } } });

  if (dryRun) {
    console.log(`[dry-run] ${count} записей LlmCallLog старше ${days} дней (до ${cutoff.toISOString()}) — не удалено.`);
    await prisma.$disconnect();
    return;
  }

  const result = await prisma.llmCallLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
  console.log(`Удалено ${result.count} записей LlmCallLog старше ${days} дней (до ${cutoff.toISOString()}).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
