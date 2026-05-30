# Answer Engine Robustness — Design

Date: 2026-05-29
Status: approved (incremental build)

## Why

After fixing P1–P8 (+ СОБ/СОС) on the answering engine, we need **structural** safeguards
so the same classes of problem don't return — both **at answer time** and **when new
documents are uploaded**. Root weaknesses observed this session:

- No automated regression check → a 2-hour debugging detour that a 30-second eval would
  have prevented.
- Abbreviations handled by brittle hardcoded regexes (`СО[РБС]`).
- New documents are committed **without** a `scenarioKey` (verified: the upload/commit
  pipeline never sets it) → either invisible to the scenario filter or blended into the
  wrong scenario until a manual backfill is remembered.
- "Sources" shown to the user are ranked separately from the chunks the answer is built
  from → cosmetic mismatches (P1/P2 residual).

## Components (built incrementally, #1 first)

### 1. Golden eval harness — `scripts/eval/` (FOUNDATION)
- `cases.json`: ~16–30 domain-editable cases. Each: `q` + `expect` with optional fields
  `scenarioKey`, `source` (`knowledge_base|general_ai|deterministic_guardrail|none`),
  `clarify` (bool), `mustInclude[]`, `mustNotInclude[]`, `level`.
- `run.ts`: runs each `q` through `answerQuestionEnhanced` (temp=0), asserts **structurally**
  on the result fields + answer substrings — no LLM judge, deterministic, cheap. Prints
  per-case PASS/FAIL + `N/M` summary; exits non-zero on any failure (CI + post-ingest gate).
- Assert only **stable** facts (verbatim addresses/numbers from chunks, source type,
  scenario) — never LLM phrasing. Omit flaky fields for LLM-routed cases.
- Run: `railway run npx tsx scripts/eval/run.ts`.

### 2. Abbreviation glossary — `src/lib/knowledge/glossary.ts`
- Data constant: `СОР→свидетельство о рождении`, `КЗАГС→Комитет по делам ЗАГС СПб`,
  `НКО→нотариальная копия`, `СОБ/СОС/СОН`, … `expandAbbreviations(text)` **appends** the
  expansion (keeps original for keyword search). Applied before scenario classification
  and in extraction. Replaces brittle `СО[РБС]` regexes with data. (DB + admin UI = later.)

### 3. Upload-time safeguards — `src/lib/document-processing/commit.ts`
- **3a Scenario auto-tag:** at commit, classify the document into a scenario and set
  `scenarioKey` on its chunks/rules. Low confidence / no match → leave `null` + flag the
  document "needs scenario review" + notify admin.
- **3b Quality gate:** before rules go ACTIVE — programmatic checks (banned filler phrases,
  length bounds, "every address/number/price appears in the source chunk" anti-hallucination,
  no placeholder text). Failures block or flag.

### 4. Provenance-linked citations — engine
- Build "📚 Источники" from the chunks actually placed in the synthesis prompt
  (`contextChunks` → their documents/rules), not the separately-ranked `rules` query.
  Sources always match the answer.

## Principles
Deterministic eval (no LLM judge); glossary as data not regex; guard at the input not after;
citations from the answer's real sources. YAGNI: no DB glossary / admin UI on day one.

## Verification
Every component is verified by the eval harness (#1). Each ships as its own commit/PR;
the eval must stay green.
