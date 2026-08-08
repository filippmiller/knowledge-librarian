# Response to external architectural review of PR #76 (commit `cf843d8`)

**Date:** 2026-08-08. **Beads:** translation-yz9 (parent). **Reviewed range:** `cf843d8..6a01b2e` on `feat/canonical-docx-blocks`.

External review verdict on `cf843d8`: **REQUEST CHANGES — DO NOT MERGE**, two P0s + several P1s. This report documents the response, step by step, per the review's explicit 8-step continuation task and required final-report format. Per standing instruction: **no merge, no deploy, no retrieval-answer work performed** — this PR still stops at extraction + oracle-blind review packet.

## Commit SHAs (chronological)

| SHA | Beads | Subject |
|---|---|---|
| `26477bc` | translation-rbj | P0 — invalid `parentExtractionRef` can no longer leak into persisted `parentRuleRef` |
| `2e10aa8` | translation-yz9 | Design note — split immutable reviewed snapshot from extraction-drift gate |
| `7de4582` | translation-bqt | P0 — split reviewed snapshot (Gate 1) from extraction-drift gate (Gate 2) |
| `b570bd3` | translation-n6m | P1 — `sourceBlockAnchor` now discriminates by `structuralPath`, not `sectionPath` |
| `9ff02f6` | translation-jgm | P1 — machine-enforce oracle isolation for `scripts/run-extraction.ts` |
| `011ff33` | translation-kod | P1 — `review-packet.json` now exposes full `reviewedUnitHash` inputs |
| `3ad7bb5` | translation-0q7 | P1 — `compareExtractionRuns` no longer drops duplicate `unitId` silently |
| `d73a0ce` | translation-4hc | P2 — diagnose and fix flaky `oracle-taint.test.ts` |
| `6a01b2e` | translation-z2c | P1 — CI `pull_request` trigger never matched stacked PRs |

Final SHA: **`6a01b2e27a80a7d2e14385cb092a44d4104064df`**.

## Changed files (`cf843d8..6a01b2e`, excludes `.beads/`)

19 files, +1527/-112:

```
.github/workflows/ci.yml
docs/plans/2026-08-08-reviewed-snapshot-vs-drift-gate-design.md
scripts/__tests__/run-extraction-review-packet.test.ts
scripts/run-extraction.ts
src/lib/eval/__tests__/extraction-drift.test.ts
src/lib/eval/__tests__/oracle-isolation.test.ts
src/lib/eval/__tests__/oracle-taint.test.ts
src/lib/eval/__tests__/reviewed-snapshot.test.ts
src/lib/eval/extraction-drift.ts
src/lib/eval/reviewed-snapshot.ts
src/lib/knowledge/__tests__/docx-canonical-blocks.test.ts
src/lib/knowledge/__tests__/knowledge-unit-extractor.test.ts
src/lib/knowledge/applicability/__tests__/extraction-parent-refs.test.ts
src/lib/knowledge/applicability/__tests__/identity-assignment.test.ts
src/lib/knowledge/applicability/extraction-parent-refs.ts
src/lib/knowledge/applicability/identity-assignment.ts
src/lib/knowledge/applicability/identity.ts
src/lib/knowledge/docx-canonical-blocks.ts
vitest.config.mts
```

## Test counts

- Start of this response (after `cf843d8`): 59 files / 1208 tests.
- End of this response (`6a01b2e`): **62 files / 1260 tests**, all green.
- `tsc --noEmit`: clean. `eslint`: clean. `git diff --check`: clean. NUL-byte sweep: 0 bytes on every touched file, every write.

## Step-by-step response

### Step 1 (P0) — parent-relationship persistence leak

**Defect:** `validateParentRefs()` flagged self-reference/cycle/duplicate-target `parentExtractionRef` with a `DANGLING_PARENT_REF` uncertainty but left the field itself untouched; `assignIdentity()` then resolved it anyway via `extractionRef -> unitId`, so invalid relationships (self-reference, 2-cycles, ambiguous duplicate targets) could persist as real `parentRuleRef` links — a direct violation of "UNKNOWN/AMBIGUOUS/INVALID must never silently become MATCH."

