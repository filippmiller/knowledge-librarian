import prisma from '../src/lib/db';

async function main() {
  const total = await prisma.qAPair.count({ where: { status: 'ACTIVE' } });
  const clientSafe = await prisma.qAPair.count({ where: { status: 'ACTIVE', audience: 'CLIENT_SAFE' } });
  const withMeta = await prisma.qAPair.findMany({
    where: { status: 'ACTIVE' },
    select: { metadata: true, audience: true },
  });
  const origins: Record<string, number> = {};
  const clientOrigins: Record<string, number> = {};
  for (const r of withMeta) {
    const o = (r.metadata as { origin?: string } | null)?.origin || 'none';
    origins[o] = (origins[o] || 0) + 1;
    if (r.audience === 'CLIENT_SAFE') clientOrigins[o] = (clientOrigins[o] || 0) + 1;
  }
  console.log('ACTIVE QA total:', total, 'CLIENT_SAFE:', clientSafe);
  console.log('origins (all ACTIVE):', origins);
  console.log('origins (CLIENT_SAFE only):', clientOrigins);

  const rulesTotal = await prisma.rule.count({ where: { status: 'ACTIVE' } });
  const rulesClientSafe = await prisma.rule.count({ where: { status: 'ACTIVE', audience: 'CLIENT_SAFE' } });
  console.log('ACTIVE Rules total:', rulesTotal, 'CLIENT_SAFE:', rulesClientSafe);

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
