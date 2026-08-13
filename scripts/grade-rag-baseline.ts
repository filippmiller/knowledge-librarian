/**
 * Quantitative RAG baseline grader (goal-shift continuation, Task 23).
 * Previously the RAG comparison was qualitative only (a human reading 16
 * answers side by side). This adds real, structural signal without
 * inventing anything the RAG script didn't actually do:
 *
 * 1. Retrieval correctness — did the retrieved chunks actually cover the
 *    expected source rule(s)? Chunks are canonical blocks; mapped to
 *    source-rule numbers by the same DOCX-text-containment principle as
 *    resolveSourceRuleId (source-rule-mapping.ts), just at block
 *    granularity instead of unit granularity.
 * 2. Numeric grounding — reuses checkClaimGrounding (the same policy
 *    verify-answer-claims.ts uses for the structured engine) against the
 *    actual retrieved chunk text, so RAG is held to the identical
 *    "don't hallucinate numbers" bar.
 * 3. Semantic verdict — via semantic-answer-judge.ts's judgeAnswer, IF a
 *    configured provider actually has credit. Wrapped so a provider
 *    outage degrades to "SKIPPED", not a crashed report — deterministic
 *    signal (1) and (2) above still produce real output regardless.
 *
 * Usage:
 *   npx tsx scripts/grade-rag-baseline.ts --in=path/to/rag-baseline/rag-baseline-results.json --out=path/to/report.json [--doc=path/to/source.docx]
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { extractCanonicalDocument } from '../src/lib/knowledge/docx-canonical-blocks';
import { checkClaimGrounding } from '../src/lib/ai/claim-grounding';
import { judgeAnswer, type SemanticJudgeResult } from '../src/lib/eval/semantic-answer-judge';
import { resolveGraderRunConfig } from '../src/lib/ai/extraction-run';

import { loadSemanticRuleOracle, ORACLE_PACK_DIR, SOURCE_DOCX_FILENAME } from '../src/lib/eval/semantic-rule-oracle';
import { loadNegativeCaseOracle } from '../src/lib/eval/negative-case-oracle';
import { loadSourceRulesFromDocx, type SourceRule } from '../src/lib/eval/source-rule-segmentation';

function parseArgs(argv: readonly string[]): { inPath: string; outPath: string; docPath: string } {
  const inArg = argv.find((a) => a.startsWith('--in='))?.slice('--in='.length);
  const outArg = argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);
  const docArg = argv.find((a) => a.startsWith('--doc='))?.slice('--doc='.length);
  if (!inArg || !outArg) {
    throw new Error('Usage: npx tsx scripts/grade-rag-baseline.ts --in=<rag-baseline-results.json> --out=<report.json> [--doc=<path>]');
  }
  return { inPath: inArg, outPath: outArg, docPath: docArg ?? path.join(ORACLE_PACK_DIR, SOURCE_DOCX_FILENAME) };
}

interface RagQuestionResultLike {
  readonly caseId: string;
  readonly question: string;
  readonly topChunkAnchors: readonly string[];
  readonly answerText: string | null;
  readonly errorMessage: string | null;
}

/** Block-level analogue of resolveSourceRuleId (source-rule-mapping.ts) --
 *  same containment principle, coarser granularity (a whole chunk, not a
 *  single quote). Ambiguous or absent matches return null, never guessed. */
