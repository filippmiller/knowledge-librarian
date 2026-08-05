/**
 * Read-only audit helper (temp, for .claude/audits/2026-08-05-full-retrieval-audit-claude.md).
 * Reports live table inventory + row counts + scenarioKey null breakdown.
 * Safe: SELECT only.
 */
import prisma from '../src/lib/db';

async function main() {
  const tables = await prisma.$queryRaw<Array<{ table_name: string }>>`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' ORDER BY table_name
  `;
  console.log('=== TABLES IN PRODUCTION DB ===');
  console.log(tables.map((t) => t.table_name).join(', '));

  const hasLlmCallLog = tables.some((t) => t.table_name === 'LlmCallLog');
  console.log('\nLlmCallLog table present:', hasLlmCallLog);

  const counts: Record<string, number> = {};
  for (const model of ['Rule', 'QAPair', 'DocChunk', 'Document', 'HeldAnswer', 'HallucinationLog', 'Tariff']) {
    try {
      const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT COUNT(*)::bigint as count FROM "${model}"`
      );
      counts[model] = Number(rows[0].count);
    } catch (e) {
      counts[model] = -1;
    }
  }
  console.log('\n=== ROW COUNTS ===');
  console.log(counts);

  console.log('\n=== Rule scenarioKey breakdown (ACTIVE) ===');
  const ruleScenario = await prisma.$queryRaw<Array<{ scenariokey: string | null; n: bigint }>>`
    SELECT "scenarioKey" as scenariokey, COUNT(*)::bigint as n
    FROM "Rule" WHERE status = 'ACTIVE'
    GROUP BY "scenarioKey" ORDER BY n DESC LIMIT 15
  `;
  for (const r of ruleScenario) console.log(`  ${r.scenariokey ?? 'NULL'}: ${r.n}`);

  console.log('\n=== DocChunk scenarioKey breakdown ===');
  const chunkScenario = await prisma.$queryRaw<Array<{ scenariokey: string | null; n: bigint }>>`
    SELECT "scenarioKey" as scenariokey, COUNT(*)::bigint as n
    FROM "DocChunk"
    GROUP BY "scenarioKey" ORDER BY n DESC LIMIT 15
  `;
  for (const r of chunkScenario) console.log(`  ${r.scenariokey ?? 'NULL'}: ${r.n}`);

  console.log('\n=== QAPair scenarioKey breakdown (ACTIVE) ===');
  const qaScenario = await prisma.$queryRaw<Array<{ scenariokey: string | null; n: bigint }>>`
    SELECT "scenarioKey" as scenariokey, COUNT(*)::bigint as n
    FROM "QAPair" WHERE status = 'ACTIVE'
    GROUP BY "scenarioKey" ORDER BY n DESC LIMIT 15
  `;
  for (const r of qaScenario) console.log(`  ${r.scenariokey ?? 'NULL'}: ${r.n}`);

  console.log('\n=== Rule audience breakdown ===');
  const ruleAud = await prisma.$queryRaw<Array<{ audience: string; n: bigint }>>`
    SELECT audience, COUNT(*)::bigint as n FROM "Rule" GROUP BY audience
  `;
  for (const r of ruleAud) console.log(`  ${r.audience}: ${r.n}`);

  console.log('\n=== Sample Rule rows ===');
  const rules = await prisma.rule.findMany({ take: 3, where: { status: 'ACTIVE' }, orderBy: { createdAt: 'desc' } });
  for (const r of rules) {
    console.log(`  [${r.ruleCode}] scenarioKey=${r.scenarioKey} audience=${r.audience} conf=${r.confidence}`);
    console.log(`    title: ${r.title}`);
    console.log(`    body: ${r.body.slice(0, 150)}...`);
  }

  console.log('\n=== Sample QAPair rows ===');
  const qas = await prisma.qAPair.findMany({ take: 3, where: { status: 'ACTIVE' }, orderBy: { createdAt: 'desc' } });
  for (const q of qas) {
    console.log(`  id=${q.id} scenarioKey=${q.scenarioKey} audience=${q.audience}`);
    console.log(`    Q: ${q.question.slice(0, 150)}`);
    console.log(`    A: ${q.answer.slice(0, 150)}`);
    console.log(`    metadata: ${JSON.stringify(q.metadata)}`);
  }

  console.log('\n=== Sample DocChunk rows ===');
  const chunks = await prisma.docChunk.findMany({ take: 3, orderBy: { createdAt: 'desc' } });
  for (const c of chunks) {
    console.log(`  id=${c.id} scenarioKey=${c.scenarioKey} audience=${c.audience} chunkIndex=${c.chunkIndex}`);
    console.log(`    content: ${c.content.slice(0, 150)}...`);
    console.log(`    metadata: ${JSON.stringify(c.metadata)}`);
    const emb = c.embedding as unknown;
    console.log(`    embedding dims: ${Array.isArray(emb) ? emb.length : 'n/a'}`);
  }

  console.log('\n=== HeldAnswer sample (if any) ===');
  const held = await prisma.heldAnswer.findMany({ take: 3, orderBy: { createdAt: 'desc' } });
  for (const h of held) {
    console.log(`  q="${h.question.slice(0, 80)}" blocker=${h.blocker} verdict=${h.verdict}`);
  }
  console.log('HeldAnswer total:', await prisma.heldAnswer.count());

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
