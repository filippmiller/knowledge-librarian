import prisma from '../src/lib/db';

async function main() {
  const total = await prisma.$queryRaw<Array<{ count: bigint }>>`SELECT COUNT(*)::bigint as count FROM "LlmCallLog"`;
  console.log('LlmCallLog total rows:', total[0].count);

  const bySite = await prisma.$queryRaw<Array<{ callsite: string; n: bigint; avgms: number }>>`
    SELECT "callSite" as callsite, COUNT(*)::bigint as n, AVG("latencyMs")::int as avgms
    FROM "LlmCallLog" GROUP BY "callSite" ORDER BY n DESC LIMIT 30
  `;
  console.log('\n=== calls by callSite ===');
  for (const r of bySite) console.log(`  ${r.callsite}: n=${r.n} avgLatencyMs=${r.avgms}`);

  const byModel = await prisma.$queryRaw<Array<{ model: string; n: bigint }>>`
    SELECT model, COUNT(*)::bigint as n FROM "LlmCallLog" GROUP BY model ORDER BY n DESC
  `;
  console.log('\n=== calls by model ===');
  for (const r of byModel) console.log(`  ${r.model}: ${r.n}`);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