**Fix, two independent layers** (`src/lib/knowledge/applicability/extraction-parent-refs.ts`, `identity-assignment.ts`):
- `validateParentRefs()` now **nulls** `parentExtractionRef` for all four invalid cases (self, cycle, nonexistent, duplicate-target), keeping the raw value only in the uncertainty description.
- `assignIdentity()`'s `toPersistedUnit()` independently guards against self-reference and duplicate-`extractionRef` targets via `safeUnitIdByExtractionRef()` (excludes any `extractionRef` claimed by >1 unit from the resolution map entirely) — defense-in-depth, since `assignIdentity` is exported with no type-level guarantee its caller validated first.

**Parent invalidity proof:** `identity-assignment.test.ts`, describe block "защита от невалидных parentExtractionRef ДАЖЕ БЕЗ validateParentRefs" — feeds `assignIdentity` raw, unvalidated data directly (duplicate-`extractionRef` scenario tested with both input orders; self-reference scenario). Mutation-tested: disabling each guard independently is caught by exactly its own dedicated test, confirming two real, non-redundant layers, not duplicated logic.

### Step 2 (P0) — reviewed snapshot vs. extraction-drift gate split

**Defect:** `applyReviewManifest()` is one all-or-nothing function conflating two different questions ("does retrieval/applicability work?" vs. "is LLM extraction stable between runs?"). Two real runs on the same DOCX, same config (`.claude/audits/2026-08-08-extraction-stability-fragmentation-report.md`) showed 10/36 contentHash drift, 5/2 unitId-only-in-one-run — meaning a committed review manifest would almost certainly fail `applyReviewManifest()` on the very next extraction run, for reasons unrelated to retrieval correctness.

**Design note first** (`docs/plans/2026-08-08-reviewed-snapshot-vs-drift-gate-design.md`), then implementation:
- **Gate 1** (`src/lib/eval/reviewed-snapshot.ts`, `buildReviewedSnapshot()`) — thin wrapper over `applyReviewManifest()`, **semantics unchanged**: all-or-nothing, oracle-blind, never auto-accepts. Materializes `confirmed` units into an immutable `ReviewedKnowledgeSnapshot` with provenance (`sourceRevisionHash`/`parserVersion`/extraction provider-model-promptVersion-schemaVersion/`qualifiedAt`). `sourceRuleId` returned as a **separate** `sourceRuleByUnitId` map, never inside `snapshot.units`.
- **Gate 2** (`src/lib/eval/extraction-drift.ts`, `compareExtractionRuns()`) — purely diagnostic, **never blocks**. Classifies every `unitId` as STABLE/CONTENT_CHANGE/CONTENT_OMISSION/CONTENT_ADDITION, with PARENT_DRIFT/TRIGGER_DRIFT/UNCERTAINTY_DRIFT sub-flags and FRAGMENTATION_CHANGE grouping (omission+addition on the same `sourceBlockAnchor`). Zero LLM calls, zero semantic-equivalence guessing — confirmed by reading the file (no AI-provider imports).

**New reviewed-snapshot contract:**
```ts
interface ReviewedKnowledgeSnapshot {
  sourceRevisionHash: string; parserVersion: string;
  extractionProvider: string; extractionModel: string;
  extractionPromptVersion: string; extractionSchemaVersion: string;
  qualifiedAt: string;
  units: readonly PersistedKnowledgeUnit[]; // the ONLY trusted engine input
}
```

**New extraction-drift contract:**
```ts
type UnitDriftStatus = 'STABLE' | 'CONTENT_CHANGE' | 'CONTENT_OMISSION'
  | 'CONTENT_ADDITION' | 'AMBIGUOUS_DUPLICATE_UNIT_ID'; // added Step 6
interface ExtractionDriftReport {
  stableCount; contentChangedCount; omittedCount; addedCount; ambiguousDuplicateCount;
  entries: readonly UnitDriftEntry[]; // { unitId, status, sourceBlockAnchor, detail }
  fragmentationChanges: readonly FragmentationChangeGroup[];
}
function compareExtractionRuns(baseline, candidate): ExtractionDriftReport; // pure, never throws
```

### Step 3 (P1) — source identity missing `structuralPath`

**Defect:** `computeSourceBlockAnchor(sourceRevisionHash, sectionPath, blockStart, blockEnd)` used `sectionPath` (heading breadcrumb), not structural position. Since `sourceRevisionHash` deliberately depends only on `canonicalText`, a document restructuring that preserves visible text (paragraph → table cell) could leave `sourceRevisionHash`/`sectionPath`/offsets all identical while the real structural position changed — a genuine anchor collision.

