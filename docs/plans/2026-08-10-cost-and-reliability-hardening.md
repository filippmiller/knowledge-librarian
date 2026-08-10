# Cost + reliability hardening plan (2026-08-10)

**Status:** active. Supersedes the ad-hoc "Tasks 39–42" list.

## Why this plan exists

An owner audit of a single day's spend ($19.79 on Sonnet 5) triggered a cost review.
Building the cost meter (Tasks 37–38) revealed the spend, and an adversarial
cross-audit by an independent model (`gpt-5.6-sol`, transcript at
`scratchpad/codex-cost-architecture-out.md`) then revealed something more
important: **we were about to optimise a pipeline that does not yet deliver the
reliability guarantees it claims.**

Every finding below was independently verified against code or run artifacts
before being accepted. Claims that were NOT verified are marked as such.

### Verified state of the system

| Fact | Evidence |
|---|---|
| Benchmark passes 1/10 positive + 1/6 negative | `scratchpad/aurora-fixture-full-smoke9/grade-report.json` |
| An answer with `verification.verified === false` still ships as `DIRECT_ANSWER` | case `Q05-N1` in `engine-results.json` |
| An LLM `IRRELEVANT` verdict alone drops an exception with an UNKNOWN trigger, before deterministic resolution ever sees it | `src/lib/knowledge/applicability/decision-relevance.ts:231` |
| The LLM reranker recovered **zero** additional required rules (recall@5 10/10 with and without it) | independent recomputation, `scratchpad/_rerank_ablation.ts` |
| `findings: []` is schema-valid and yields `hasGap: false`; `AMBIGUOUS` never counts as a gap | `src/lib/knowledge/extraction-coverage-auditor.ts` |
| The audited-extraction pipeline exists **only** in the benchmark; production `run-extraction.ts` still sends whole documents | grep: only caller is `scripts/run-aurora-fixture.ts` |
| No `cache_control` anywhere; large system prompts are re-sent on every call | `src/lib/ai/chat-provider.ts` |
| Focused repair discards a retry unit whose quote overlaps an existing quote — a better reading of the same span is thrown away | `src/lib/knowledge/audited-extraction.ts:122` |

**Caveat on the pass rate:** `full-smoke9` predates the Decision Relevance Gate
and the trigger-fact prompt fix. It is stale. But every run since then failed,
so there is *no current measurement at all*. Both readings forbid blind
optimisation.

### Measured cost of one benchmark run (15 blocks, 16 questions, 1 extraction round)

| Stage | Calls | Share |
|---|---:|---:|
| coverage audit (1 per block) | 15 | 27% |
| QueryFrame (1 per question) | 16 | 29% |
| reranker (1 per question) | 16 | 29% |
| extraction batches | 4 | 7% |
| synthesis (only 4/16 reached ANSWER) | 4 | 7% |
| focused re-extraction | 1 | 2% |
| **total** | **56** | |

Note this is **debug cost, not production unit economics** — the full pipeline
is not production-wired.

## Principles for this plan

1. **Cheap debugging first.** Anything that makes an iteration cheaper without
   touching a guarantee comes before anything that trades quality for money.
2. **Never buy cost with reliability.** The owner's stated order is: reliable
   extraction, reliable answers, *then* cheap.
3. **No heuristic ships unmeasured.** The "audit only suspicious blocks" idea
   was killed by data (the one real gap was statistically indistinguishable from
   healthy blocks). Same bar applies to every future shortcut.
4. **Every diff gets an independent cross-review** before merge (`gpt-5.6-sol`,
   read-only). Reviewer claims are verified against code before being accepted —
   the reviewer is wrong sometimes too.

## Work order

Derived from the cross-audit's recommended sequence, with file ownership chosen
so parallel agents never touch the same file.

### Wave 1 — parallel, non-overlapping files

| # | Work | Sole file owner |
|---|---|---|
| W1-A | `--reuse-extraction` / `--fresh-extraction` modes + fingerprinted artifact cache. Also: `DIRECT_ANSWER` must require `verification.verified` | `scripts/run-aurora-fixture.ts` |
| W1-B | Prompt caching (`cache_control`) for the large repeated system prompts | `src/lib/ai/chat-provider.ts` |
| W1-C | Coverage auditor fails **closed**: empty `findings` is not "no gap"; `AMBIGUOUS` blocks publication | `src/lib/knowledge/extraction-coverage-auditor.ts` |
| W1-D | An LLM `IRRELEVANT` verdict may no longer be the sole authority to drop an exception whose trigger is UNKNOWN | `src/lib/knowledge/applicability/decision-relevance.ts` |

W1-A unlocks cheap iteration for everything after it. W1-C and W1-D close
guarantee holes and will *increase* call counts slightly — that is correct and
expected.

### Wave 2 — after Wave 1 lands

- Embedding cache (candidate + query embeddings, keyed by model + content hash)
- Stage-local retry instead of re-running a whole question (currently a
  transient synthesis failure re-pays for QueryFrame and retrieval up to 3×)
- Provider Batch API (50% discount) for offline extraction/audit
- Per-stage `maxTokens` (most stages silently inherit 2048; only extraction sets 16k)

### Wave 3 — needs measurement infrastructure first

- **Reranker removal.** Verified to add nothing on one stale run. Re-ablate on
  frozen artifacts (needs W1-A) across several extraction seeds before deleting.
- **Auditor batching** (15 calls → ~3 batches of 5). Only after a seeded-omission
  harness exists: delete known units from good extractions, measure omission
  recall per batch size. Do not assume a single 15-block call is safe — the same
  failure class silently dropped rules 5–10 from a whole-document extraction.
- **Dependency-driven conditional query analysis.** Replaces the rejected
  "classify the question as ordinary" idea: let the *retrieved rules'*
  dependencies decide whether QueryFrame is needed, not the question's wording.

### Explicitly rejected

- "Audit only suspicious blocks" — refuted by data.
- "Cheap path for ordinary-looking questions" — an ordinary-looking question can
  be decided by an exception; complexity must come from retrieved rule
  dependencies, not question wording.

## Definition of done for every task here

1. RED test first, confirmed failing for the right reason.
2. Minimal implementation, GREEN.
3. `npx tsc --noEmit -p .` clean.
4. `npx vitest run` — full suite green. (Known transient: the `oracle-taint.test.ts`
   `beforeAll` cold-start timeout; re-run that file alone to confirm.)
5. `npx eslint <touched files>` clean.
6. Independent cross-review of the diff; findings verified before being applied.
7. Commit with reasoning in the message.

## Standing constraint

No paid benchmark run without printing an estimated ceiling beforehand and real
per-stage cost afterwards (`--max-cost-usd` is mandatory and has no default).
