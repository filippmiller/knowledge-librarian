# Self-Improving Knowledge Loop — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Turn every low-trust bot answer into a draft Q→A pair an admin can approve (Telegram or web); on approval it is saved as an ACTIVE `QAPair` so the next identical question is answered from the base.

**Architecture:** A draft builder runs fire-and-forget after answering (alongside the existing `escalateUnconvincingAIAnswer`). Drafts are stored in the existing `AIQuestion` model (`issueType: 'knowledge_gap'`, `context.draft`). Approval (web PATCH or Telegram `kg:` callback) creates an ACTIVE `QAPair` tagged with the scenario and `metadata.origin = 'ai-suggested'`, and flips the `AIQuestion` to `ANSWERED`. Human gate always — nothing auto-saves.

**Tech Stack:** Next.js 16 API routes, Prisma 5 (PostgreSQL on Railway), Telegram Bot API (`sendInlineKeyboard`/`answerCallbackQuery`), the existing answering engine.

**Testing reality (read first):** this project has NO unit-test framework. Verification mechanisms:
- `npx tsc --noEmit` — type gate.
- `railway run npx tsx scripts/eval/run.ts` — golden eval (must stay green).
- One-off `scripts/_*.ts` run via `railway run npx tsx ...` that assert against the prod DB.
- **Integration / live-bot test:** POST a synthetic Telegram update via **Node `fetch`** (NEVER bash `curl` — it corrupts Cyrillic UTF-8 on Windows), then read the resulting rows from the DB. Allowed test user: TestRig id `460980133`, chat id `1` (delivery harmlessly fails, rows are written first).
- Migrations: run yourself — `railway run npx prisma db push` then verify with a SELECT.

---

### Task 1: Schema — add `QAPair.metadata` (provenance) + a QuestionStatus reuse

**Files:**
- Modify: `prisma/schema.prisma` (model `QAPair`)

**Step 1:** In `model QAPair`, add a nullable JSON column for provenance:
```prisma
  metadata    Json?   // { origin: 'ai-suggested', approvedBy, approvedAt }
```
(Place it next to `scenarioKey String?`.)

**Step 2:** Apply + verify:
```bash
railway run npx prisma generate
railway run npx prisma db push
railway run npx tsx -e "import {prisma} from './src/lib/db'; prisma.qAPair.findFirst({select:{metadata:true}}).then(r=>{console.log('metadata column OK', r); process.exit(0)})"
```
Expected: no error, prints `metadata column OK`.

**Step 3: Commit**
```bash
git add prisma/schema.prisma
git commit -m "feat(db): QAPair.metadata for provenance (ai-suggested)"
```

---

### Task 2: Draft builder — `createKnowledgeGapSuggestion`

**Files:**
- Create: `src/lib/ai/knowledge-feedback.ts`
- Test: `scripts/_kf_test.ts` (throwaway)

**Step 1:** Create `src/lib/ai/knowledge-feedback.ts`:
```ts
import prisma from '@/lib/db';
import type { EnhancedAnswerResult } from '@/lib/ai/enhanced-answering-engine';
import { classifyScenario } from '@/lib/knowledge/scenario-classifier';

function normalize(q: string): string {
  return q.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** True when the answer is low-trust and worth capturing as a draft rule. */
export function isLowTrust(result: EnhancedAnswerResult): boolean {
  if (result.scenarioClarification) return false;           // a clarification, not an answer
  if (result.answerSource === 'general_ai') return true;    // answered from general AI knowledge
  if (result.confidenceLevel === 'low' || result.confidenceLevel === 'insufficient') return true;
  return false;
}

/**
 * Fire-and-forget: if the answer is low-trust, store a draft Q→A suggestion in
 * AIQuestion (issueType 'knowledge_gap') for admin approval. Deduped by
 * normalized question. Never throws into the caller.
 */
export async function createKnowledgeGapSuggestion(params: {
  question: string;
  result: EnhancedAnswerResult;
  source: 'WEB' | 'TELEGRAM' | 'API';
  sessionId?: string;
}): Promise<void> {
  try {
    if (!isLowTrust(params.result)) return;

    const norm = normalize(params.question);
    const existing = await prisma.aIQuestion.findFirst({
      where: { issueType: 'knowledge_gap', status: 'OPEN' },
      select: { id: true, context: true },
    });
    // cheap dedup: scan recent OPEN gaps for the same normalized question
    const dupe = await prisma.aIQuestion.findFirst({
      where: { issueType: 'knowledge_gap', status: 'OPEN', question: params.question },
      select: { id: true },
    });
    if (dupe) return;
    void existing;

    // Draft answer: use the answer we already produced. (out_of_scope "нет данных"
    // is confidenceLevel insufficient → isLowTrust true; its answer is the no-data
    // text, which the admin replaces with the real answer on edit.)
    const draftAnswer = params.result.answer;

    let scenarioKey: string | null = null;
    try {
      const d = await classifyScenario(params.question);
      scenarioKey = d.kind === 'scenario_clear' ? d.scenarioKey : null;
    } catch { /* best effort */ }

    await prisma.aIQuestion.create({
      data: {
        issueType: 'knowledge_gap',
        question: params.question,
        status: 'OPEN',
        context: {
          source: params.source,
          sessionId: params.sessionId ?? null,
          answerSource: params.result.answerSource ?? null,
          confidenceLevel: params.result.confidenceLevel,
          draft: { question: params.question, answer: draftAnswer, scenarioKey },
        },
      },
    });
  } catch (e) {
    console.warn('[knowledge-feedback] createKnowledgeGapSuggestion failed:', e);
  }
}
```
(Note: the `normalize`/`existing` dedup is intentionally simple — exact-question match. Refine later if needed.)

