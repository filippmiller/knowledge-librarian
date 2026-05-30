/**
 * Golden eval harness for the answering engine.
 *
 * Runs every case in cases.json through `answerQuestionEnhanced` and asserts
 * STRUCTURALLY (scenario / source / clarification / key substrings) — no LLM
 * judge, deterministic, cheap. Catches routing, source-attribution and
 * key-fact regressions after ANY code change AND after every document ingest.
 *
 * Run (DB + models on Railway):
 *   railway run npx tsx scripts/eval/run.ts
 *   railway run npx tsx scripts/eval/run.ts --verbose   # show answers for failures
 *
 * Exit code 0 = all pass, 1 = at least one failure (CI / ingest gate).
 *
 * cases.json schema — each case: { q, expect } where expect has any of:
 *   scenarioKey   string   result.scenarioKey must equal this
 *   source        'knowledge_base' | 'general_ai' | 'deterministic_guardrail' | 'none'
 *   clarify       boolean  whether the answer is a scenario clarification (buttons)
 *   level         'high' | 'medium' | 'low' | 'insufficient'
 *   mustInclude   string[] each substring must appear in the answer (case-insensitive)
 *   mustNotInclude string[] none of these may appear (case-insensitive)
 * Assert only STABLE facts (verbatim addresses/numbers, source, scenario) — never
 * LLM phrasing. Omit a field for cases where it is legitimately non-deterministic.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { answerQuestionEnhanced } from '../../src/lib/ai/enhanced-answering-engine';

interface Expect {
  scenarioKey?: string;
  source?: 'knowledge_base' | 'general_ai' | 'deterministic_guardrail' | 'none';
  clarify?: boolean;
  level?: 'high' | 'medium' | 'low' | 'insufficient';
  mustInclude?: string[];
  mustNotInclude?: string[];
}
interface Case { q: string; expect: Expect }

const verbose = process.argv.includes('--verbose');
const here = dirname(fileURLToPath(import.meta.url));
const cases: Case[] = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));

function checkCase(answer: string, source: string, scenarioKey: string | undefined, clarify: boolean, level: string, e: Expect): string[] {
  const fails: string[] = [];
  const lc = answer.toLowerCase();
  if (e.scenarioKey !== undefined && scenarioKey !== e.scenarioKey)
    fails.push(`scenarioKey: expected "${e.scenarioKey}", got "${scenarioKey ?? '—'}"`);
  if (e.source !== undefined && source !== e.source)
    fails.push(`source: expected "${e.source}", got "${source}"`);
  if (e.clarify !== undefined && clarify !== e.clarify)
    fails.push(`clarify: expected ${e.clarify}, got ${clarify}`);
  if (e.level !== undefined && level !== e.level)
    fails.push(`level: expected "${e.level}", got "${level}"`);
  for (const s of e.mustInclude ?? [])
    if (!lc.includes(s.toLowerCase())) fails.push(`mustInclude missing: "${s}"`);
  for (const s of e.mustNotInclude ?? [])
    if (lc.includes(s.toLowerCase())) fails.push(`mustNotInclude present: "${s}"`);
  return fails;
}

async function main() {
  console.log(`Eval: ${cases.length} cases\n`);
  let passed = 0;
  const failedCases: { q: string; fails: string[]; answer: string }[] = [];

  for (const c of cases) {
    let answer = '', source = 'none', scenarioKey: string | undefined, clarify = false, level = '?';
    let lastErr: unknown;
    let ok = false;
    // Retry once: a transient infra blip (dropped embedding/DB socket, body
    // timeout) must not be reported as an answer-quality failure.
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      try {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
        const r = await answerQuestionEnhanced(c.q);
        answer = r.answer ?? '';
        source = r.answerSource ?? 'none';
        scenarioKey = r.scenarioKey;
        clarify = !!r.scenarioClarification;
        level = r.confidenceLevel;
        ok = true;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!ok) {
      failedCases.push({ q: c.q, fails: [`ENGINE THREW: ${(lastErr as Error).message}`], answer: '' });
      console.log(`✗ ${c.q}\n    ENGINE THREW (after retry)`);
      continue;
    }
    const fails = checkCase(answer, source, scenarioKey, clarify, level, c.expect);
    if (fails.length === 0) {
      passed++;
      console.log(`✓ ${c.q}`);
    } else {
      failedCases.push({ q: c.q, fails, answer });
      console.log(`✗ ${c.q}`);
      for (const f of fails) console.log(`    ${f}`);
      if (verbose) console.log(`    ── answer ──\n    ${answer.replace(/\n/g, '\n    ').slice(0, 600)}`);
    }
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`РЕЗУЛЬТАТ: ${passed}/${cases.length} прошло`);
  if (failedCases.length > 0) {
    console.log(`Провалено: ${failedCases.map((f) => `"${f.q}"`).join(', ')}`);
    process.exit(1);
  }
  console.log('Все кейсы прошли ✓');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