**Source-identity proof:** real, reproduced collision. Two synthetic DOCX (`docx-canonical-blocks.test.ts`) — a bare paragraph vs. the identical text inside a 1×1 table cell — produce identical `sourceRevisionHash`, `sectionPath` (both empty), `blockStart`/`blockEnd`, but different `kind` (`PARAGRAPH` vs `TABLE_CELL`) and `structuralPath` (`body/p[0]` vs `body/tbl[0]/tr[0]/tc[0]/p[0]`). **Before the fix**, `computeSourceBlockAnchor` on both gave the identical hash `55fcd5930d246257`. **After the fix** (signature now takes `structuralPath`, not `sectionPath`; `sectionPath` demoted to semantic-only metadata on `SourceBlockLocation`), the anchors differ. A second RED test at the `assignIdentity()` level (not just the pure hash function) confirmed the actual pipeline wiring was fixed too — mutation-tested by reverting `identity-assignment.ts` to `block.sectionPath` and confirming exactly that one test catches it (was previously uncovered).

### Step 4 (P1) — oracle isolation for the extraction runner was convention-only

**Defect:** `oracle-isolation.test.ts` scans all of `src/` but `scripts/run-extraction.ts` lives outside `src/`, so its oracle-blindness (stated in its own docstring) was never machine-checked.

**Fix:** extended `oracle-isolation.test.ts` (same file, same policy constants — not duplicated) with a new gate over an **explicit, minimal allowlist**, `ORACLE_BLIND_SCRIPTS = ['scripts/run-extraction.ts']` — deliberately not a broad `scripts/**` scan, since `scripts/` holds dozens of unrelated scripts and the grader/e2e runner (`run-eval-corpus.ts`, `test-extraction-pack.ts`) is intentionally exempt (oracle access is its job). Three checks: no `lib/eval` import (static/dynamic/`import x = require`), no oracle filename literal, no hardcoded training-DOCX filename. Mutation-tested on the real file (inject violation → confirm the right test catches it → restore byte-identical).

### Step 5 — review-packet field audit

**Gap found:** `reviewedUnitHash` (`review-manifest.ts`) hashes the **entire** `PersistedKnowledgeUnit`, but `review-packet.json` only showed `evidenceQuote` (== `sourceSpan.quote`, covers `statement` only) and `blockText` whole — no `offsets`, no per-field `evidenceByField` (facets/triggerCondition/numericConstraint evidence), no canonical source hashes at the packet's top level. A reviewer could approve structure they hadn't fully seen.

