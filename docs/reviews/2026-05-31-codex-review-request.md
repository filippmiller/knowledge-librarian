# Codex Review Request — Knowledge Librarian answering engine + self-improving loop

**Date**: 2026-05-31
**Reviewer target**: Codex (critical/adversarial review)
**Repo**: `C:\dev\translation` (Knowledge Librarian — Avrora translation bot)
**Scope**: everything merged to `master` between commit `6ffeb1a` and `061b06c` (PR #1–#7)
**Production**: https://avrora-library-production.up.railway.app — Railway deploy `98a2cf44` (SUCCESS), serving `master` `061b06c`

---

## YOUR JOB

Do a **critical, adversarial review** of the work described below. We built a lot
across one long session and want a second pair of eyes to find **what we missed**.
We are NOT looking for praise — we want gaps, bugs, race conditions, security holes,
and design smells. Assume we were moving fast.

For each finding, give: **severity (P0/P1/P2/P3)**, **file:line**, **why it's wrong**,
**concrete fix**. Prefer a hard veto on one real bug over ten style nits.

### Specific questions we want answered
1. **Self-improving loop safety** — can the `general_ai` → draft → approve path
   ever auto-save an unverified answer WITHOUT a human tap? Trace every caller of
   `approveKnowledgeGap`. Is the super-admin gate enforced on BOTH the Telegram
   callback path AND the web PATCH path?
2. **Recall correctness** — Step 5 (rules) and Step 6 (qaPairs) in
   `enhanced-answering-engine.ts` use a per-term keyword prefilter + a recent-N
   fallback. Does the prefilter ever DROP a freshly-approved QAPair that should
   match? Is the dedup-by-id correct? Are `take:` caps hiding relevant rows?
3. **Scenario gate false-negatives/positives** — `scenario-classifier.ts` uses
   Russian regexes. We hit `\w` not matching Cyrillic before. Grep for any remaining
   `\w` used against Russian text. Check the destination-country detector's negative
   lookahead and the `[а-я]*` patterns for over/under-matching.
4. **Consistency gate** — `verifyAnswer` strips hallucinated claims against
   chunks+rules+QA. Can it strip a CORRECT claim that happens to be phrased
   differently from the source? Can it pass a wrong claim?
5. **Dedup races** — `createKnowledgeGapSuggestion` dedups by exact question among
   OPEN gaps. Two near-simultaneous low-trust answers to the same question — double
   draft? `approveKnowledgeGap` checks `status !== 'OPEN'` — is that check atomic
   against a double-approve (two admins tap at once)?
6. **Confidence formula** — `confidence = bestSemanticScore + coverageScore*0.1`.
   Is this honest? Can it exceed 1.0? Can a high-coverage/low-relevance answer get
   falsely high confidence?
7. **Migration safety** — `QAPair.metadata Json?` was added via raw
   `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` because `prisma db push` wanted to DROP
   `DocumentRevision` (schema drift). Is the schema now consistent with the DB? Is
   there latent drift that will bite the next `db push`?

---

## WHAT WE BUILT (chronological, by PR)

### PR #1 `6ffeb1a` — semantic source attribution (P2) + always-escalate general_ai (P3)
- `answerSource` now reflects the REAL origin (knowledge_base / general_ai /
  deterministic_guardrail). Previously mislabeled.
- Any `general_ai` answer always escalates to super-admin review.

### PR #2 `07e4931` — recognize СОБ/СОС ЗАГС abbreviations (not just СОР)
- `scenario-classifier.ts` / glossary: handle `СО[РБС]` family (свидетельство о
  рождении/браке/смерти).

### PR #3 `e3af4f5` — answer-engine tech debt
- Honest confidence scoring, better primary-source selection, `general_ai` gets
  proper context.

### PR #4 `76c456a` — answer-engine robustness (4 sub-parts)
- `#1` golden **eval harness** — `scripts/eval/run.ts` + `cases.json` (18 cases,
  deterministic, no LLM judge). This is the regression gate.
- `#2` **abbreviation glossary** — `src/lib/knowledge/glossary.ts`, data-driven
  `expandAbbreviations()`.
- `#3b` **quality gate on extracted rules at commit** —
  `src/lib/document-processing/extraction-lint.ts` + `commit.ts`.
- `#4` **provenance-filter rule citations** — only cite rules actually used.

### PR #5 `adaf347` — answer-quality v2
- Consistency gate verifies against chunks+rules+QA.
- "General requirement" routing (e.g. lamination / юрлицо questions).
- Recall fixes.

### PR #6 `c8302a2` — country-destination routing
- "апостиль для/в <country>" → `knowledge_lookup` (KB), NOT a doc-type clarification
  loop. (Fixes the "Апостиль для Китая" infinite-clarification bug from the screenshot.)

### PR #7 `061b06c` — **self-improving knowledge loop** (the big one, 8 tasks)
See `docs/plans/2026-05-30-knowledge-feedback-loop.md` for the full plan.
- `src/lib/ai/knowledge-feedback.ts` (NEW) — `isLowTrust()`,
  `createKnowledgeGapSuggestion()`, `approveKnowledgeGap()`, `rejectKnowledgeGap()`.
- `src/lib/telegram/ai-escalation.ts` — hook at top of
  `escalateUnconvincingAIAnswer`: low-trust → create draft → send super-admins
  inline ✅/✖️ buttons (`sendKnowledgeGapForApproval`).
- `src/lib/telegram/knowledge-gap-callback.ts` (NEW) — handles `kg:approve|reject:<id>`,
  super-admin gate.
- `src/lib/telegram/message-router.ts` — routes `kg:` callbacks.
- `src/app/api/ai-questions/[id]/route.ts` — PATCH actions approve/reject.
- `src/app/admin/ai-questions/page.tsx` — web review UI: edit draft answer, approve/reject.
- `prisma/schema.prisma` — `QAPair.metadata Json?` (provenance).
- `scripts/eval/run.ts` + `cases.json` — extended.

---

## ARCHITECTURE (how an answer is produced)

```
question
   │
   ▼
classifyScenario()  [scenario-classifier.ts]  ── gate BEFORE retrieval
   ├─ scenario_clear     → retrieve within that scenario
   ├─ needs_clarification → ask user (inline buttons sc:<id>)  ← NOT an answer
   ├─ knowledge_lookup   → general retrieval
   └─ out_of_scope       → general_ai or "нет данных"
   │
   ▼
hybrid retrieval (semantic + keyword RRF)
   Step 5: rules (R-XXX)  — per-term prefilter + recent-N fallback
   Step 6: qaPairs        — per-term prefilter + recent-N fallback  ← freshly-approved pairs live here
   │
   ▼
LLM compose answer
   │
   ▼
verifyAnswer()  — consistency gate: strip claims not supported by chunks+rules+QA
   │
   ▼
confidence = bestSemanticScore + coverageScore*0.1
   │
   ├─ low-trust? (general_ai | low | insufficient, and NOT a clarification)
   │     └─ escalateUnconvincingAIAnswer()
   │            └─ createKnowledgeGapSuggestion() → AIQuestion(knowledge_gap, OPEN, context.draft)
   │                   └─ send super-admins ✅/✖️ buttons  (kg:approve:<id> / kg:reject:<id>)
   ▼
return EnhancedAnswerResult
```

### The self-improving loop (approval → write-back)
```
super-admin taps ✅  (Telegram kg:approve:<id>)  OR  web /admin/ai-questions PATCH {action:'approve'}
   │
   ▼
approveKnowledgeGap(id, {answer?, scenarioKey?, approvedBy})
   ├─ guard: AIQuestion.issueType === 'knowledge_gap'
   ├─ guard: AIQuestion.status === 'OPEN'   (else throw 'already resolved')
   ├─ create QAPair {question, answer, status:ACTIVE, scenarioKey,
   │                 metadata:{origin:'ai-suggested', approvedBy, approvedAt, fromAIQuestion}}
   └─ AIQuestion → ANSWERED
   │
   ▼
next identical question → Step 6 retrieves the new ACTIVE QAPair → answerSource = knowledge_base
```

**VERIFIED on live prod**: synthetic `kg:approve` callback created a QAPair
(origin=ai-suggested, ACTIVE), AIQuestion flipped to ANSWERED. E2E locally proved
the loop closes (approve → re-ask → knowledge_base). Eval 18/18 green.

---

## KEY FILES TO REVIEW

| File | Why it matters | Review focus |
|------|----------------|--------------|
| `src/lib/ai/enhanced-answering-engine.ts` | the core (~207 lines changed) | Step 5/6 recall, confidence formula, verifyAnswer |
| `src/lib/ai/knowledge-feedback.ts` | the loop's write-back | dedup race, approve atomicity, isLowTrust logic |
| `src/lib/knowledge/scenario-classifier.ts` | the gate | Cyrillic regexes, country detector, over/under-match |
| `src/lib/knowledge/glossary.ts` | abbreviation expansion | СО[РБС], completeness |
| `src/lib/telegram/ai-escalation.ts` | trigger + notify | the early-return hook, throttle interaction |
| `src/lib/telegram/knowledge-gap-callback.ts` | TG approve path | super-admin gate, id parsing |
| `src/app/api/ai-questions/[id]/route.ts` | web approve path | auth gate parity with TG |
| `src/app/admin/ai-questions/page.tsx` | web review UI | XSS on draft answer, action wiring |
| `src/lib/document-processing/extraction-lint.ts` + `commit.ts` | ingest quality gate | does a bad rule slip through? |
| `prisma/schema.prisma` | QAPair.metadata | drift vs live DB |

---

## KNOWN OPEN ITEMS (do NOT re-report these — we know)
- **P9 content gaps** (need domain expert, not code): China/Hague (effective 2023-11-07)
  not in KB; МВД two-address contradiction (Красного текстильщика 10-12 vs Литейный 6);
  pricing inconsistency (госпошлина vs full-service price).
- **Schema drift**: `DocumentRevision` exists in DB but not cleanly in schema history —
  flagged, NOT yet reconciled. `db push` is unsafe; use surgical ALTER.
- **No Beads tracking** this session (used plan files + eval instead).

---

## HOW TO RUN THINGS

```bash
# Single question against prod (provenance trace):
railway run npx tsx scripts/ask.ts "как апостилировать СОР"

# Regression eval (must stay green):
railway run npx tsx scripts/eval/run.ts        # or: npx tsx scripts/eval/run.ts

# Deep diagnose one question:
railway run npx tsx scripts/diagnose-answer.ts "<question>"
```

**Output your findings as a prioritized list (P0→P3). For each: file:line, the bug,
the fix. End with a one-line verdict: SHIP / FIX-FIRST / RECONSIDER.**