function resolveSourceRuleIdForBlock(blockText: string, sourceRules: readonly SourceRule[]): number | null {
  const matches = sourceRules.filter(
    (rule) => rule.text.includes(blockText) || blockText.includes(rule.text)
  );
  return matches.length === 1 ? matches[0].sourceRuleId : null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const results: RagQuestionResultLike[] = JSON.parse(readFileSync(args.inPath, 'utf8'));
  const positiveOracle = loadSemanticRuleOracle();
  const negativeOracle = loadNegativeCaseOracle();
  const sourceRules = await loadSourceRulesFromDocx(args.docPath);

  const buffer = readFileSync(args.docPath);
  const canonical = await extractCanonicalDocument(buffer);
  const blockTextByAnchor = new Map(canonical.blocks.map((b) => [b.anchor, b.text]));
  const sourceRuleIdByAnchor = new Map(
    canonical.blocks.map((b) => [b.anchor, resolveSourceRuleIdForBlock(b.text, sourceRules)])
  );

  let judgeAvailable = true;
  let judgeRunConfig;
  try {
    judgeRunConfig = resolveGraderRunConfig('rag-baseline-semantic-judge-v1');
  } catch {
    judgeAvailable = false;
  }

  const graded = [];
  for (const r of results) {
    const negativeEntry = negativeOracle.find((n) => n.id === r.caseId);
    const isNegativeCase = negativeEntry !== undefined;
    // Positive cases: expected_rule_ids straight from the oracle. Negative
    // cases: requiredCandidateRuleIds/requiredSelectedRuleIds from the
    // sidecar when present -- what "the right material" means for a
    // must_not_apply/must_clarify case, not the same shape as a positive
    // case's single expected_rule_ids list.
    const expectedRuleIds =
      positiveOracle.find((c) => c.id === r.caseId)?.expectedRuleIds ??
      negativeEntry?.requiredCandidateRuleIds ??
      negativeEntry?.requiredSelectedRuleIds ??
      [];

    const retrievedRuleIds = [...new Set(r.topChunkAnchors.map((a) => sourceRuleIdByAnchor.get(a) ?? null).filter((x): x is number => x !== null))];
    const retrievalCoverage =
      expectedRuleIds.length > 0
        ? { expectedRuleIds, retrievedRuleIds, allExpectedRetrieved: expectedRuleIds.every((id) => retrievedRuleIds.includes(id)) }
        : null;

    const chunkTexts = r.topChunkAnchors.map((a) => blockTextByAnchor.get(a) ?? '').filter((t) => t.length > 0);
    const grounding = r.answerText ? checkClaimGrounding(r.answerText, chunkTexts) : null;

    let semanticJudge: SemanticJudgeResult | null = null;
    let semanticJudgeError: string | null = null;
    const oracleCase = positiveOracle.find((c) => c.id === r.caseId);
    // Negative cases don't carry expected_answer on the structural sidecar
    // (negative-case-oracle.ts) -- it lives on the NESTED NegativeCase under
    // whichever positive case declared it (semantic-rule-oracle.ts).
    const nestedNegative = positiveOracle.flatMap((c) => c.negativeCases).find((n) => n.id === r.caseId);
    const expectedAnswer = oracleCase?.expectedAnswer ?? nestedNegative?.expectedAnswer;

    if (judgeAvailable && judgeRunConfig && r.answerText && expectedAnswer) {
      try {
        semanticJudge = await judgeAnswer({
          input: {
            question: r.question,
            actualAnswer: r.answerText,
            selectedEvidenceStatements: chunkTexts,
            expectedAnswer,
          },
          runConfig: judgeRunConfig,
        });
      } catch (err) {
        semanticJudgeError = err instanceof Error ? err.message : String(err);
      }
    } else if (!judgeAvailable) {
      semanticJudgeError = 'SKIPPED: no configured judge provider available';
    } else if (!expectedAnswer) {
      semanticJudgeError = 'SKIPPED: no oracle expected_answer found for this caseId';
    }

    graded.push({
      caseId: r.caseId,
      question: r.question,
      isNegativeCase,
      hasError: r.errorMessage !== null,
      engineError: r.errorMessage,
      retrievalCoverage,
      groundingVerdict: grounding ? { grounded: grounding.grounded, ungroundedCount: grounding.ungrounded.length, total: grounding.total } : null,
      semanticJudge,
      semanticJudgeError,
    });
  }

  const report = {
    gradedAt: new Date().toISOString(),
    inPath: args.inPath,
    judgeAvailable,
    retrievalCoverageSummary: {
      total: graded.filter((g) => g.retrievalCoverage !== null).length,
      allExpectedRetrieved: graded.filter((g) => g.retrievalCoverage?.allExpectedRetrieved).length,
    },
    groundingSummary: {
      total: graded.filter((g) => g.groundingVerdict !== null).length,
      grounded: graded.filter((g) => g.groundingVerdict?.grounded).length,
    },
    semanticJudgeSummary: {
      judged: graded.filter((g) => g.semanticJudge !== null).length,
      correct: graded.filter((g) => g.semanticJudge?.verdict === 'CORRECT').length,
      skipped: graded.filter((g) => g.semanticJudge === null).length,
    },
    cases: graded,
  };

  writeFileSync(args.outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ retrievalCoverageSummary: report.retrievalCoverageSummary, groundingSummary: report.groundingSummary, semanticJudgeSummary: report.semanticJudgeSummary }, null, 2));
  console.log(`\nFull report: ${args.outPath}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('FATAL ERROR:', err);
    process.exit(1);
  });
}