**Step 2:** Typecheck: `npx tsc --noEmit` → expect exit 0.

**Step 3:** Verify with a throwaway script `scripts/_kf_test.ts`:
```ts
import { prisma } from '../src/lib/db';
import { createKnowledgeGapSuggestion } from '../src/lib/ai/knowledge-feedback';
async function main() {
  const fake = { answer: 'Тест-ответ из общих знаний', answerSource: 'general_ai', confidenceLevel: 'low',
    needsClarification: false, confidence: 0.4, citations: [], domainsUsed: [],
    queryAnalysis: { originalQuery: 'q', expandedQueries: [], extractedEntities: { dates: [], prices: [], documentTypes: [], services: [] }, isAmbiguous: false } } as any;
  await createKnowledgeGapSuggestion({ question: 'ТЕСТ нужен ли апостиль для Монголии', result: fake, source: 'API' });
  const row = await prisma.aIQuestion.findFirst({ where: { issueType: 'knowledge_gap', question: { contains: 'Монголии' } }, orderBy: { createdAt: 'desc' } });
  console.log('created:', !!row, JSON.stringify(row?.context));
  await prisma.$disconnect();
}
main();
```
Run: `railway run npx tsx scripts/_kf_test.ts` → expect `created: true` with `draft` populated. Then delete the script and the test row.

**Step 4: Commit**
```bash
git add src/lib/ai/knowledge-feedback.ts
git commit -m "feat(ai): knowledge-gap draft builder (low-trust answer -> draft)"
```

---

### Task 3: Wire trigger into the answer paths

**Files:**
- Modify: `src/lib/telegram/ai-escalation.ts` (call site after AIQuestion escalation) OR the two answer handlers `src/app/api/ask/route.ts` and `src/lib/telegram/commands.ts` (handleQuestion).

**Step 1:** `escalateUnconvincingAIAnswer` already runs on the same triggers in all answer paths. In `ai-escalation.ts`, at the end of `escalateUnconvincingAIAnswer`, fire the draft builder:
```ts
import { createKnowledgeGapSuggestion } from '@/lib/ai/knowledge-feedback';
// ... after the existing escalation work:
void createKnowledgeGapSuggestion({
  question: params.question, result: params.result, source: params.source, sessionId: params.sessionId,
});
```
(`escalateUnconvincingAIAnswer` is already invoked from `/api/ask`, telegram `handleQuestion`, voice, and scenario-callback — one hook covers all paths.)

**Step 2:** Typecheck.

**Step 3: Live integration test** — `scripts/_kf_live.ts` POSTs a synthetic Telegram update (Node fetch, proper UTF-8) for a question that triggers general_ai or out_of_scope, then reads the AIQuestion:
```ts
// POST {update with text: 'нужен ли апостиль для Монголии'} to /api/telegram (from id 460980133, chat 1),
// wait 4s, then query AIQuestion issueType='knowledge_gap' question contains 'Монголии' -> expect a row with context.draft.
```
Run via `railway run npx tsx scripts/_kf_live.ts` AFTER deploy (Task 8) — or locally it exercises the same code. Expect a draft row. Delete script + row after.

