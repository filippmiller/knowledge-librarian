/**
 * Read-only recon for the extraction-contract audit (docs/bot-audit/11).
 * Run: railway run npx tsx scripts/audit-extraction-contract.ts
 * Writes nothing. Only SELECTs.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function main() {
  const out: Record<string, unknown> = {};

  // ---------- Documents ----------
  const docTotal = await prisma.document.count();
  const docByStatus = await prisma.document.groupBy({ by: ['parseStatus'], _count: true });
  const docByAudience = await prisma.document.groupBy({ by: ['audience'], _count: true });
  const docScenarioNull = await prisma.document.count({ where: { scenarioKey: null } });
  const docByScenario = await prisma.document.groupBy({ by: ['scenarioKey'], _count: true });
  out.documents = { total: docTotal, byStatus: docByStatus, byAudience: docByAudience, scenarioNull: docScenarioNull, byScenario: docByScenario };

  // ---------- Rules ----------
  const ruleTotal = await prisma.rule.count();
  const ruleByStatus = await prisma.rule.groupBy({ by: ['status'], _count: true });
  const ruleByAudience = await prisma.rule.groupBy({ by: ['audience'], _count: true });
  const ruleNoDoc = await prisma.rule.count({ where: { documentId: null } });
  const ruleNoDocActive = await prisma.rule.count({ where: { documentId: null, status: 'ACTIVE' } });
  const ruleScenarioNull = await prisma.rule.count({ where: { scenarioKey: null } });
  const ruleByScenario = await prisma.rule.groupBy({ by: ['scenarioKey'], _count: true });
  const ruleSupersedes = await prisma.rule.count({ where: { NOT: { supersedesRuleId: null } } });
  const ruleVersionGt1 = await prisma.rule.count({ where: { version: { gt: 1 } } });
  out.rules = {
    total: ruleTotal, byStatus: ruleByStatus, byAudience: ruleByAudience,
    noDocument: ruleNoDoc, noDocumentActive: ruleNoDocActive,
    scenarioNull: ruleScenarioNull, byScenario: ruleByScenario,
    withSupersedesRuleId: ruleSupersedes, versionGreaterThan1: ruleVersionGt1,
  };

  // ---------- ruleCode collisions ----------
  const dupAll = await prisma.$queryRawUnsafe<{ n: bigint; codes: bigint }[]>(
    `SELECT n, COUNT(*)::bigint AS codes FROM (
       SELECT "ruleCode", COUNT(*)::int AS n FROM "Rule" GROUP BY "ruleCode"
     ) t GROUP BY n ORDER BY n DESC`
  );
  const dupActive = await prisma.$queryRawUnsafe<{ n: bigint; codes: bigint }[]>(
    `SELECT n, COUNT(*)::bigint AS codes FROM (
       SELECT "ruleCode", COUNT(*)::int AS n FROM "Rule" WHERE status='ACTIVE' GROUP BY "ruleCode"
     ) t GROUP BY n ORDER BY n DESC`
  );
  const topDup = await prisma.$queryRawUnsafe<{ ruleCode: string; n: bigint; docs: bigint }[]>(
    `SELECT "ruleCode", COUNT(*)::bigint AS n, COUNT(DISTINCT "documentId")::bigint AS docs
     FROM "Rule" WHERE status='ACTIVE' GROUP BY "ruleCode" HAVING COUNT(*)>1
     ORDER BY COUNT(*) DESC, "ruleCode" LIMIT 15`
  );
  out.ruleCodeCollisions = { histogramAll: dupAll, histogramActive: dupActive, top: topDup };

  // ---------- Domains per rule ----------
  const domPerRule = await prisma.$queryRawUnsafe<{ n: bigint; rules: bigint }[]>(
    `SELECT n, COUNT(*)::bigint AS rules FROM (
       SELECT r.id, COUNT(rd."domainId")::int AS n
       FROM "Rule" r LEFT JOIN "RuleDomain" rd ON rd."ruleId"=r.id
       WHERE r.status='ACTIVE' GROUP BY r.id
     ) t GROUP BY n ORDER BY n`
  );
  const domCoverage = await prisma.$queryRawUnsafe<{ slug: string; rules: bigint }[]>(
    `SELECT d.slug, COUNT(DISTINCT rd."ruleId")::bigint AS rules
     FROM "Domain" d JOIN "RuleDomain" rd ON rd."domainId"=d.id
     JOIN "Rule" r ON r.id=rd."ruleId" AND r.status='ACTIVE'
     GROUP BY d.slug ORDER BY 2 DESC`
  );
  const domainCount = await prisma.domain.count();
  out.domains = { totalDomains: domainCount, domainsPerActiveRule: domPerRule, activeRuleCoverageByDomain: domCoverage };

  // ---------- sourceSpan quality ----------
  const spanStats = await prisma.$queryRawUnsafe<{ k: string; n: bigint }[]>(
    `SELECT 'sourceSpan IS NULL' AS k, COUNT(*)::bigint AS n FROM "Rule" WHERE status='ACTIVE' AND "sourceSpan" IS NULL
     UNION ALL SELECT 'quote missing/empty', COUNT(*)::bigint FROM "Rule"
       WHERE status='ACTIVE' AND ("sourceSpan"->>'quote' IS NULL OR "sourceSpan"->>'quote' = '')
     UNION ALL SELECT 'locationHint missing/empty', COUNT(*)::bigint FROM "Rule"
       WHERE status='ACTIVE' AND ("sourceSpan"->>'locationHint' IS NULL OR "sourceSpan"->>'locationHint' = '')
     UNION ALL SELECT 'has charOffset key', COUNT(*)::bigint FROM "Rule"
       WHERE status='ACTIVE' AND "sourceSpan" ? 'charOffset'
     UNION ALL SELECT 'has chunkId key', COUNT(*)::bigint FROM "Rule"
       WHERE status='ACTIVE' AND "sourceSpan" ? 'chunkId'`
  );
  const spanKeys = await prisma.$queryRawUnsafe<{ key: string; n: bigint }[]>(
    `SELECT k AS key, COUNT(*)::bigint AS n FROM "Rule" r, LATERAL jsonb_object_keys(r."sourceSpan") k
     WHERE r.status='ACTIVE' GROUP BY k ORDER BY 2 DESC`
  );
  out.sourceSpan = { stats: spanStats, keysPresent: spanKeys };

  // ---------- quote verifiability against document rawText ----------
  const sample = await prisma.rule.findMany({
    where: { status: 'ACTIVE', NOT: { documentId: null } },
    select: { id: true, ruleCode: true, documentId: true, sourceSpan: true },
  });
  const docsRaw = await prisma.document.findMany({ select: { id: true, rawText: true } });
  const rawMap = new Map(docsRaw.map((d) => [d.id, norm(d.rawText ?? '')]));
  let checked = 0, verbatim = 0, noQuote = 0, noRaw = 0, notFound = 0;
  const notFoundExamples: { ruleCode: string; quote: string }[] = [];
  for (const r of sample) {
    const span = r.sourceSpan as { quote?: string } | null;
    const q = span?.quote?.trim() ?? '';
    if (!q) { noQuote++; continue; }
    const raw = rawMap.get(r.documentId!);
    if (!raw) { noRaw++; continue; }
    checked++;
    if (raw.includes(norm(q))) verbatim++;
    else { notFound++; if (notFoundExamples.length < 8) notFoundExamples.push({ ruleCode: r.ruleCode, quote: q.slice(0, 90) }); }
  }
  out.quoteVerifiability = { activeRulesWithDoc: sample.length, noQuote, docHadNoRawText: noRaw, checked, verbatimFound: verbatim, notFound, notFoundExamples };

  // ---------- QAPair ----------
  const qaTotal = await prisma.qAPair.count();
  const qaByStatus = await prisma.qAPair.groupBy({ by: ['status'], _count: true });
  const qaNoRule = await prisma.qAPair.count({ where: { ruleId: null } });
  const qaNoRuleActive = await prisma.qAPair.count({ where: { ruleId: null, status: 'ACTIVE' } });
  const qaNoDoc = await prisma.qAPair.count({ where: { documentId: null } });
  const qaByAudience = await prisma.qAPair.groupBy({ by: ['audience'], _count: true });
  const qaScenarioNull = await prisma.qAPair.count({ where: { scenarioKey: null } });
  out.qaPairs = { total: qaTotal, byStatus: qaByStatus, noRuleId: qaNoRule, noRuleIdActive: qaNoRuleActive, noDocumentId: qaNoDoc, byAudience: qaByAudience, scenarioNull: qaScenarioNull };

  // ---------- DocChunk ----------
  const chunkTotal = await prisma.docChunk.count();
  const chunkNoEmbedding = await prisma.docChunk.count({ where: { embedding: { equals: null } } });
  const chunkScenarioNull = await prisma.docChunk.count({ where: { scenarioKey: null } });
  const chunkByAudience = await prisma.docChunk.groupBy({ by: ['audience'], _count: true });
  const chunkPerDoc = await prisma.$queryRawUnsafe<{ documentId: string; n: bigint }[]>(
    `SELECT "documentId", COUNT(*)::bigint AS n FROM "DocChunk" GROUP BY 1 ORDER BY 2 DESC LIMIT 5`
  );
  out.chunks = { total: chunkTotal, noEmbedding: chunkNoEmbedding, scenarioNull: chunkScenarioNull, byAudience: chunkByAudience, topDocs: chunkPerDoc };

  // ---------- rawText availability ----------
  const rawStats = await prisma.$queryRawUnsafe<{ k: string; n: bigint }[]>(
    `SELECT 'rawText NULL' AS k, COUNT(*)::bigint AS n FROM "Document" WHERE "rawText" IS NULL
     UNION ALL SELECT 'rawText empty', COUNT(*)::bigint FROM "Document" WHERE "rawText" = ''
     UNION ALL SELECT 'rawBytes NULL', COUNT(*)::bigint FROM "Document" WHERE "rawBytes" IS NULL`
  );
  out.rawText = rawStats;

  // ---------- rule body typing signals ----------
  const typing = await prisma.$queryRawUnsafe<{ k: string; n: bigint }[]>(
    `SELECT 'body has digit+rub' AS k, COUNT(*)::bigint AS n FROM "Rule"
       WHERE status='ACTIVE' AND body ~ '[0-9]\\s*(руб|р\\.|₽)'
     UNION ALL SELECT 'body has conditional (esli)', COUNT(*)::bigint FROM "Rule"
       WHERE status='ACTIVE' AND body ILIKE '%если%'
     UNION ALL SELECT 'body has prohibition', COUNT(*)::bigint FROM "Rule"
       WHERE status='ACTIVE' AND (body ILIKE '%нельзя%' OR body ILIKE '%запрещ%' OR body ILIKE '%не приним%')
     UNION ALL SELECT 'body has exception', COUNT(*)::bigint FROM "Rule"
       WHERE status='ACTIVE' AND (body ILIKE '%исключен%' OR body ILIKE '%кроме%')
     UNION ALL SELECT 'body has date/year', COUNT(*)::bigint FROM "Rule"
       WHERE status='ACTIVE' AND body ~ '20[0-2][0-9]'`
  );
  out.bodyTypingSignals = typing;

  console.log(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
}

main()
  .catch((e) => { console.error('AUDIT FAILED:', e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
