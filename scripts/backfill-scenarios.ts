// Backfill scenarioKey on existing Documents, Rules, QAPairs, and DocChunks.
//
// Strategy (runs in 3 phases):
//
//   1) Documents — match by filename regex declared in scenarios.ts. Each
//      Document gets exactly one scenarioKey (leaf).
//
//   2) Chunks — inherit directly from their Document (1:1 via documentId).
//
//   3) Rules + QAPairs — by default inherit from Document. Then SECOND PASS
//      identifies "cross-cutting" rules (facts that are identical across 2+
//      scenarios — "апостиль всегда на русском", "2500₽", policy rules) and
//      reassigns them to the broader ancestor "apostille" so they apply to
//      every sub-procedure without triplication.
//
// Run: node scripts/backfill-scenarios.mjs [--dry-run]
//
// Safe to re-run: idempotent. Rules already placed at a broader ancestor are
// not moved back to a leaf.

import { PrismaClient } from '@prisma/client';
import {
  SCENARIOS,
  ancestorsOf,
  assertTaxonomyConsistency,
} from '../src/lib/knowledge/scenarios';
import {
  classifyDocumentScenario,
  classifyRuleScenario,
  looksCrossCuttingApostille,
} from '../src/lib/knowledge/scenario-assignment';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  assertTaxonomyConsistency();
  console.log(`[backfill] DRY_RUN=${DRY_RUN}`);
  console.log(`[backfill] known scenarios: ${Object.keys(SCENARIOS).length}`);

  // ─── Phase 1: Documents ────────────────────────────────────────────────────
  const docs = await prisma.document.findMany({
    select: { id: true, title: true, filename: true, scenarioKey: true },
  });
  console.log(`\n[phase 1] ${docs.length} documents`);
  const docScenarioMap = new Map();
  let docUpdates = 0;
  let docUnmatched = 0;

  for (const d of docs) {
    const picked = classifyDocumentScenario(d.filename, d.title);
    if (!picked) {
      console.warn(`  ⚠ UNMATCHED: "${d.title}" (${d.filename})`);
      docUnmatched++;
      continue;
    }
    docScenarioMap.set(d.id, picked);
    const ancestors = ancestorsOf(picked);
    console.log(`  [${d.id.slice(0, 10)}] "${d.title}" → ${picked}  (ancestors: ${ancestors.join(' > ')})`);
    if (!DRY_RUN && d.scenarioKey !== picked) {
      await prisma.document.update({ where: { id: d.id }, data: { scenarioKey: picked } });
      docUpdates++;
    }
  }
  console.log(`[phase 1] updated ${docUpdates}, unmatched ${docUnmatched}`);

  // ─── Phase 2: Chunks (inherit from Document) ───────────────────────────────
  console.log(`\n[phase 2] tagging chunks by document scenario`);
  let chunkUpdates = 0;
  for (const [docId, scenarioKey] of docScenarioMap) {
    if (DRY_RUN) {
      const count = await prisma.docChunk.count({ where: { documentId: docId } });
      console.log(`  would tag ${count} chunks of ${docId.slice(0, 10)} → ${scenarioKey}`);
      chunkUpdates += count;
    } else {
      const r = await prisma.docChunk.updateMany({
        where: { documentId: docId },
        data: { scenarioKey },
      });
      chunkUpdates += r.count;
    }
  }
  console.log(`[phase 2] tagged ${chunkUpdates} chunks`);

  // ─── Phase 3a: Rules inherit from Document ─────────────────────────────────
  console.log(`\n[phase 3a] initial rule tagging by document`);
  const rules = await prisma.rule.findMany({
    select: { id: true, ruleCode: true, documentId: true, title: true, body: true, sourceSpan: true, scenarioKey: true },
  });
  console.log(`[phase 3a] ${rules.length} rules (${rules.filter(r => !r.documentId).length} unlinked)`);

  const ruleAssignments = new Map(); // ruleId -> scenarioKey | null
  for (const r of rules) {
    if (r.documentId && docScenarioMap.has(r.documentId)) {
      ruleAssignments.set(r.id, docScenarioMap.get(r.documentId));
    } else {
      // Unlinked/manual rules must not default to "global". Either classify
      // by concrete text signals, promote explicitly cross-cutting apostille
      // facts, or leave null so strict retrieval excludes them.
      const locationHint = typeof r.sourceSpan === 'object' && r.sourceSpan && 'locationHint' in r.sourceSpan
        ? String((r.sourceSpan as { locationHint?: unknown }).locationHint ?? '')
        : '';
      ruleAssignments.set(r.id, classifyRuleScenario(r.title, r.body, locationHint));
    }
  }

  // ─── Phase 3b: Promote cross-cutting rules to broader ancestor ─────────────
  console.log(`\n[phase 3b] detecting cross-cutting rules`);
  let promoted = 0;
  for (const r of rules) {
    const currentAssignment = ruleAssignments.get(r.id);
    if (!currentAssignment) continue;
    const text = `${r.title}\n${r.body}`;
    if (looksCrossCuttingApostille(text)) {
      // Promote to parent taxonomy root (e.g., "apostille.zags.spb" → "apostille")
      const rootKey = currentAssignment.split('.')[0];
      ruleAssignments.set(r.id, rootKey);
      promoted++;
      console.log(`  ↑ [${r.ruleCode}] "${r.title.slice(0, 60)}"  ${currentAssignment} → ${rootKey}`);
    }
  }
  console.log(`[phase 3b] promoted ${promoted} cross-cutting rules`);

  // ─── Phase 3c: Apply rule updates ──────────────────────────────────────────
  let ruleUpdates = 0;
  for (const [ruleId, scenarioKey] of ruleAssignments) {
    if (!scenarioKey) continue;
    const current = rules.find((x) => x.id === ruleId);
    if (current?.scenarioKey === scenarioKey) continue;
    if (DRY_RUN) { ruleUpdates++; continue; }
    await prisma.rule.update({ where: { id: ruleId }, data: { scenarioKey } });
    ruleUpdates++;
  }
  console.log(`[phase 3c] updated ${ruleUpdates} rules`);

  // ─── Phase 4: QAPairs inherit from their rule or document ──────────────────
  console.log(`\n[phase 4] QAPairs`);
  const qas = await prisma.qAPair.findMany({
    select: { id: true, documentId: true, ruleId: true, scenarioKey: true },
  });
  let qaUpdates = 0;
  for (const qa of qas) {
    let picked = null;
    if (qa.ruleId && ruleAssignments.has(qa.ruleId)) picked = ruleAssignments.get(qa.ruleId);
    else if (qa.documentId && docScenarioMap.has(qa.documentId)) picked = docScenarioMap.get(qa.documentId);
    if (!picked) continue;
    if (qa.scenarioKey === picked) continue;
    if (DRY_RUN) { qaUpdates++; continue; }
    await prisma.qAPair.update({ where: { id: qa.id }, data: { scenarioKey: picked } });
    qaUpdates++;
  }
  console.log(`[phase 4] updated ${qaUpdates} QA pairs`);

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n[summary]`);
  console.log(`  documents: ${docUpdates} updated, ${docUnmatched} unmatched`);
  console.log(`  chunks:    ${chunkUpdates}`);
  console.log(`  rules:     ${ruleUpdates} (${promoted} promoted to cross-cutting)`);
  console.log(`  qa pairs:  ${qaUpdates}`);

  if (!DRY_RUN) {
    // Distribution check
    const dist = await prisma.rule.groupBy({
      by: ['scenarioKey'],
      _count: true,
    });
    console.log(`\n[final distribution] rules by scenarioKey:`);
    for (const row of dist) {
      console.log(`  ${row.scenarioKey ?? '(null)'}: ${row._count}`);
    }
  }
}

main()
  .catch((e) => { console.error('FATAL:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
