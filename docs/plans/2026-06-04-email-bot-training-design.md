# Design — Email-Answering Bot trained on 2026 CRM emails

**Date:** 2026-06-04
**Status:** Approved (brainstorm forks confirmed) — pending implementation plan
**Author:** brainstorm session

## Goal

Enable the existing Knowledge-Librarian bot to **draft replies to incoming client emails**, trained on this company's real 2026 email correspondence (a translation / document-legalization contact center on Bitrix24, portal `aurora-piter`).

## Confirmed decisions (brainstorm)

1. **Operational mode:** *draft-assist* — the bot writes a draft, the **operator reviews and sends**. No autonomous sending at launch. (Auto-send for high-confidence can be enabled later once eval stats justify it.)
2. **Training scope:** **all 2026 emails** — 6,131 incoming + 7,431 outgoing = **13,562** (both directions, all mailboxes). Dedup removes repeats.
3. **Knowledge form:** mine **Q→A pairs + scenarios** into the existing `QAPair` table (+ embeddings via the existing `DocChunk`/pgvector path). NOT fine-tuning.
4. **Languages:** Russian **and** English (clients write in both; sample threads contained English).

## Why RAG-mining, not fine-tuning

The codebase is already a mature RAG engine (`answerQuestionEnhanced`, `prisma/schema.prisma`, pgvector hybrid search, GPT-4o synthesis with an anti-hallucination consistency gate). "Training on emails" here means **feeding mined knowledge into that engine**, because:

- Fine-tuning hallucinates prices/dates/deadlines — unacceptable for legal/translation answers.
- Fine-tuning must be redone whenever the price list or rules change; RAG updates by adding a row.
- Outgoing company emails are a *free labeled teacher*: the operator already wrote the ideal answer.

## Architecture (extends the existing engine, no shadow system)

```
Bitrix CRM (2026 emails)
  │ 1. EXPORT  — deterministic script, no LLM
  ▼  crm.activity.list TYPE_ID=4, >=CREATED 2026-01-01, both directions → JSONL/staging
2. THREAD RECONSTRUCTION — script
  │  group activities by OWNER (Deal/Lead/Contact), sort by CREATED
  │  pair: incoming(client) → next outgoing(operator) = candidate Q→A
  │  (use separate activities + Deal timeline, NOT inline-quote parsing)
3. CLEAN — script: strip quoted history (`you wrote:`, `от …@…:`, date lines),
  │  signatures, and PII (phones/emails/personal names) from stored pairs
4. CLASSIFY — cheap LLM (Haiku), batched: is this a real Q→A worth learning?
  │  → canonical question, canonical answer, scenarioKey, domain, language
5. DEDUP — embed canonical questions, cluster (cosine > ~0.92),
  │  keep representative + frequency count (frequency = priority signal)
6. COMMIT — reuse commit path: QAPair(question, answer, scenarioKey,
  │  metadata={origin:'email-mined', dealId, date, frequency, lang})
  │  + embeddings (text-embedding-3-small, 1536d) → DocChunk/pgvector
  ▼
7. EMAIL-ANSWER LAYER (new thin wrapper over answerQuestionEnhanced)
     incoming email → extract question (strip quotes) → answerQuestionEnhanced
     → confidence gate:
         HIGH      → formatted draft in company style
         MEDIUM    → draft + "проверь факты" flag
         LOW/insuf → escalate, no draft
     → write draft as a Deal timeline comment in Bitrix (operator's normal workflow)
     → operator reviews & sends. NEVER auto-send at launch.
```

## Key design choices

- **Thread reconstruction via Deal timeline, not inline-quote parsing.** Each email is a separate CRM activity with `DIRECTION` and an `OWNER` (Deal). Ordering activities per Deal by time and pairing incoming→next-outgoing is far more robust than regex-splitting the quoted chain inside one body. Script-first, no LLM needed for pairing.
- **Cheap-tier classification.** Haiku (not GPT-4o) decides "is this a learnable Q→A" and extracts the canonical pair. ~13.5k emails → a few $ , not a few hundred.
- **Dedup by semantic similarity with frequency.** Hundreds of "нужен апостиль на диплом?" collapse to one canonical pair whose frequency tells the engine how common (and how safe-to-automate-later) it is.
- **PII stripped at mining time.** We learn *how to answer*, not *who asked*. Aligns with the project's security posture; pairs hold only Q→A meaning.
- **Draft delivered into Bitrix.** Operators see the suggested reply on the Deal where they already work, instead of a separate UI.

