/**
 * Golden regression corpus runner (Beads translation-2n9).
 *
 * Runs every case in src/lib/ai/__tests__/fixtures/eval-corpus.json through
 * answerQuestionEnhanced() READ-ONLY and checks the result against the
 * case's `expect` block. Prints PASS/FAIL per case, then an aggregate
 * (pass rate, wrong-scope rate, hold rate).
 *
 * Needs the production DB (retrieval + canonical QA lookups), so this is
 * NOT wired into CI — run it manually after any change to the v1 hot path
 * (enhanced-answering-engine.ts / vector-search.ts / chat-provider.ts):
 *
 *   railway run npx tsx scripts/run-eval-corpus.ts
 *   railway run npx tsx scripts/run-eval-corpus.ts --id=wrongscope-minsk-claude11
 *
 * The corpus is a plain JSON fixture, not a Prisma table (EvalCase) — chosen
 * because these cases are static regression fixtures checked into git, not
 * runtime data; a DB table would need its own migration and seeding step for
 * no benefit here. See docs/plans/2026-08-05-aurora-knowledge-engine-v2.md,
 * Задача 0.1, for why the corpus must exist before any hot-path change.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { answerQuestionEnhanced, type EnhancedAnswerResult } from '../src/lib/ai/enhanced-answering-engine';
import type { Audience } from '../src/lib/knowledge/audience';

interface EvalCaseExpect {
  /** Answer must NOT contain any of these (case-insensitive) — wrong-scope/leakage guard. */
  forbiddenSubstrings?: string[];
  /** Answer must contain AT LEAST ONE of these (case-insensitive) — content-presence guard. */
  expectedSubstrings?: string[];
  /** needsClarification || requiresHumanReview || confidenceLevel==='insufficient' must equal this. */
  requiresClarificationOrHold?: boolean;
  /** result.confidence must be >= this. */
  minConfidence?: number;
  /** result.answerSource must be one of these. */
  answerSourceIn?: Array<'knowledge_base' | 'general_ai' | 'deterministic_guardrail'>;
}

interface EvalCase {
  id: string;
  category: string;
  question: string;
  audience: Audience;
  source: string;
  expect: EvalCaseExpect;
  notes?: string;
}

interface CaseResult {
  evalCase: EvalCase;
  pass: boolean;
  failures: string[];
  result?: EnhancedAnswerResult;
}

function loadCorpus(): EvalCase[] {
  const file = path.join(__dirname, '../src/lib/ai/__tests__/fixtures/eval-corpus.json');
  return JSON.parse(readFileSync(file, 'utf8'));
}

function checkCase(evalCase: EvalCase, result: EnhancedAnswerResult): string[] {
  const failures: string[] = [];
  const { expect } = evalCase;
  const answerLower = result.answer.toLowerCase();

  if (expect.forbiddenSubstrings) {
    for (const s of expect.forbiddenSubstrings) {
      if (answerLower.includes(s.toLowerCase())) {
        failures.push(`ответ содержит запрещённую подстроку "${s}"`);
      }
    }
  }

  if (expect.expectedSubstrings) {
    const hasAny = expect.expectedSubstrings.some((s) => answerLower.includes(s.toLowerCase()));
    if (!hasAny) {
      failures.push(
        `ответ не содержит ни одной из ожидаемых подстрок [${expect.expectedSubstrings.join(', ')}]`
      );
    }
  }

  if (expect.requiresClarificationOrHold !== undefined) {
    const isHold =
      result.needsClarification === true ||
      result.requiresHumanReview === true ||
      result.confidenceLevel === 'insufficient';
    if (isHold !== expect.requiresClarificationOrHold) {
      failures.push(
        `ожидали requiresClarificationOrHold=${expect.requiresClarificationOrHold}, получили ${isHold} ` +
          `(needsClarification=${result.needsClarification}, requiresHumanReview=${result.requiresHumanReview}, confidenceLevel=${result.confidenceLevel})`
      );
    }
  }

  if (expect.minConfidence !== undefined && result.confidence < expect.minConfidence) {
    failures.push(
      `уверенность ${result.confidence.toFixed(2)} ниже ожидаемого минимума ${expect.minConfidence}`
    );
  }

  if (expect.answerSourceIn) {
    if (!result.answerSource || !expect.answerSourceIn.includes(result.answerSource)) {
      failures.push(
        `answerSource=${result.answerSource ?? 'undefined'} не входит в ожидаемое [${expect.answerSourceIn.join(', ')}]`
      );
    }
  }

  return failures;
}

async function runCase(evalCase: EvalCase): Promise<CaseResult> {
  try {
    const result = await answerQuestionEnhanced({
      question: evalCase.question,
      audience: evalCase.audience,
      includeDebug: false,
    });
    const failures = checkCase(evalCase, result);
    return { evalCase, pass: failures.length === 0, failures, result };
  } catch (e) {
    return {
      evalCase,
      pass: false,
      failures: [`движок упал: ${(e as Error).message}`],
    };
  }
}

async function main() {
  const idFilter = process.argv.slice(2).find((a) => a.startsWith('--id='))?.slice('--id='.length);
  const corpus = loadCorpus().filter((c) => !idFilter || c.id === idFilter);

  if (corpus.length === 0) {
    console.error('Корпус пуст (или --id не совпал ни с одним кейсом).');
    process.exit(1);
  }

  console.log(`Golden regression corpus: ${corpus.length} кейс(ов).\n`);

  const results: CaseResult[] = [];
  for (const evalCase of corpus) {
    process.stdout.write(`[${evalCase.category}] ${evalCase.id} … `);
    const r = await runCase(evalCase);
    results.push(r);
    console.log(r.pass ? 'PASS' : 'FAIL');
    if (!r.pass) {
      for (const f of r.failures) console.log(`    ✗ ${f}`);
    }
  }

  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const wrongScopeCases = results.filter((r) => r.evalCase.category === 'wrong-scope');
  const wrongScopeFailed = wrongScopeCases.filter((r) => !r.pass).length;
  const holdCount = results.filter(
    (r) => r.result && (r.result.needsClarification || r.result.requiresHumanReview)
  ).length;

  console.log('\n' + '─'.repeat(60));
  console.log('Агрегат:');
  console.log(`  pass rate:        ${passed}/${total} (${((passed / total) * 100).toFixed(1)}%)`);
  if (wrongScopeCases.length > 0) {
    console.log(
      `  wrong-scope rate: ${wrongScopeFailed}/${wrongScopeCases.length} (${((wrongScopeFailed / wrongScopeCases.length) * 100).toFixed(1)}%)`
    );
  }
  console.log(`  hold rate:        ${holdCount}/${total} (${((holdCount / total) * 100).toFixed(1)}%)`);

  const failedIds = results.filter((r) => !r.pass).map((r) => r.evalCase.id);
  if (failedIds.length > 0) {
    console.log(`\nFAILED: ${failedIds.join(', ')}`);
  }

  // Baseline run: captures current state for future diffing, does not gate
  // this invocation's own exit code — a fresh corpus legitimately contains
  // known-failing cases (see category "retrieval-gap").
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
