// Check if HallucinationLog received any entries after the battery run.
// Tells us whether the consistency gate is actually writing telemetry.

import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const total = await p.hallucinationLog.count();
  console.log(`HallucinationLog total rows: ${total}`);
  const recent = await p.hallucinationLog.findMany({
    take: 10,
    orderBy: { createdAt: 'desc' },
    select: {
      createdAt: true,
      question: true,
      scenarioKey: true,
      unsupportedCount: true,
      regenerated: true,
      unsupportedClaims: true,
    },
  });
  for (const r of recent) {
    console.log(`\n${r.createdAt.toISOString()}  [${r.scenarioKey ?? '—'}]  "${r.question.slice(0, 60)}..."`);
    console.log(`  unsupported: ${r.unsupportedCount}, regenerated: ${r.regenerated}`);
    const claims = Array.isArray(r.unsupportedClaims) ? r.unsupportedClaims : [];
    for (const c of claims.slice(0, 3)) {
      const claim = typeof c === 'object' && c && 'claim' in c ? (c as { claim: string }).claim : String(c);
      console.log(`    - "${String(claim).slice(0, 100)}"`);
    }
  }
}
main().catch((e)=>{console.error(e);process.exit(1);}).finally(()=>p.$disconnect());
