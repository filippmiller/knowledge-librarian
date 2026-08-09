/**
 * Simple hybrid RAG baseline (Task 16, bonus) — same canonical DOCX, same
 * questions, but NO applicability/resolution engine: canonical blocks are
 * chunks, hybrid (lexical+vector+RRF) retrieval picks top-K, an LLM answers
 * directly from those chunks. No structured knowledge units, no eligibility/
 * scope/trigger/resolution, no evidence-pack grounding — the point of
 * comparison for scripts/run-aurora-fixture.ts (does the extra structured-
 * engine complexity actually buy anything over plain RAG on this fixture?).
 *
 * Same oracle-isolation discipline as run-aurora-fixture.ts: engine
 * execution takes only {caseId, question}, taint-checked before use.
 *
 * Usage:
 *   npx tsx scripts/run-rag-baseline-fixture.ts --out=path/to/dir [--doc=path/to/source.docx] [--top-k=5]
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { extractCanonicalDocument } from '../src/lib/knowledge/docx-canonical-blocks';
import { OpenAIEmbeddingProvider } from '../src/lib/ai/embedding-provider';
import { cosineSimilarity } from '../src/lib/ai/vector-search';
import { searchLexical } from '../src/lib/ai/lexical-search';
import { reciprocalRankFusion } from '../src/lib/ai/reciprocal-rank-fusion';
import { resolveExtractionRunConfig } from '../src/lib/ai/extraction-run';
import { structured } from '../src/lib/ai/structured-output';

import { loadSemanticRuleOracle, ORACLE_PACK_DIR, SOURCE_DOCX_FILENAME } from '../src/lib/eval/semantic-rule-oracle';
import { loadNegativeCaseOracle } from '../src/lib/eval/negative-case-oracle';
import { loadSourceRulesFromDocx, type SourceRule } from '../src/lib/eval/source-rule-segmentation';
import { buildOracleTaintDetector, type OracleTaintDetector } from '../src/lib/eval/oracle-taint';

function parseArgs(argv: readonly string[]): { outDir: string; docPath: string; topK: number } {
  const outArg = argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
  const docArg = argv.find((a) => a.startsWith('--doc='))?.slice('--doc='.length);
  const topKArg = argv.find((a) => a.startsWith('--top-k='))?.slice('--top-k='.length);
  if (!outArg) throw new Error('Usage: npx tsx scripts/run-rag-baseline-fixture.ts --out=<dir> [--doc=<path>] [--top-k=5]');
  return {
    outDir: outArg,
    docPath: docArg ?? path.join(ORACLE_PACK_DIR, SOURCE_DOCX_FILENAME),
    topK: topKArg ? Number(topKArg) : 5,
  };
}

interface Chunk {
  readonly anchor: string;
  readonly text: string;
  readonly embedding: number[];
}

interface RagQuestionInput {
  readonly caseId: string;
  readonly question: string;
}

interface RagQuestionResult {
  readonly caseId: string;
  readonly question: string;
  readonly topChunkAnchors: readonly string[];
  readonly answerText: string | null;
  readonly errorMessage: string | null;
}

const answerSchema = z.strictObject({ text: z.string() });

async function answerFromChunks(
  question: string,
  chunks: readonly { anchor: string; text: string }[],
  runConfig: ReturnType<typeof resolveExtractionRunConfig>
): Promise<string> {
  const context = chunks.map((c) => `[${c.anchor}] ${c.text}`).join('\n\n');
  const result = await structured({
    schema: answerSchema,
    messages: [
      {
        role: 'system',
        content:
          'Ответь на вопрос на основе приведённых фрагментов документа. Если фрагменты не содержат ответа, честно скажи, что не знаешь. ' +
          'Ответ СТРОГО JSON: {"text": "..."}',
      },
      { role: 'user', content: `Вопрос: "${question}"\n\nФрагменты документа:\n${context}` },
    ],
    runConfig,
  });
  return result.data.text;
}

async function runRagOnQuestion(
  input: RagQuestionInput,
  chunks: readonly Chunk[],
  embeddingProvider: OpenAIEmbeddingProvider,
  runConfig: ReturnType<typeof resolveExtractionRunConfig>,
  topK: number,
  taintDetector: OracleTaintDetector
): Promise<RagQuestionResult> {
  try {
    taintDetector.assertClean({ question: input.question }, `RAG baseline engine input (${input.caseId})`);

    const [queryEmbedding] = await embeddingProvider.embed([input.question]);
    const vectorRanked = chunks
      .map((c) => ({ id: c.anchor, similarity: cosineSimilarity(queryEmbedding, c.embedding) }))
      .sort((a, b) => b.similarity - a.similarity);
    const lexicalRanked = searchLexical(input.question, chunks.map((c) => ({ id: c.anchor, text: c.text })));
    const fused = reciprocalRankFusion(
      [vectorRanked.map((r) => ({ id: r.id })), lexicalRanked.map((r) => ({ id: r.id }))],
      { k: 60 }
    );
    const topChunkAnchors = fused.slice(0, topK).map((f) => f.id);
    const topChunks = topChunkAnchors
      .map((anchor) => chunks.find((c) => c.anchor === anchor))
      .filter((c): c is Chunk => c !== undefined);

    taintDetector.assertClean(topChunks.map((c) => ({ anchor: c.anchor, text: c.text })), `RAG baseline engine input (chunks, ${input.caseId})`);

    const answerText = await answerFromChunks(input.question, topChunks, runConfig);
    taintDetector.assertClean({ text: answerText }, `RAG baseline engine output (${input.caseId})`);

    return { caseId: input.caseId, question: input.question, topChunkAnchors, answerText, errorMessage: null };
  } catch (err) {
    return {
      caseId: input.caseId,
      question: input.question,
      topChunkAnchors: [],
      answerText: null,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log('=== RAG BASELINE (Task 16, bonus comparison) ===');

  const positiveOracle = loadSemanticRuleOracle();
  const negativeOracle = loadNegativeCaseOracle();
  const sourceRules: SourceRule[] = await loadSourceRulesFromDocx(args.docPath);

  const negativeQuestionById = new Map<string, string>();
  for (const c of positiveOracle) for (const n of c.negativeCases) negativeQuestionById.set(n.id, n.question);

  const questions: RagQuestionInput[] = [
    ...positiveOracle.map((c) => ({ caseId: c.id, question: c.question })),
    ...negativeOracle
      .map((n) => {
        const q = negativeQuestionById.get(n.id);
        return q ? { caseId: n.id, question: q } : null;
      })
      .filter((q): q is RagQuestionInput => q !== null),
  ];

  const taintDetector = buildOracleTaintDetector({
    oracle: positiveOracle,
    sourceText: sourceRules.map((r) => r.text).join('\n'),
  });

  const buffer = readFileSync(args.docPath);
  const canonical = await extractCanonicalDocument(buffer);
  console.log(`canonical document: ${canonical.blocks.length} blocks (== chunks, no structured extraction)`);

  const embeddingProvider = new OpenAIEmbeddingProvider();
  const rawChunks = canonical.blocks.map((b) => ({ anchor: b.anchor, text: b.text }));
  const vectors = await embeddingProvider.embed(rawChunks.map((c) => c.text));
  const chunks: Chunk[] = rawChunks.map((c, i) => ({ ...c, embedding: vectors[i] }));

  const answerRunConfig = resolveExtractionRunConfig({ promptVersion: 'rag-baseline-answer-v1' });

  const results: RagQuestionResult[] = [];
  for (const q of questions) {
    console.log(`  ${q.caseId}: "${q.question.slice(0, 60)}..."`);
    const result = await runRagOnQuestion(q, chunks, embeddingProvider, answerRunConfig, args.topK, taintDetector);
    console.log(`    -> ${result.errorMessage ? `ERROR: ${result.errorMessage}` : 'answered'}`);
    results.push(result);
  }

  mkdirSync(args.outDir, { recursive: true });
  writeFileSync(path.join(args.outDir, 'rag-baseline-results.json'), JSON.stringify(results, null, 2), 'utf8');
  writeFileSync(
    path.join(args.outDir, 'run-summary.json'),
    JSON.stringify({ ranAt: new Date().toISOString(), docPath: args.docPath, topK: args.topK, questionCount: questions.length }, null, 2),
    'utf8'
  );
  console.log(`\nАртефакты записаны в: ${args.outDir}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('FATAL ERROR:', err);
    process.exit(1);
  });
}
