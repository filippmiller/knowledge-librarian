# Aurora fixture repair loop — session 3 (provider recovery, first full run)

**Date:** 2026-08-09
**Branch:** `feat/canonical-docx-blocks` (PR #76, still unmerged)
**Continues from:** `.claude/audits/2026-08-09-aurora-fixture-repair-loop-report.md` (session 2, ended at **Conclusion C — external blocker**: both Anthropic and OpenAI out of credit). This session: user confirmed both providers refunded, explicitly instructed use of `claude-sonnet-5` (not the `.env`-configured Haiku). Model config updated (`ANTHROPIC_MODEL=claude-sonnet-5`).

## Final conclusion: **B — NOT YET ACCEPTED**

The external blocker from session 2 is resolved. This session ran the full pipeline end-to-end for the **first time this repair-loop phase**, found and fixed three more real infrastructure bugs via TDD, validated the session-2 resolution.ts fix against live data for the first time, and — as a direct, honest consequence of that validated fix — surfaced two new, deeper architectural gaps that are real follow-up work, not something to patch blindly. Raw pass rate on the one graded run (2/10 positive, 1/6 negative) is *numerically* worse than the pre-fix N=2 baseline (7/10+1/6, 4/10+1/6), but for principled reasons explained in §3 — the system is now *more* epistemically honest, not less capable.

---

## §1. What happened this session, in order

1. **Smoke-tested Haiku** (the `.env` default) — failed 6/6 with `SCHEMA_MISMATCH` (invented trigger-fact names). Not a bug to fix; a real model-capability gap, consistent with the user's explicit instruction to use Sonnet 5 instead.
2. **Switched to `claude-sonnet-5`**, smoke-tested extraction alone — clean (45 units, 0 gaps). Embeddings blocked (OpenAI still out of credit at that point).
3. **User: "openai reloaded."** First full N=1 attempt — extraction succeeded even more cleanly (39 units, 0 gaps), but correctly halted by `OracleTaintDetector.assertClean()` before embeddings: a genuine false-positive collision on rule 4 ("трёх циклов" — source says "трёх **таких** циклов," oracle and model both independently drop "таких").
4. **Bug #1 found+fixed** (`2534e18`): the new oracle-blind completeness auditor's schema hard-required `explanation: string` unconditionally; Sonnet 5 legitimately omits it for `verdict: "COVERED"` (nothing to explain). Nullish-transform fix, same precedent as `uncertainties`/`facets` from session 2. RED→GREEN, full suite green, committed.
5. **Bug #2 found+fixed** (`281b45d`): the rule-4 taint collision recurred on retry. Added a typed `OracleTaintError` class and a bounded (3-attempt) auto-retry in the runner — a taint trip is "this sample is invalid, get a fresh one," the same class of decision as the existing transport/schema retry, never a quality-driven loop. Caught a real TDD trap while writing the RED test: `toThrow(OracleTaintError)` with `OracleTaintError` undefined silently degrades to `toThrow()` and passes against *any* error — rewrote as an explicit `instanceof` check.
6. **Bug #3 found+fixed** (`0e33486`): the taint auto-retry worked twice, then a plain transient network error inside `auditBlockCoverage` crashed the run — that call had *zero* retry protection, unlike the main extraction call. Extracted the retry/classification logic into a generic `withStructuredRetry` helper, wired a `retryingAuditor` through the auditor dependency `audited-extraction.ts` already exposed.
7. **Second false-positive taint collision root-caused** (`a847485`): rule 6 ("участок промывают водой…" — source says "участок **аккуратно** промывают…," same convergence pattern as rule 4). Raised the retry bound 3→6 — a uniform retry-budget change, not wording-specific tuning.
8. **First full successful end-to-end run** (`full-smoke6`, run `run-1-2026-08-09T09-11-48-011Z`): 5 taint-retry attempts fired and self-recovered (2× rule-4 phrase, 3× rule-6 phrase — further confirming both are real, recurring convergences, not flukes), extraction converged at 46 units / 41 batches deep, all 16 questions got a disposition. One question (Q09-N1) hit an unrelated transient network error inside the per-question engine pipeline and was correctly isolated as `ERROR` rather than crashing the whole run (existing per-question isolation working as designed — flagged as a smaller follow-up, not fixed this session).
9. **Graded** — see §2/§3.

## §2. Grading result

| Metric | Result |
|---|---|
| Positive | 2/10 (was 7/10, 4/10 across the two N=2 baseline runs) |
| Negative | 1/6 (same as both baseline runs) |
| **Q01-M1 / Q05-M1** | **Both correctly HOLD** — first live validation of the session-2 resolution.ts fix. `Q01-M1`'s `resolution.disposition` is `CLARIFY` with `clarificationNeeds.triggerFacts` naming the right fact; `Q05-M1` likewise. (The runner's `actualDisposition` type only has `DIRECT_ANSWER \| HOLD \| ERROR` — no separate `CLARIFY` bucket — so both surface as `HOLD` at that layer; this simplification predates this session and isn't touched here.) |

Full per-case detail: `scratchpad/aurora-fixture-full-smoke6/grade-report.json`.

## §3. Why the pass rate dropped — root-caused, not guessed

Read the full `resolution` object for every unexpected-HOLD case (`engine-results.json`) rather than assuming. Two distinct, unrelated phenomena, both honest:

### 3a. Retrieval/reranking precision gap (Task 29)

`Q01`, `Q02`, `Q07`, `Q09` all resolve to `CLARIFY` because an **unlinked exception rule with an unknown trigger fact** made it into the candidate pool with a high reranker score, even though a human would call it off-topic. Concretely for Q01 ("is it mandatory to fully undress"): unit `39edcdb6bfb413bc` (rule 5, the public-place exception) ranked #2 by the LLM reranker (score 0.3) — but rule 5 answers a *different* question (Q01-M1: touching through fabric in public vs. private), not Q01's actual question (how much clothing to remove). Because that unit is `EXCEPTION_RULE` + `parentRuleRef: null` + `trigger.verdict: UNKNOWN`, the session-2 `isDecisive()` fix — required and correct for Q01-M1/Q05-M1, where this exact shape of ambiguity is real — now also fires here, where it arguably isn't.

**This is not a resolution.ts bug.** Weakening `isDecisive()` to stop firing here would reintroduce the original Q01-M1/Q05-M1 defect. It's a genuine precision gap one layer upstream: the system cannot yet distinguish "genuinely relevant, undetermined exception" from "topically-adjacent but off-topic candidate that happens to have the same structural shape." Fixing it for real means either improving reranking precision or having extraction reliably link every exception rule to the general rule it excepts (so `isDecisive` has a structural signal instead of leaning on "unlinked" as a catch-all) — both real design work, not a quick patch, and neither may touch this fixture's specific wording per the anti-overfitting rule.

### 3b. Parent-linking modeling ambiguity (Task 28)

`Q05` and `Q08` resolve to `HOLD` via `requiresHumanReview` (`exception_without_parent` / `exception_without_trigger`), with **empty** `undetermined`/`clarificationNeeds` — a different code path than 3a. For Q05: extraction linked `cb05cac11445ee2b` (rule 5's "≤3 seconds" numeric detail) as a *child* of `39edcdb6bfb413bc` (rule 5's own broader statement) — both describe the **same** underlying rule 5 at different levels of detail, not a general-rule/exception-to-it pair. `resolution.ts`'s override step (§4.1 п.2) then treats the numeric-detail unit as overriding a genuine general rule, removes the broader statement from `selected`, and correctly flags `exception_without_parent` because the numeric-detail unit's *true* parent (whatever general rule — likely rule 1 — that rule 5 as a whole is an exception to) was never linked at all.

This looks like a real ambiguity in what `parentRuleRef` is supposed to mean when extraction splits one source rule into multiple `EXCEPTION_RULE` units at different granularities — worth investigating at the extraction schema/prompt level, not the resolution layer.

## §4. Anti-overfitting compliance

No fix this session touched retrieval aliases, reranker prompts, or extraction prompts to chase this fixture's specific wording. The taint-retry bound increase is a uniform budget knob, applied regardless of which phrase collides. Both new findings (§3) were deliberately **not** patched this session — a rushed fix to either would risk tuning to this fixture's specific candidate shapes rather than fixing the general mechanism, which the standing instruction explicitly forbids.

## §5. Verification status

`pnpm typecheck` / `pnpm lint` (0 errors) / `pnpm test` (1361 tests) green before every commit this session. Commits: `2534e18`, `281b45d`, `0e33486`, `a847485`. No merge, no deploy, no human review fabricated.

## §6. Recommended next steps

1. Task 28 (parent-linking semantics) and Task 29 (retrieval precision) both need real design attention before another benchmark run is worth executing — re-running now would likely reproduce the same shape of result.
2. Once either lands, re-run the full pipeline (`--extraction-runs=1` first to confirm, then `--extraction-runs=3` for the real Phase-C acceptance check).
3. Q09-N1's transient mid-pipeline network error (isolated correctly, not crashed) suggests `runEngineOnQuestion` could use the same bounded-retry treatment already given to extraction and coverage-audit calls — smaller, safe follow-up.
4. Wire the completeness auditor into the production runner `scripts/run-extraction.ts` (still not done, carried over from session 2).