**Step 4: Commit**
```bash
git add src/lib/telegram/ai-escalation.ts
git commit -m "feat(ai): create knowledge-gap draft on low-trust answers"
```

---

### Task 4: Approve / reject backend (web API)

**Files:**
- Modify: `src/app/api/ai-questions/[id]/route.ts` (PATCH — add `approve`/`reject` actions)
- Create: `src/lib/ai/knowledge-feedback.ts` → add `approveKnowledgeGap(aiQuestionId, {answer?, scenarioKey?, approvedBy})`

**Step 1:** Add to `knowledge-feedback.ts`:
```ts
export async function approveKnowledgeGap(
  id: string,
  opts: { answer?: string; scenarioKey?: string | null; approvedBy: string }
): Promise<{ qaPairId: string }> {
  const aq = await prisma.aIQuestion.findUnique({ where: { id } });
  if (!aq || aq.issueType !== 'knowledge_gap') throw new Error('not a knowledge_gap suggestion');
  const draft = ((aq.context as Record<string, unknown> | null)?.draft ?? {}) as { question?: string; answer?: string; scenarioKey?: string | null };
  const question = draft.question ?? aq.question;
  const answer = (opts.answer ?? draft.answer ?? '').trim();
  if (answer.length < 5) throw new Error('answer too short');
  const scenarioKey = opts.scenarioKey !== undefined ? opts.scenarioKey : (draft.scenarioKey ?? null);

  const qa = await prisma.qAPair.create({
    data: {
      question, answer, status: 'ACTIVE', scenarioKey,
      metadata: { origin: 'ai-suggested', approvedBy: opts.approvedBy, approvedAt: new Date().toISOString() },
    },
  });
  await prisma.aIQuestion.update({ where: { id }, data: { status: 'ANSWERED', respondedAt: new Date(), response: `approved -> QAPair ${qa.id}` } });
  return { qaPairId: qa.id };
}

export async function rejectKnowledgeGap(id: string): Promise<void> {
  await prisma.aIQuestion.update({ where: { id }, data: { status: 'DISMISSED', respondedAt: new Date() } });
}
```

**Step 2:** In `src/app/api/ai-questions/[id]/route.ts` PATCH, handle the new actions (alongside the existing status logic):
```ts
if (action === 'approve') {
  const { qaPairId } = await approveKnowledgeGap(id, { answer: body.answer, scenarioKey: body.scenarioKey, approvedBy: body.approvedBy ?? 'web-admin' });
  return NextResponse.json({ ok: true, qaPairId });
}
if (action === 'reject') { await rejectKnowledgeGap(id); return NextResponse.json({ ok: true }); }
```

**Step 3:** Typecheck.

**Step 4: Verify** — `scripts/_kf_approve.ts`: create a knowledge_gap AIQuestion, call `approveKnowledgeGap(id,{answer:'Для Монголии апостиль не требуется (тест).', approvedBy:'test'})`, assert a QAPair ACTIVE exists with that answer + metadata.origin, and the AIQuestion is ANSWERED. `railway run npx tsx scripts/_kf_approve.ts`. Delete script + test rows.

**Step 5: Commit**
```bash
git add src/lib/ai/knowledge-feedback.ts src/app/api/ai-questions/[id]/route.ts
git commit -m "feat(api): approve/reject knowledge-gap -> ACTIVE QAPair"
```

---

### Task 5: Telegram approve/reject buttons

**Files:**
- Create: `src/lib/telegram/knowledge-gap-callback.ts` (`handleKnowledgeGapCallback`)
- Modify: `src/lib/telegram/message-router.ts` (route `kg:` in `handleCallback`)
- Modify: `src/lib/telegram/ai-escalation.ts` (send knowledge_gap escalations WITH inline buttons)

**Step 1:** When `escalateUnconvincingAIAnswer` reports a knowledge_gap (or in the draft builder after creating the AIQuestion), send super-admins a message via `sendInlineKeyboard(chatId, text, [ {text:'✅ Утвердить', callback_data:`kg:approve:${id}`}, {text:'✖️ Отклонить', callback_data:`kg:reject:${id}`}, {text:'✏️ Поправить', url:`${APP_URL}/admin/ai-questions`} ])`. Keep `callback_data` short (`kg:approve:<cuid>` — within 64 bytes).

