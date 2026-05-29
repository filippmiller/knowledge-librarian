# Knowledge Librarian - Work Log

> **INSERTION ORDER: NEWEST ENTRY AT TOP.** All agents MUST insert new entries immediately below this header (after the `---` separator). The log is in strict reverse chronological order — the most recent entry is always first. NEVER append to the bottom.

---

## 2026-02-19 — UX: Forgiving Bot — Keyword Detection, Direct Rule Lookup

**Status**: Completed
**Commits**: 1ba28d3

### What was done
- **Keyword detection in text messages**: Admin text starting with "сохрани/добавь/запомни/запиши" now triggers `addKnowledge` directly (not RAG). Same for "поменяй/измени/исправь/обнови" → `correctKnowledge`. Previously this only worked for voice messages.
- **Direct rule lookup**: "правило 100" or "правило R-100" in any text message now queries the DB by ruleCode and shows the rule directly. Works for ALL users. Falls through to RAG only if not found.
- **Search includes ruleCode**: `executeSearchRules` in smart-admin now also searches by `ruleCode` field (was only title+body).
- **`add_rule` intent in smart-admin**: Added as fallback for SUPER_ADMIN AI classifier — catches "сохрани правило..." even if keyword regex doesn't match.

### Root cause
Bot was too "rigid" — keyword-based intent detection (add/correct) only worked for voice messages. Text messages went straight to RAG or required exact `/commands`. User wrote "сохрани правило..." as text → bot answered from RAG. After `/add` created R-100, user asked "покажи правило 100" → bot couldn't find it (no direct DB lookup).

### Files changed
- `src/lib/telegram/message-router.ts` — keyword detection + rule lookup pattern
- `src/lib/telegram/smart-admin.ts` — ruleCode in search + add_rule intent

### Deployment
- Railway: deployed via `railway up`, Next.js 16.1.3 started successfully

---

## 2026-02-14 — Telegram Bot: Access Control, Knowledge Management, Document Upload

**Status**: Completed
**Commits**: d023ba0, 1f781fd, d2f6e0e, cdd7d4b, b2bb344, dc04725

### What was done
- Built full Telegram bot system: DB-backed access control (SUPER_ADMIN/ADMIN/USER), 7 new module files
- User management: /grant, /revoke, /promote, /demote, /users commands
- Knowledge management: /add (AI parses text into rules+QA), /correct (in-place rule updates)
- Voice messages: Whisper transcription with keyword routing (add/correct/question)
- Document upload: 3-phase pipeline (classify, extract, chunk) with detailed summary
- Rule viewing: /show, /edit, /delete commands
- Slash command menu registered with Telegram API (12 commands)
- Added Яна (234742362) as SUPER_ADMIN

### Bugfixes
- Voice "поменяй" was routed to Q&A instead of correction (missing CORRECT_KEYWORDS)
- MarkdownV2 escaping split messages; switched to plain text
- /correct created duplicate rules; rewrote to update in-place + delete conflicting chunks
- /add had 2000 char limit; raised to 10000
- rawBytes not saved on document upload; fixed
- 0 QA pairs from documents; rewrote extraction prompt to require 1-2 QA per rule

### Decisions made
- Plain text over MarkdownV2 for all Telegram messages
- In-place rule correction over supersede pattern (avoids conflicting search results)
- Non-streaming pipeline for Telegram (no SSE needed)

### Session Notes
→ `.claude/sessions/2026-02-14-235000.md`
→ `.claude/agent-log.md` (6 entries)

---

## 2026-02-06 Session 2 - EXTRACTED Status & Production Processing

**Status**: Completed
**Duration**: ~3.5 hours
**Commits**: 9962c22

## 2026-02-06 Session 1 - Resilience & Error-Proofing

**Status**: Completed
**Commits**: 8787fce, and prior commits

### What was done
- Found and fixed critical bug: EXTRACTED documents re-processed from scratch on reopen (83s wasted + data loss)
- Added server-side guard to force resume mode for EXTRACTED documents
- End-to-end tested resume flow: 4.1s DB load vs 83s re-processing
- Deployed all changes to production Railway
- Processed all 5 PENDING documents on production (183 items in 168.7s, zero errors)
- Committed all 6 EXTRACTED documents to knowledge base
- Final state: 15/15 documents COMPLETED

### Decisions made
- Server-side resume guard chosen over client-side for robustness
- Sequential production processing to avoid Railway/AI API overload
- Node.js SSE consumer script when Playwright unavailable

### Issues encountered
- Playwright MCP tools became unavailable mid-session; switched to Node.js scripts
- PowerShell commands timeout on large API responses; used Node.js piping instead

### Next steps
- All documents processed and committed - knowledge base is complete
- Consider adding batch processing UI for multiple documents
- Address Next.js 16 middleware deprecation warning (middleware.ts -> proxy.ts)

---

### What was done
- Added EXTRACTED enum to ParseStatus in Prisma schema
- Implemented SSE disconnect resilience (processing continues in background)
- Added reconnection logic: 5 attempts, exponential backoff up to 10s
- Added React Strict Mode guard to prevent duplicate processing
- Added concurrent processing lock (in-memory Map)
- Added 6-hour auto-fail for stuck PROCESSING documents
- Added duplicate upload protection
- Added EXTRACTED badge, "Проверить" button, review counter in UI
- Reset 5 stuck PROCESSING documents to PENDING
- Successfully processed first test document end-to-end

### Issues encountered
- Prisma DLL lock from dev server holding query_engine-windows.dll.node
- PowerShell `$_` interpolation issues in bash shell
