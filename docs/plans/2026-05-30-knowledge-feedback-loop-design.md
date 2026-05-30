# Self-Improving Knowledge Loop — Design

Date: 2026-05-30
Status: approved

## Why

When the bot is uncertain it answers from general AI knowledge (🔴 `general_ai`)
or says "нет данных". Today that gap is escalated to admins as a notification
but nothing is captured back. This feature closes the loop: an uncertain answer
becomes a **draft Q→A pair** that an admin approves (or edits / rejects), and on
approval is saved to the KB — so the next identical question is answered from the
base. Turns gaps into growth, with a human gate so unverified AI facts never
auto-enter the KB.

Most infrastructure already exists: `general_ai` answers, `escalateUnconvincingAIAnswer`,
the `AIQuestion` model (with `proposedChange` / `affectedRuleId` / `status`),
the `/admin/ai-questions` page, and `domain-suggestions` as a working
"AI suggests → admin approves" precedent. This feature WIRES these together.

## A. Trigger (answer time, fire-and-forget after responding to the user)

In the API/Telegram answer paths, after the user has their answer, create a
draft suggestion when the answer is low-trust:
- `answerSource === 'general_ai'` OR `confidenceLevel ∈ {low, insufficient}`
  → draft answer = the answer already produced.
- out_of_scope "нет данных" but a bureau topic → generate a candidate answer
  from general knowledge (reuse `answerFromGeneralKnowledgeFallback` logic) so
  there is something to approve.
- Draft = `{ question (as asked), answer (candidate), scenarioKey (from
  classifyScenario), origin: 'general_ai' }`.

## B. Storage — reuse `AIQuestion`

`issueType: 'knowledge_gap'`, draft stored in `context.draft = { question,
answer, scenarioKey }`, `status: OPEN`. Dedup: the existing escalation throttle
+ skip if an OPEN `knowledge_gap` already exists for the same normalized
question. No new table.

## C. Review — Telegram + web

- **Telegram:** the escalation message to super-admins gains inline buttons
  **✅ Утвердить · ✏️ Поправить (link to web) · ✖️ Отклонить**, routed through the
  existing callback handler (a new `kg:` prefix alongside `sc:`).
- **Web `/admin/ai-questions`:** render the draft Q→A editable, with Approve /
  Save-edited / Reject. Page + API already exist; extend them.

## D. On Approve — write-back

- Create an ACTIVE `QAPair { question, answer (possibly edited), scenarioKey,
  status: ACTIVE, confidence: 1.0 }`, provenance `{ origin: 'ai-suggested',
  approvedBy, approvedAt }`.
- Set the `AIQuestion` → `ANSWERED`.
- The new QAPair is immediately retrievable (engine Step 6 fetches qaPairs),
  so the next identical question is answered from the base. Loop closed.
- Rule creation is deferred (YAGNI): start with QAPair = the user's "пара
  вопрос-ответ".

## E. Safety

- Drafts are NEVER auto-saved — human gate always (the source was unverified AI
  knowledge and can be wrong, e.g. a Hague-convention date).
- Approved items are marked `ai-suggested` for auditability.
- The user still gets the immediate 🔴-labelled answer; approval is async.

## F. Verification

Eval gains a case proving the loop: approve a draft for a known gap (e.g. China)
→ that question then answers from the base. The existing escalation throttle
prevents spam.

## Decisions (approved)

- Artifact on approve = **QAPair** (not Rule, for now).
- Storage = **existing `AIQuestion`** (no new table).
- Review surface = **Telegram buttons + web page**.
- Triggers = general_ai + low/insufficient + out_of_scope-bureau-topic (NOT /report).
