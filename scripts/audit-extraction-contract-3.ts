/** Read-only recon, part 3. railway run npx tsx scripts/audit-extraction-contract-3.ts */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const out: Record<string, unknown> = {};

  out.confidenceHistogram = await prisma.$queryRawUnsafe(
    `SELECT confidence, COUNT(*)::bigint AS n FROM "Rule" WHERE status='ACTIVE'
     GROUP BY confidence ORDER BY 2 DESC LIMIT 12`
  );
  out.confidenceUsedForOrdering = await prisma.$queryRawUnsafe(
    `SELECT 'confidence >= 0.95' AS k, COUNT(*)::bigint AS n FROM "Rule" WHERE status='ACTIVE' AND confidence >= 0.95
     UNION ALL SELECT 'confidence = 1.0', COUNT(*)::bigint FROM "Rule" WHERE status='ACTIVE' AND confidence = 1.0
     UNION ALL SELECT 'confidence < 0.8', COUNT(*)::bigint FROM "Rule" WHERE status='ACTIVE' AND confidence < 0.8`
  );

  // rules without documentId — who made them
  out.orphanRuleSample = await prisma.rule.findMany({
    where: { documentId: null, status: 'ACTIVE' },
    select: { ruleCode: true, title: true, sourceSpan: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 8,
  });

  // body length distribution — is one rule really one fact?
  out.bodyLength = await prisma.$queryRawUnsafe(
    `SELECT width_bucket(LENGTH(body), 0, 2000, 10) AS bucket,
            MIN(LENGTH(body)) AS min, MAX(LENGTH(body)) AS max, COUNT(*)::bigint AS n
     FROM "Rule" WHERE status='ACTIVE' GROUP BY 1 ORDER BY 1`
  );

  // how many active rules mention 2+ prices (multi-fact rules)
  out.multiFact = await prisma.$queryRawUnsafe(
    `SELECT 'body with >=3 numbers of 3+ digits' AS k, COUNT(*)::bigint AS n FROM "Rule"
       WHERE status='ACTIVE' AND (SELECT COUNT(*) FROM regexp_matches(body, '[0-9]{3,}', 'g')) >= 3
     UNION ALL SELECT 'body with >=10 such numbers', COUNT(*)::bigint FROM "Rule"
       WHERE status='ACTIVE' AND (SELECT COUNT(*) FROM regexp_matches(body, '[0-9]{3,}', 'g')) >= 10`
  );

  // quote length: is the quote long enough to locate?
  out.quoteLength = await prisma.$queryRawUnsafe(
    `SELECT 'quote < 20 chars' AS k, COUNT(*)::bigint AS n FROM "Rule"
       WHERE status='ACTIVE' AND LENGTH("sourceSpan"->>'quote') < 20
     UNION ALL SELECT 'quote 20-60', COUNT(*)::bigint FROM "Rule"
       WHERE status='ACTIVE' AND LENGTH("sourceSpan"->>'quote') BETWEEN 20 AND 60
     UNION ALL SELECT 'quote > 150 (prompt cap)', COUNT(*)::bigint FROM "Rule"
       WHERE status='ACTIVE' AND LENGTH("sourceSpan"->>'quote') > 150`
  );

  // distinct locationHint values — is it a usable locator?
  out.locationHint = await prisma.$queryRawUnsafe(
    `SELECT COUNT(DISTINCT "sourceSpan"->>'locationHint')::bigint AS distinct_hints,
            COUNT(*)::bigint AS active_rules FROM "Rule" WHERE status='ACTIVE'`
  );

  console.log(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
}
main().catch((e) => { console.error('FAILED', e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
