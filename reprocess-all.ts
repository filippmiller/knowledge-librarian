/**
 * Headless full reprocessing of all real documents.
 * Run with: npx tsx reprocess-all.ts
 *
 * What it does per document:
 *  1. Delete old rules, QA pairs, chunks, staged extractions, domain links
 *  2. Re-run domain classification
 *  3. Re-run knowledge extraction (with new improved prompts & 8k batch size)
 *  4. Re-create chunks + embeddings
 *  5. Mark COMPLETED
 */

import 'dotenv/config';
import prisma from './src/lib/db';
import { classifyDocumentDomains, getExistingDomains, saveDomainSuggestions, linkDocumentToDomains } from './src/lib/ai/domain-steward';
import { extractKnowledge, saveExtractedRules, saveExtractedQAs, createAIQuestions, getExistingRuleCodes } from './src/lib/ai/knowledge-extractor';
import { createDocumentChunks } from './src/lib/ai/chunker';

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

async function clearDocument(docId: string) {
  // Delete in dependency order: leaf tables first

  // QA domain links → QA pairs
  const qas = await prisma.qAPair.findMany({ where: { documentId: docId }, select: { id: true } });
  if (qas.length) {
    await prisma.qADomain.deleteMany({ where: { qaId: { in: qas.map(q => q.id) } } });
    await prisma.qAPair.deleteMany({ where: { documentId: docId } });
  }

  // Rule domain links → Rules (superseded chain)
  const rules = await prisma.rule.findMany({ where: { documentId: docId }, select: { id: true } });
  if (rules.length) {
    const ruleIds = rules.map(r => r.id);
    await prisma.ruleDomain.deleteMany({ where: { ruleId: { in: ruleIds } } });
    await prisma.ruleComment.deleteMany({ where: { ruleId: { in: ruleIds } } });
    await prisma.userFavorite.deleteMany({ where: { ruleId: { in: ruleIds } } });
    await prisma.userNotification.deleteMany({ where: { ruleId: { in: ruleIds } } });
    await prisma.notificationLog.deleteMany({ where: { ruleId: { in: ruleIds } } });
    await prisma.rule.deleteMany({ where: { documentId: docId } });
  }

  // Chunk domain links → Chunks
  const chunks = await prisma.docChunk.findMany({ where: { documentId: docId }, select: { id: true } });
  if (chunks.length) {
    await prisma.chunkDomain.deleteMany({ where: { chunkId: { in: chunks.map(c => c.id) } } });
    await prisma.docChunk.deleteMany({ where: { documentId: docId } });
  }

  // Staged extractions
  await prisma.stagedExtraction.deleteMany({ where: { documentId: docId } });

  // Document domain links + suggestions
  await prisma.documentDomain.deleteMany({ where: { documentId: docId } });
  await prisma.domainSuggestion.deleteMany({ where: { createdFromDocumentId: docId } });
}

async function processDocument(doc: { id: string; title: string; rawText: string }) {
  log(`  → Clearing old data`);
  await clearDocument(doc.id);

  await prisma.document.update({
    where: { id: doc.id },
    data: { parseStatus: 'PROCESSING', parseError: null },
  });

  // ── Phase 1: Domain classification ──
  log(`  → Classifying domains`);
  const existingDomains = await getExistingDomains();
  const domainResult = await classifyDocumentDomains(doc.rawText, existingDomains);

  if (domainResult.newDomainSuggestions.length > 0) {
    await saveDomainSuggestions(doc.id, domainResult.newDomainSuggestions);
  }
  await linkDocumentToDomains(doc.id, domainResult.documentDomains);

  const documentDomains = await prisma.documentDomain.findMany({
    where: { documentId: doc.id },
    select: { domainId: true },
  });
  const domainIds = documentDomains.map(d => d.domainId);
  log(`  → Domains assigned: ${domainIds.length}`);

  // ── Phase 2: Knowledge extraction ──
  log(`  → Extracting knowledge (${doc.rawText.length} chars, ${Math.ceil(doc.rawText.length / 8000)} batches)`);
  const existingRuleCodes = await getExistingRuleCodes();
  const knowledge = await extractKnowledge(doc.rawText, existingRuleCodes);
  log(`  → Extracted: ${knowledge.rules.length} rules, ${knowledge.qaPairs.length} QA pairs`);

  const createdRules = await saveExtractedRules(doc.id, knowledge.rules, domainIds);
  const ruleCodeToId = new Map(createdRules.map(r => [r.ruleCode, r.id]));
  await saveExtractedQAs(doc.id, knowledge.qaPairs, ruleCodeToId, domainIds);

  if (knowledge.uncertainties.length > 0) {
    await createAIQuestions(knowledge.uncertainties);
  }

  // ── Phase 3: Chunking + embeddings ──
  log(`  → Creating chunks + embeddings`);
  await createDocumentChunks(doc.id, doc.rawText, domainIds);

  // ── Done ──
  await prisma.document.update({
    where: { id: doc.id },
    data: { parseStatus: 'COMPLETED' },
  });
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main() {
  const SKIP_PREFIX = 'Telegram:';

  const documents = await prisma.document.findMany({
    select: { id: true, title: true, rawText: true, parseStatus: true },
    orderBy: { uploadedAt: 'asc' },
  });

  const realDocs = documents.filter(
    d => !d.title.startsWith(SKIP_PREFIX) && d.rawText && d.rawText.length > 100
  );

  log(`Found ${realDocs.length} real documents to reprocess (skipping ${documents.length - realDocs.length} Telegram snippets)`);

  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < realDocs.length; i++) {
    const doc = realDocs[i];
    log(`\n[${i + 1}/${realDocs.length}] ${doc.title.slice(0, 60)}`);

    try {
      await processDocument(doc as { id: string; title: string; rawText: string });
      succeeded++;
      log(`  ✓ Done`);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      log(`  ✗ FAILED: ${msg.slice(0, 200)}`);
      await prisma.document.update({
        where: { id: doc.id },
        data: { parseStatus: 'FAILED', parseError: msg.slice(0, 500) },
      }).catch(() => {});
    }
  }

  log(`\n═══ DONE: ${succeeded} succeeded, ${failed} failed ═══`);
  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