**Step 2:** Create `handleKnowledgeGapCallback(chatId, telegramId, data, user)`:
- Only `SUPER_ADMIN` may act (check `user.role`).
- `approve:<id>` → `approveKnowledgeGap(id, { approvedBy: telegramId })`; on success `sendMessage(chatId, '✅ Сохранено в базу знаний.')`.
- `reject:<id>` → `rejectKnowledgeGap(id)`; `sendMessage(chatId, '✖️ Отклонено.')`.
- Wrap in try/catch → friendly error message.

**Step 3:** In `message-router.ts` `handleCallback`, add before the `sc:` branch:
```ts
if (data.startsWith('kg:')) { await handleKnowledgeGapCallback(chatId, telegramId, data.slice(3), accessResult.user); return; }
```

**Step 4:** Typecheck.

**Step 5: Verify** (after deploy) — POST a synthetic `callback_query` update via Node fetch with `data: 'kg:approve:<realId>'` from a SUPER_ADMIN id; assert the QAPair is created and the AIQuestion ANSWERED.

**Step 6: Commit**
```bash
git add src/lib/telegram/knowledge-gap-callback.ts src/lib/telegram/message-router.ts src/lib/telegram/ai-escalation.ts
git commit -m "feat(telegram): approve/reject knowledge-gap drafts via inline buttons"
```

---

### Task 6: Web review surface (`/admin/ai-questions`)

**Files:**
- Modify: `src/app/admin/ai-questions/page.tsx`

**Step 1:** For rows where `issueType === 'knowledge_gap'`, render the draft from `context.draft`: the question (read-only) + the answer in an editable `<textarea>` + the suggested scenarioKey + three buttons:
- **Утвердить** → `PATCH /api/ai-questions/<id>` `{ action:'approve', answer: <textarea>, scenarioKey, approvedBy:'web-admin' }`.
- **Отклонить** → `{ action:'reject' }`.
- On success, remove the row / show "сохранено".

**Step 2:** Typecheck + build: `railway run pnpm build` → exit 0.

**Step 3: Verify** — load the page locally/preview, confirm a knowledge_gap row renders with the editable answer and the buttons hit the API (smoke).

**Step 4: Commit**
```bash
git add src/app/admin/ai-questions/page.tsx
git commit -m "feat(admin): review + approve/edit knowledge-gap drafts on web"
```

---

### Task 7: End-to-end loop verification + eval

**Files:**
- Create: `scripts/_loop_e2e.ts` (throwaway, but keep a trimmed version as a documented check)
- Modify: `scripts/eval/cases.json` (after approving a real China rule, add a green case)

**Step 1:** `scripts/_loop_e2e.ts`: (1) ask a guaranteed gap question via the engine (e.g. "нужен ли апостиль для Монголии") → assert a `knowledge_gap` AIQuestion appears; (2) `approveKnowledgeGap` with a correct answer + scenarioKey null; (3) `answerQuestionEnhanced('нужен ли апостиль для Монголии')` again → assert `answerSource === 'knowledge_base'` and the answer contains the approved text. Run via `railway run npx tsx scripts/_loop_e2e.ts`. Clean up the test QAPair + AIQuestion after.

**Step 2:** Run the full eval: `railway run npx tsx scripts/eval/run.ts` → expect 18/18 (no regression).

**Step 3: Commit** any eval additions.

---

### Task 8: Deploy + verify on prod

**Step 1:** Open PR, merge to master (PR workflow). `railway run pnpm build` (gate) → `railway up --detach`.

**Step 2:** Wait for swap; verify on the LIVE bot via Node fetch (proper UTF-8):
- Ask a gap question (Монголия) as TestRig → a `knowledge_gap` AIQuestion is created (read DB).
- Simulate `kg:approve:<id>` callback from a super-admin id → QAPair created, AIQuestion ANSWERED.
- Ask the same question again → answered from `knowledge_base` with the approved answer.

**Step 3:** Update memory (`answer-source-routing.md`): the feedback loop is live; how to operate it.

---

## Notes / guardrails
- **Never** auto-approve. The draft answer is unverified AI knowledge (can be wrong, e.g. Hague dates) — a human must confirm.
- **UTF-8:** all live tests go through Node `fetch`, not bash `curl`.
- **DRY:** approve/reject logic lives once in `knowledge-feedback.ts`; both web PATCH and Telegram callback call it.
- **YAGNI:** QAPair only (no Rule) on day one; refine dedup later.
