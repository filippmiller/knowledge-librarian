/** Read-only recon, part 2. railway run npx tsx scripts/audit-extraction-contract-2.ts */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const out: Record<string, unknown> = {};

  // chunk coverage per document
  const cov = await prisma.$queryRawUnsafe<{ id: string; title: string; rawlen: number; chunks: bigint; rules: bigint }[]>(
    `SELECT d.id, d.title, LENGTH(d."rawText") AS rawlen,
            (SELECT COUNT(*)::bigint FROM "DocChunk" c WHERE c."documentId"=d.id) AS chunks,
            (SELECT COUNT(*)::bigint FROM "Rule" r WHERE r."documentId"=d.id AND r.status='ACTIVE') AS rules
     FROM "Document" d ORDER BY rawlen DESC`
  );
  out.perDocument = cov;
  out.docsWithZeroChunks = cov.filter((r) => Number(r.chunks) === 0).length;
  out.docsWithZeroRules = cov.filter((r) => Number(r.rules) === 0).length;
  out.expectedChunksIfChunked = cov.reduce((s, r) => s + Math.ceil(Number(r.rawlen) / 800), 0);

  // three rules sharing one code
  const example = await prisma.rule.findMany({
    where: { ruleCode: 'R-1379' },
    select: { id: true, ruleCode: true, title: true, documentId: true, status: true, scenarioKey: true, audience: true },
  });
  out.collisionExample = example;

  // how many DISTINCT titles under duplicated codes (are they真 duplicates or different rules?)
  const dupDistinct = await prisma.$queryRawUnsafe<{ ruleCode: string; n: bigint; distinctTitles: bigint }[]>(
    `SELECT "ruleCode", COUNT(*)::bigint AS n, COUNT(DISTINCT title)::bigint AS "distinctTitles"
     FROM "Rule" WHERE status='ACTIVE' GROUP BY "ruleCode" HAVING COUNT(*)>1 ORDER BY 3 DESC, 1 LIMIT 10`
  );
  const allSameTitle = await prisma.$queryRawUnsafe<{ k: string; n: bigint }[]>(
    `SELECT 'dup codes where ALL titles identical' AS k, COUNT(*)::bigint AS n FROM (
        SELECT "ruleCode" FROM "Rule" WHERE status='ACTIVE' GROUP BY "ruleCode"
        HAVING COUNT(*)>1 AND COUNT(DISTINCT title)=1) t
     UNION ALL SELECT 'dup codes with >1 distinct title', COUNT(*)::bigint FROM (
        SELECT "ruleCode" FROM "Rule" WHERE status='ACTIVE' GROUP BY "ruleCode"
        HAVING COUNT(*)>1 AND COUNT(DISTINCT title)>1) t2`
  );
  out.duplicateNature = { sample: dupDistinct, summary: allSameTitle };

  // audience mismatch between document and its rules (drift check)
  const drift = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT COUNT(*)::bigint AS n FROM "Rule" r JOIN "Document" d ON d.id=r."documentId"
     WHERE r.audience <> d.audience`
  );
  out.audienceDrift = drift;

  // scenario drift: rule scenarioKey vs document scenarioKey
  const scenDrift = await prisma.$queryRawUnsafe<{ k: string; n: bigint }[]>(
    `SELECT 'rule scenario NULL but doc has scenario' AS k, COUNT(*)::bigint AS n
       FROM "Rule" r JOIN "Document" d ON d.id=r."documentId"
       WHERE r."scenarioKey" IS NULL AND d."scenarioKey" IS NOT NULL
     UNION ALL SELECT 'rule scenario set but doc NULL', COUNT(*)::bigint
       FROM "Rule" r JOIN "Document" d ON d.id=r."documentId"
       WHERE r."scenarioKey" IS NOT NULL AND d."scenarioKey" IS NULL`
  );
  out.scenarioDrift = scenDrift;

  // KnowledgeChange / AIQuestion volume
  out.knowledgeChange = await prisma.knowledgeChange.count();
  out.aiQuestions = await prisma.aIQuestion.count();
  out.stagedExtractionLeftovers = await prisma.stagedExtraction.count();
  out.documentRevisions = await prisma.documentRevision.count();

  console.log(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
}
main().catch((e) => { console.error('FAILED', e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
