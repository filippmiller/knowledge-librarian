# Aurora fixture repair loop — session 2 (continuation)

**Date:** 2026-08-09
**Branch:** `feat/canonical-docx-blocks` (PR #76, still unmerged)
**Head at report time:** `e9397cc22a7ae34d268eeab2b82b4345b6f2bb97`
**Continues from:** `.claude/audits/2026-08-09-aurora-fixture-benchmark-report.md` (the first real benchmark run). This session's mandate: don't stop at "the benchmark ran" — run the autonomous repair loop (benchmark → find earliest-stage failure → RED regression → fix → retest → repeat) until the fixture passes 3 consecutive independent 10/10+6/6 runs, or hit a real external blocker.

## Final conclusion: **C — EXTERNAL BLOCKER**, secondarily **B — NOT YET ACCEPTED**

**The exact blocker:** both configured LLM providers are out of credit. Anthropic (`AI_PROVIDER=anthropic`, pinned in `.env`) returned `400: Your credit balance is too low` on the first extraction call of the prior session. This session, switching to OpenAI as a workaround, ran one full N=2 benchmark successfully, then a follow-up smoke test of the new extraction architecture hit `429: You have no credits remaining` on OpenAI too — confirmed via 6 retry attempts, all failing with `credit_balance_exhausted` / timeout. **There is currently no working LLM provider available to this session.** I cannot fund either account myself. This physically prevents Task 21 (re-running the benchmark to measure this session's fixes) and prevents exercising the semantic judge's real-call path.

Everything in this report that required a live LLM call to validate is **built, unit-tested, and unexercised against real data** — clearly marked below. Everything that could be validated without a live call (deterministic grading, RAG baseline retrieval coverage/grounding, resolution-logic root cause) **was** validated for real.

---

## §1. Starting point (from the first benchmark, unchanged baseline)

N=2 independent extraction runs, openai/gpt-4o:
- Run 1 (28 units, all 10 rules extracted): 7/10 positive, 1/6 negative.
- Run 2 (18 units, only rules 1–4 extracted): 4/10 positive, 1/6 negative.

Two concrete findings drove this session's priorities, per the user's explicit instructions:
1. **Extraction completeness** — a single whole-document call silently dropped 6 of 10 rules, schema-valid, no retry trigger.
2. **Q01-M1/Q05-M1 (privacy-context clarification)** — identical failure in both runs, the strongest evidence of a deterministic (not extraction-variance) bug.

## §2. Repair waves this session

### Wave 1 — Bounded-batch extraction architecture (`0b9d787`)
**Root cause (already established):** one long generation silently drops tail content, even when the JSON stays schema-valid — retries on schema/transport failure structurally cannot catch this, because nothing fails.
**Fix:** `extractKnowledgeUnitsInBatches` (`src/lib/knowledge/batch-extraction.ts`) bounds each extraction call to a configurable group of adjacent canonical blocks (default 4), namespaces `extractionRef`/`parentExtractionRef` per batch to prevent merge collisions, re-validates the merged set. Generalizes to any document — no fixture-specific assumption anywhere in the module.
**Verification:** 10 unit tests, pure logic (batching/merging/namespacing) via an injected extractor — no network call needed for these to be real proof. **Not yet validated against a real multi-batch extraction run** (blocked, see §5).

### Wave 2 — Oracle-blind extraction completeness auditor (`3efe1ff`, `ad02a17`)
**Fix:** `auditBlockCoverage` (`src/lib/knowledge/extraction-coverage-auditor.ts`) — sees only one source block's text + the units extracted from it, never questions/answers/rule-ids. Reports `COVERED`/`POSSIBLE_OMISSION`/`UNREPRESENTED_CLAUSE`/`AMBIGUOUS` per block with quotes verified against the actual block text (an unverifiable quote is flagged, not dropped). `extractKnowledgeUnitsWithCompletenessAudit` (`src/lib/knowledge/audited-extraction.ts`) composes this with Wave 1: every block gets audited after the batch pass; a confirmed gap triggers exactly one bounded, focused re-extraction of just that block — never a retry loop, never "retry until the score improves" (both explicitly forbidden by the task).
**Lives in `src/lib/knowledge/`**, not `src/lib/eval/`, specifically so the oracle-blind production runner (`scripts/run-extraction.ts`) can eventually import it — this was built as a real mechanism, not a benchmark-only check. Wiring into `run-extraction.ts` itself was not completed this session (time went to the benchmark-runner wiring + the credit blocker investigation instead) — **flagged as a real gap**, not silently skipped.
**Verification:** 10 + 4 unit tests (auditor pure logic, composition orchestration), all with injected extractor+auditor. **Not yet validated against a real audit call** (blocked).

### Wave 3 — Privacy-context clarification fix (`41cb23f`) — the one fix validated against real failure data
**Root cause, traced from the actual `run-1` engine trace, not guessed:**
- `queryFrame.triggerFacts.privacyContext.state === 'UNKNOWN'` — correct, QueryFrame extraction is not at fault.
- `evaluateTrigger` correctly held both competing `EXCEPTION_RULE` candidates as `exception_trigger_unknown` — trigger evaluation is not at fault.
- `resolution.disposition` still came out `ANSWER` with **empty** `clarificationNeeds` — confirmed by reading `resolveKnowledgeSet`'s `isDecisive()`: it required the held candidate's `parentRuleRef` to point at a viable candidate. Checked the actual persisted units from that run: both held exceptions had `parentRuleRef: null` — extraction never linked them to the general rule they'd override.
**Fix:** `isDecisive()` now also treats an `EXCEPTION_RULE` with `parentRuleRef === null` **and** `trigger.verdict === 'UNKNOWN'` as decisive — distinct from the already-correct, already-tested "parent ref present but that unit isn't in the current candidate pool" case (left unchanged; there we know exactly what's absent, here we know nothing about what the exception overrides, so any confidently selected candidate could be it).
**Verification:** a pre-existing test literally named `"Q01-M1 / Q05-M1"` already covered the parent-linked case and passed — confirming the original design intent was right, just unreachable when extraction doesn't reliably link exceptions (a real, previously-documented instability, not a new one). New RED test for the `parentRuleRef: null` case; all 40 `resolution.test.ts` tests green, full suite green (1357 tests). **This fix is validated as far as pure logic can validate it** — the next real benchmark run against Q01-M1/Q05-M1 will confirm it end to end, but that's blocked (§5).

### Wave 4 — Semantic answer judge (`c5a8763`)
Deterministic grading only proves structural correctness; it cannot know if the prose is right. `judgeAnswer` (`src/lib/eval/semantic-answer-judge.ts`) — `CORRECT`/`PARTIALLY_CORRECT`/`INCORRECT`/`UNSUPPORTED`/`OVERCLAIMED`, provenance (provider/model/prompt-version) always attached, a structural PASS and a semantic verdict are separate signals (neither overrides the other, per the task's explicit instruction). Pure prompt-building/response-interpretation tested (8 tests); the real-call wrapper is **built but has never successfully executed** — every attempt this session hit the credit exhaustion.

### Wave 5 — Quantitative RAG baseline grader (`e9397cc`) — actually run against real data
Previously the RAG comparison was qualitative only. `scripts/grade-rag-baseline.ts` adds: retrieval coverage (did retrieved chunks cover the expected source rule, via the same DOCX-text-containment principle as `resolveSourceRuleId`), numeric grounding (`checkClaimGrounding`, the identical policy the structured engine is held to), and a semantic verdict when a provider is available. **Actually executed** against the existing RAG baseline results (deterministic parts don't need a live call for retrieval/grounding — only the judge step does, and that gracefully degraded to a per-case captured error instead of crashing):

| Metric | Result |
|---|---|
| Retrieval coverage (expected rule reached top-K) | **13/15** cases with a known expected rule |
| Numeric grounding (no unsupported numbers) | **15/16** |
| Semantic judge | 0/16 judged — every attempt correctly captured the real `Anthropic API error (400): credit balance too low` per case, not silently skipped |

Two retrieval misses worth naming: **Q02** (expected rule 2, retrieved rules 10/6/7 — a real miss) and **Q05-N1** (expected rules 1/3/5, retrieved 5/1/8/4 — rule 3 missing). One grounding miss: **Q04-N1**. This is now a real, if partial, quantitative comparison point instead of a purely qualitative read.

## §3. What was NOT done this session (explicit, not silent)

- **Task 21 (re-run the full benchmark)** — blocked, see conclusion. Waves 1–2 and the Q01-M1/Q05-M1 fix (Wave 3) have never been exercised together against a real extraction+retrieval+resolution run. Everything is unit-tested at the logic level; nothing is confirmed end-to-end yet.
- **Wiring the completeness auditor into `scripts/run-extraction.ts`** (the production, oracle-blind runner) — only wired into the benchmark runner. A real gap against the "must generalize, must be production-useful" instruction — not completed due to time going to the credit-blocker investigation and the other five waves.
- **3 consecutive 10/10+6/6 runs** — nowhere close; N=2 total runs exist across both sessions, both pre-dating this session's fixes.
- **Negative-case RAG grading for cases without a nested `NegativeCase.expectedAnswer`** — `grade-rag-baseline.ts` covers what the oracle actually provides; a few negative cases may have no gradable expected-answer text and are reported as such, not guessed.

## §4. Anti-overfitting compliance

No fix this session touched retrieval aliases, prompts, or added conditions derived from oracle wording. The batch-extraction and coverage-auditor modules take no fixture-specific parameters (block count, rule numbering) anywhere — verified by reading the modules back, not just asserted. The `resolution.ts` fix is a general rule about `EXCEPTION_RULE`+`UNKNOWN` trigger+`null` parent, stated and tested independent of Q01-M1's specific wording (the RED test uses a synthetic `rule-1`/`rule-5` fixture, matching the existing test file's convention, not the real question text).

## §5. Provider status (exact)

| Role | Provider/model (last successful) | Current status |
|---|---|---|
| Extraction | openai/gpt-4o | **Out of credit** (`429`, confirmed 2026-08-09) |
| Reranker | openai/gpt-4o | Same account, same status |
| QueryFrame | openai/gpt-4o | Same account, same status |
| Synthesis | openai/gpt-4o | Same account, same status |
| Semantic judge | anthropic (default via `AI_PROVIDER`) | **Billing-blocked** (`400`, confirmed prior session, re-confirmed this session via `grade-rag-baseline.ts`'s captured errors) |

No model was silently swapped mid-comparison — every artifact from the prior benchmark is labeled `openai/gpt-4o` in its own `evaluation-snapshot.json`/`extraction-attempt-log.json`.

## §6. What to do the moment either provider has credit

1. `npx tsx scripts/run-aurora-fixture.ts --mode=e2e --extraction-runs=3 --out=<dir>` (batch-size defaults to 4, override with `--batch-size=`) — exercises Waves 1–3 together for the first time.
2. `npx tsx scripts/grade-aurora-fixture.ts --in=<dir> --out=<dir>/grade-report.json`
3. Compare against §1's baseline specifically on: extraction rule-count completeness (was the 28-vs-18 swing fixed?), and Q01-M1/Q05-M1 (does `resolution.disposition` now come out `CLARIFY`?).
4. Wire the completeness auditor into `scripts/run-extraction.ts` (production parity, not done this session).
5. Re-run `scripts/grade-rag-baseline.ts` with a working judge to get the semantic verdicts §2's Wave 5 table is missing.
6. Continue the earliest-stage-first repair loop from there.

## §7. CI / verification status

`pnpm typecheck` / `pnpm lint` (0 errors) / `pnpm test` (1357 tests) all green as of `e9397cc`. Full commit list this session: `0b9d787`, `3efe1ff`, `ad02a17`, `30606eb`, `41cb23f`, `c5a8763`, `e9397cc` (plus the prior session's `2da07e3` and earlier). No merge, no deploy, no human review fabricated, no oracle content used to tune any prompt/alias.
