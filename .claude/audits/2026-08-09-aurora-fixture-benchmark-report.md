# Aurora fixture end-to-end benchmark — first real run

**Date:** 2026-08-09
**Branch:** `feat/canonical-docx-blocks` (PR #76, still unmerged, not merged/deployed this session)
**Goal shift:** mid-session the objective changed from "prepare for retrieval, wait for human review" to "run a true end-to-end benchmark now, without human review" (confirmed with the user; two architectural decisions confirmed via explicit question before implementation — see §3).
**Provider used:** **openai/gpt-4o**, not Anthropic. `AI_PROVIDER=anthropic` is pinned in `.env`, but the Anthropic account returned `400: Your credit balance is too low` on the very first extraction call. I cannot top up billing myself. All results below are OpenAI-only — **re-run on Anthropic once credits are available** (the extraction prompt/schema were originally tuned and validated against `claude-haiku-4-5`, per `.claude/audits/2026-08-08-extraction-stability-fragmentation-report.md`; OpenAI is a live, currently-untuned alternative, not a substitute for that validation).

Artifacts (gitignored, local, paths given for reproduction):
- `scratchpad/aurora-fixture-benchmark/` — 2 independent extraction runs + graded report
- `scratchpad/rag-baseline/` — RAG baseline run
- `scratchpad/aurora-fixture-smoke/` — earlier 1-run smoke test used to find and fix two schema bugs (see §2)

---

## §1. What was built this session (code, not results)

Full list with commit SHAs in `git log feat/canonical-docx-blocks`. Summary:

**Pre-retrieval technical blockers (all closed, RED-then-GREEN, all committed separately):**
1. `compareExtractionRuns` — `fullyStable` now requires content+parent+trigger+uncertainty stability together, not `contentHash` alone.
2. `semantic-retrieval.ts` (translation-kis) — `embedCandidates` rejects batch-length mismatch; `retrieveUnits` rejects mixed/mismatched embedding-model identity between corpus and query.
3. `retrievalText` — `scenario`/`documentForm` no longer silently dropped (the only two facets without a `ConceptVocabulary` entry).
4. `buildQueryFrame` — message id uniqueness + quote-is-real-substring trust boundary.
5. `buildFacetState` — additive-vs-replacement history reconciliation is now per-value, not per-message.
6. `evaluateRecall` — rejects NaN/Infinity/negative/fractional `k`; `k=0` stays legal.
7. Evidence-group coverage grading for multi-clause rules 9/10, calibrated against a real extraction run, not invented.
8. `oracle-taint.ts` — per-secret coverage tracking + exact-substring guard for short/fully-source-overlapping secrets. Real pack: **0 unguarded secrets**.

Deferred (not started, does not block the benchmark): Task 2 (bind `ReviewedKnowledgeSnapshot` to a single hashed qualification artifact) and Task 10 (`--stage=qualify` CLI skeleton) — both are production human-review-path hardening, explicitly not needed once the goal shifted to an unreviewed evaluation snapshot. Production trust boundary was not weakened to make this true (see §3).

**New evaluation-only infrastructure:**
- `EvaluationKnowledgeSnapshot` (`src/lib/eval/evaluation-snapshot.ts`) — explicitly unreviewed (`humanReviewed: false`), structurally non-assignable to `ReviewedKnowledgeSnapshot` (compile-time proof).
- `PersistedKnowledgeUnit → ApplicabilityProfile/EvaluatedCandidate` adapter (`src/lib/eval/knowledge-unit-adapter.ts`) — **did not exist anywhere before this session**; the applicability/synthesis modules were fully built and unit-tested in isolation but never wired end to end.
- `resolveSourceRuleId` (`src/lib/eval/source-rule-mapping.ts`) — unit→source-rule-number mapping without a review manifest (DOCX text-containment matching, not oracle-derived).
- `scripts/run-aurora-fixture.ts` — the real end-to-end runner (DOCX → extraction → embed → per-question QueryFrame → retrieval → applicability → resolution → synthesis → verification).
- `scripts/grade-aurora-fixture.ts` — separate grading pass, deterministic only.
- `scripts/run-rag-baseline-fixture.ts` — simple hybrid RAG comparison point.

## §2. Two real bugs found and fixed by actually running the pipeline (not by inspection)

Both are the same class already fixed twice before this session for `triggerCondition`/`numericConstraint` (`extraction.ts`, `.nullish().transform(v => v ?? …)`):
- **`uncertainties` missing key**: gpt-4o omitted the `uncertainties` array entirely on **6 of 6** retry attempts in the first smoke test. Fixed with the same nullish-transform pattern.
- **`facets: null`**: gpt-4o sent `null` instead of `{}` for units with no applicable facets. Same fix.

Both are legitimate schema robustness fixes (not benchmark-only hacks) — they reduce wasted retries for any provider, RED-tested, committed separately.

## §3. Two architectural decisions made before building the adapter (both confirmed with the user first)

1. **`reviewStatus: 'REVIEWED'`, `reviewedBy: 'EVALUATION_HARNESS_UNREVIEWED'`.** Discovered: `evaluateUnitEligibility` unconditionally sets `requiresHumanReview = true` for any `UNCLASSIFIED` unit, and `resolveKnowledgeSet` propagates that into a forced `HOLD` on every case that selects such a unit — regardless of retrieval/synthesis quality. Without this, the benchmark would have measured nothing but that gate firing 16/16 times. The sentinel reviewer id is unmistakable in every artifact.
2. **Every applicable facet is `GLOBAL`, not `SCOPED`.** This training document has zero scenario/service/routing concept (confirmed empirically: 0 of 41 real extracted units in the prior session's `scratchpad/extraction-runs/run1` populate any production facet). `evaluateFacet` forces `UNKNOWN` (non-askable) whenever a profile facet is left `UNKNOWN` — same forced-`HOLD` dead end via a different path. `GLOBAL` is the honest label: this rule was never meant to be partitioned by scenario, not "a human reviewed and scoped it to nothing."

Both are confined to `src/lib/eval/`, clearly labeled, and structurally cannot leak into the production `ReviewedKnowledgeSnapshot` path.

## §4. Benchmark results — N=2 independent extraction runs (OpenAI/gpt-4o)

N=2, not 3, given the Anthropic block already cost real time recovering; the runner supports arbitrary N (`--extraction-runs=N`) and this should be re-run at N≥3 on Anthropic.

### Extraction variability (confirmed, not hypothetical)

| | Run 1 | Run 2 |
|---|---|---|
| Persisted units | 28 | 18 |
| Extraction attempts | 1 (success first try) | 1 (success first try) |
| Source rules represented | **all 10** (1–10) | **only 4** (1–4) — rules 5–10 never extracted at all |

Run 2's extraction silently dropped six of ten rules from the source document on a single LLM call, with no retry trigger (the call *succeeded* schema validation — it just extracted less). This is the single largest driver of this run's score.

### Per-run scores (of the questions that were gradable — deterministic structural/citation checks, see §6 for what this does NOT prove)

| Run | Positive (Q01–Q10) | Negative (6 cases) |
|---|---|---|
| Run 1 (28 units) | **7/10** | **1/6** |
| Run 2 (18 units) | **4/10** | **1/6** |

### Per-question pass rate across both runs

| Passes both runs (2/2) | Passes one run (1/2) | Fails both runs (0/2) |
|---|---|---|
| Q01, Q02, Q03, Q04, Q04-N1 | Q06, Q07, Q08 | Q05, Q09, Q10, Q01-M1, Q05-N1, Q05-M1, Q09-N1, Q10-N1 |

**Q06/Q07/Q08 passed in run 1 and failed in run 2 for exactly one reason: extraction dropped their source rules that run.** This is extraction variability directly and visibly determining answer correctness — not a retrieval, applicability, or synthesis defect for those three.

## §5. Failure attribution by stage (from `grade-aurora-fixture.ts`, both runs)

| Stage | Cases | What it means |
|---|---|---|
| `EXTRACTION_MISS` | Q05,Q06,Q07,Q08,Q09,Q10 (run 2 only) | Source rule never appeared in this run's extraction output at all |
| `RETRIEVAL_MISS` | Q05-N1, Q09-N1, Q10-N1 (run 2) | Rule was extracted but never entered the candidate pool for that specific question — retrieval, not applicability, is the first suspect |
| `RESOLUTION_ERROR` | Q05 (run 1), Q09 (run 1) | Rule reached top-K but wasn't selected, or a multi-clause evidence group (Task 8) was only partially covered |
| `APPLICABILITY_ERROR` | Q05-N1, Q10-N1 (run 1) | A narrow exception rule was selected where it should have been excluded |
| `EXPECTED_CLARIFICATION_MISSED` | Q01-M1, Q05-M1 (**both runs**) | The dangerous false-positive case: engine answered directly when it should have asked for clarification |
| `UNEXPECTED_HOLD` | Q10 (run 1) | Engine held when the rule was actually available |

**The most consequential, run-independent finding:** Q01-M1 and Q05-M1 (both `must_clarify` negative cases hinging on `privacyContext` ambiguity) fail identically in **both** runs, with identical diagnostic detail — the engine never surfaces `privacyContext_unknown` or names `privacyContext` as a missing trigger fact, and answers directly instead of asking "public or private?" This reproduces regardless of which units got extracted, which means it is very unlikely to be an extraction-variability artifact — it looks like a real, deterministic gap in how `QueryFrame`/`resolveKnowledgeSet` handle privacy-context ambiguity for these two phrasings specifically. This is the single highest-value lead for reaching 6/6 negatives and worth investigating directly (not by tuning to this wording — by tracing why `privacyContext` never enters `clarificationNeeds` for these cases).

Evidence-group coverage (Task 8) is doing real work: Q09 in run 1 was flagged specifically because only the "consent" fragment of rule 9 was selected, missing gloves and stop-on-request — exactly the false-pass the mechanism was built to close. Confirmed operating on live data, not just its own unit tests.

## §6. What this grading does NOT prove

- **No LLM semantic judge was built this session.** A case marked `pass: true` means: right rule(s) reached selection, disposition matched, evidence-group coverage satisfied, and `verifyAnswerClaims` found no unsupported numbers/uncited claims/wrong answer source. It does **not** mean a human read the prose and confirmed it correctly represents the rule — that judgment layer (Step 7 of the corrected spec) is an explicit, real gap, not an oversight. Preferred next step per the spec's own guidance ("prefer deterministic facts over LLM judgment where encodable") — this was mostly achieved; the remaining gap is genuinely hard to encode deterministically (full prose correctness).
- **`gradeCase`-style structural grading, not `case-grader.ts` itself.** `grade-aurora-fixture.ts` is a new, purpose-built grader for the evaluation path (no `sourceRuleByUnitId` from a review manifest exists here) — it reimplements the same spirit as `case-grader.ts` but is not literally that module, and has not had the same multi-round adversarial review `case-grader.ts` went through.
- **Only 2 runs.** Real variance exists (§4) but N=2 is too small to separate "this specific run had bad luck" from "this is the true failure rate." N≥3, ideally 5, on the properly-tuned Anthropic model, is needed for a trustworthy number.

## §7. Aurora structured engine vs. simple RAG baseline (qualitative, not scored)

**No quantitative grade was built for the RAG baseline this session** — it produces free text with no structured rule-selection trace to grade against `expected_rule_ids`, and building an equivalent grader was out of scope given time already spent. What follows is a qualitative read of all 16 RAG answers side by side with the structured engine's failures.

Notable: on several cases where the **structured engine failed**, the RAG baseline's prose reads as **substantively correct**:
- **Q09-N1** ("can a husband scratch his sleeping wife since she didn't object before?") — RAG: *"No — consent given earlier is not indefinite, explicit consent from the person being helped is required."* Correct, and correctly cites the "consent isn't indefinite" caveat. Structured engine failed this case in both runs (missing `consentStatus_violated` reason code / rule 9 not selected in run 2).
- **Q10** and **Q10-N1** — RAG gave complete, correct answers (alternative method + hard/sharp-object prohibition). Structured engine held unexpectedly (run 1) or missed the rule at extraction (run 2).
- **Q01-M1/Q04-N1/Q05-N1** — RAG answered directly and reasonably where the structured engine either missed clarification or missed the rule.

Two RAG answers were weak: **Q02** ("touch skin immediately if hands look clean") correctly said "not stated," but **Q09** claimed the fragments "don't contain information about" a close person helping — incorrect, rule 9 explicitly covers this.

**Honest read:** on this fixture, at this sample size, plain hybrid RAG's prose accuracy looks *at least competitive with*, and on several specific cases *better than*, the structured engine — but RAG has none of the structural guarantees the Aurora architecture is built for: no evidence-pack-grounded citation verification, no formal `HOLD`/clarify mechanism (it always answers, never asks), no per-clause coverage check, no audit trail linking an answer to a specific extracted unit. RAG "getting Q09-N1 right" is not verifiable the way `verifyAnswerClaims` verifies the structured path — it could be right by more thorough retrieval, or right by the LLM's own general reasoning filling gaps, and there's no mechanism here to tell which. **This comparison needs a real grader (structured extraction of RAG's implied rule coverage, or the same LLM-judge layer proposed in §6) before it supports any strong claim** — right now it's a genuine, useful signal that the extra complexity hasn't yet paid for itself on this fixture, not proof that it can't.

## §8. What's needed for consistent 10/10 + 6/6

1. **Anthropic, not OpenAI, for the real number.** Re-run this exact benchmark once credits are available. Given the pre-existing extraction-stability report showed Claude achieving 41/38 persisted units (vs. this session's 28/18 on OpenAI) with no rules ever missing entirely, extraction completeness is very plausibly a provider-quality problem more than an architecture problem.
2. **Investigate the `privacyContext` clarification gap directly** (§5) — reproduces in both runs, both `-M1` cases, identically. Highest-value, most tractable lead.
3. **N≥3 (ideally 5) runs** before trusting a stability number — 2 runs already showed a 2x swing in extracted rule count.
4. **Build the LLM semantic judge layer** (§6) — structural pass is a necessary, not sufficient, condition; several `pass: true` cases have not had their prose read by anything.
5. **A real grader for the RAG baseline** before the Aurora-vs-RAG comparison in §7 can support a real conclusion either way.

## §9. Oracle isolation — held

`runEngineOnQuestion` (and the RAG baseline's equivalent) took only `{caseId, question}` for every one of the 32 engine invocations (16 questions × 2 runs) plus 16 RAG invocations. Every engine-input artifact (QueryFrame messages, retrieval candidate text, evidence pack, synthesis output, RAG's retrieved chunks and answer) ran through `OracleTaintDetector.assertClean()` before use — zero throws across all runs. No expected_answer/expected_rule_ids/match_reason ever reached engine input.

## §10. Explicit status against the original (pre-goal-shift) stop condition

- **READY FOR HUMAN REVIEW:** the 8 pre-retrieval hardening fixes (§1) are done and independently useful regardless of the benchmark; `ReviewedKnowledgeSnapshot`/manifest-gate path is untouched, still exactly as it was, still needs a human reviewer who hasn't seen this report.
- **READY FOR RETRIEVAL:** confirmed working end to end, on real (if imperfect) data, this session.
- **NOT YET READY FOR PRODUCTION E2E:** provider (Anthropic billing), sample size (N≥3), the privacyContext gap, and the semantic judge layer are all open per §8.

No merge, no deploy, no fabricated human review this session, as instructed.