## Safety & evaluation

- **Hold-out eval set:** reserve ~200 real 2026 pairs (excluded from training). Bot drafts a reply to the client question; an LLM judge + human compare it to the real operator answer. Metric: **% of drafts sendable without edits** + factual match. **Hard veto** on any wrong price/date/deadline (averages hide critical errors).
- **Confidence honesty:** the engine already returns `confidence` + citations; surface it on every draft so operators trust-but-verify.
- **No auto-send until** the eval set shows a high send-without-edit rate on a scenario; then enable auto only for that scenario class.

## Phases (with cost)

1. **Pilot sample (~1 day, ~$5):** export ~300 of 2026 → ~100–150 pairs → human eyeball quality. Decide: is the mined signal good?
2. **Full 2026 mining (~$10–20):** all 13,562 emails → dedup → QAPair + embeddings in KB.
3. **Email-answer layer + draft-assist:** incoming email → draft with confidence → Bitrix Deal comment.
4. **Eval + automation threshold:** measure quality, decide which scenarios (if any) can go auto later.

## Out of scope (YAGNI for now)

- Autonomous sending.
- Call-recording transcription (separate track; 105,954 recordings via `voximplant.statistic`).
- Worker-to-worker chats (private, excluded).
- A bespoke draft-review UI (use Bitrix Deal timeline first).

## Pilot results (2026-06-04) — validated + refined

Ran `scripts/email-mining/pilot.mjs` (script-only) + `scripts/email-mining/classify.mjs` (gpt-4o-mini) on 400 recent 2026 emails:

- **Quality funnel:** 400 emails → 114 raw pairs (script) → 18 clean canonical pairs (LLM) ≈ **4.5% "gold"**. Extrapolated to full 2026: ~**500–700 clean pairs**. Small but dense core of real answers.
- **Thread reconstruction by Deal timeline works.** Pairing rule hardened: answer = the *immediately next* message only if outgoing (prevents one reply mapping to several questions).
- **Cleaner hardened** to cut Russian date-quote headers ("Четверг, 28 мая 2026 …"), `From:/Кому:/Sent:` blocks, external-server banners, signatures.
- **LLM classifier is mandatory** (confirmed): script alone yields ~20% usable; the cheap classifier filters logistics/acks/broken extraction and canonicalizes Q + A. Full-2026 classify ≈ $3–6.
- Kept-pair topics in sample: payment, price, process, notary.

### CRITICAL refinement — two knowledge layers (prices are NOT facts)

The most "keepable" pairs are **prices/sums** (8809 ₽, 34504 ₽…), but each was computed for a specific order (char count, urgency, notarization). Teaching them verbatim would make the bot quote **wrong prices** — violates single-source-of-truth and is the worst business hallucination. Therefore mine **two layers**:

| Layer | Examples | Use |
|---|---|---|
| **Policy/process** (reusable) | "цена считается по знакам готового перевода", "предоплата 70%", "оплата 9–19", "фин→нем идёт через русский", scan/notary/apostille requirements | ✅ Store as **facts** in KB |
| **Transactional specifics** (one-off) | "this order = 8809 ₽", "ready 02.06" | ⚠️ Use only as **phrasing templates**; the bot must NOT invent numbers |

**Decision (confirmed):** prices/deadlines come from a **live price source** (price list / calculator), never from memorized email numbers. The classifier must split policy vs transactional and strip concrete sums from the factual layer.

## Open items to confirm during planning

- **Price source of truth (NEW, blocking for the price path):** is there an existing price list / calculator / API to wire in? If not, the bot escalates all price/deadline questions to the operator (policy-layer answers still work).

- Exact Bitrix write-back method for the draft (timeline comment vs draft activity vs CRM "open" email draft).
- Trigger for new incoming email (Bitrix outbound webhook `ONCRMACTIVITYADD` vs polling `crm.activity.list`).
- Where mined pairs land relative to existing curated `QAPair`s (tag with `origin:'email-mined'`, keep separable for rollback).