**Fix:** `buildReviewPacket()` exported, now takes a `canonicalSource` parameter (surfaced at the packet's top level) and adds `offsets` (absolute, via `resolveEvidenceOffsets` + `block.blockStart` — reused, not reimplemented) and `evidenceByField` per unit. `vitest.config.mts` extended to include `scripts/**/*.test.ts` (previously untested entirely). Confirmed **zero** oracle-derived fields (`sourceRuleId`) anywhere in the packet, both by direct test and by the Step 4 gate.

### Step 6 — `compareExtractionRuns` cross-check against the review's exact spec

Cross-checked against every explicitly requested dimension (unitId intersection/onlyA/onlyB, stable/changed contentHash, parent/trigger/uncertainty changes, semantic-coverage candidates by source block via `fragmentationChanges`, no LLM-based semantic guessing) — all present. One real gap found during the audit: `baselineById`/`candidateById` were built via plain `new Map(arr.map(u => [u.unitId, u]))` — the exact same last-write-wins class of bug as Step 1 (translation-rbj). A duplicate `unitId` on either side would silently vanish from the report instead of being flagged, contradicting the review's explicit "ambiguous cases should report UNKNOWN/REVIEW_REQUIRED rather than guessing." Fixed with `safeUnitByUnitId()` (same pattern as `safeUnitIdByExtractionRef`) and a new `AMBIGUOUS_DUPLICATE_UNIT_ID` status. Mutation-tested.

### Step 7 — flaky test: diagnosed and reproduced, not just "green now"

**Test:** `src/lib/eval/__tests__/oracle-taint.test.ts` > "словарь «только-oracle» непустой — иначе проверка ничего не стережёт".

**Root cause, measured, not guessed:** the `describe('на реальном пакете')` block called a `realDetector()` helper that fully re-parsed the real training DOCX (`mammoth.extractRawText`) and re-read the real oracle JSONL (`fs.readFileSync`) from scratch inside **every** `it()` — 4 tests, 6 total disk reads per file run, zero caching. Measured with `--reporter=verbose`:
- Isolated file run: first invocation **1115ms**.
- Full-suite parallel run: first invocation **2521ms** — already half of vitest's default 5000ms `testTimeout`.

This is **not a race on shared state** — the result is always correct once the test completes. It is resource contention (disk I/O + dynamic-`import()` module-loading cold start) under parallel worker load, eating into a fixed per-test timeout budget.

**Exact disposition:** fixed, not worked around. Moved the one-time load into `beforeAll` (verified empirically that vitest's default `hookTimeout` is materially larger than `testTimeout` — a throwaway 6-second `beforeAll` probe passed cleanly, deleted after confirming). Post-fix, the same 4 tests under full-suite parallel load: **12ms / 5ms / 5ms / 5ms** (previously 2521/553/387/394ms). Timeout risk for this test is eliminated, not merely reduced.

### Step 8 — CI status on the final SHA + PR body

**Investigated why PR #76 had zero Actions runs:** confirmed via `gh run list --branch feat/canonical-docx-blocks` — empty, for the entire session, while the base branch `feat/semantic-retrieval` (PR #75, base `master`) had 10+ successful runs. Root cause: `.github/workflows/ci.yml`'s `pull_request` trigger was filtered to `branches: [master]`; PR #76's base is `feat/semantic-retrieval`, not `master` — a stacked PR structurally never matches that filter, regardless of code quality. Not a disabled gate, not a failure being hidden.

**Fix:** removed the `branches: [master]` filter under `pull_request:` (kept on `push:`, unchanged — that governs post-merge trunk validation, a separate concern). Safe: the job is entirely read-only/build-only (checkout, install, `prisma validate`, lint, typecheck, test, build) with dummy CI-only env vars, zero deploy steps.

**CI URL/status on final SHA:** <https://github.com/filippmiller/knowledge-librarian/actions/runs/31266130421> — **first-ever Actions run on this branch**, `conclusion: success`, ran against `headSha: 6a01b2e27a80a7d2e14385cb092a44d4104064df` (this PR's current HEAD). Pre-existing ESLint warnings surfaced in the annotations (unused-var style, unrelated files across the wider codebase) — none in files touched by this response, none failing the job.

**PR #76 body:** updated (was stale, claiming completed work as "still to come" — canonical DOCX v2, the runner, the real runs, and the review packet were all already done). New body reflects actual state: what's done, what this review-response covered per beads ID, CI status, and remaining test-plan items.

## Blockers before human review

None from this session's side. The extraction pipeline (`--stage=extraction`) is ready to produce a `review-packet.json` for oracle-blind human review. The reviewer must be someone who has not seen `test_cases_semantic_rules.jsonl` / `kontrolnye_voprosy_i_klyuch.md` / `negative_case_applicability_oracle.jsonl` — this session (and the one that built the grader before it) is permanently disqualified as an oracle-blind reviewer.

## Blockers before retrieval-answer

- **No `ReviewedKnowledgeSnapshot` exists yet** — `buildReviewedSnapshot()` is implemented and tested but has no CLI entry point (a future `--stage=qualify` runner, explicitly out of scope for this session per the design note). Retrieval/applicability/synthesis must not run against `--stage=extraction` output directly; they must read a materialized, human-qualified snapshot.
- **Incremental re-review is unimplemented** (explicitly deferred in the design note) — today, any drift since the last `ReviewedKnowledgeSnapshot` requires a full re-review, not a point re-review of just the `CONTENT_ADDITION`/`CONTENT_CHANGE` units. Not a blocker for a first snapshot, but will be for iteration.
- **`compareExtractionRuns()` has no CLI wiring** — it exists and is tested but nothing calls it as part of `run-extraction.ts` yet; drift monitoring is not yet part of the actual workflow, only available as a library function.
- Per standing instruction: **retrieval, applicability, synthesis, and any human review decision remain explicitly out of scope** and were not started.
