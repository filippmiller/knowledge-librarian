# Agent Log

> **IMMUTABLE LOG POLICY:** No agent may delete, overwrite, or modify existing entries in this file. Only a human operator may authorize deletion or modification of existing content.

> **INSERTION ORDER: NEWEST ENTRY AT TOP.** All agents MUST insert new entries immediately below this header (after the `---` separator). The log is in strict reverse chronological order — the most recent entry is always first. NEVER append to the bottom.

Persistent log of all agent work in this repository.
Each entry tracks: timestamp, agent session, functionality area, files changed, functions/symbols used, database tables affected, and a link to detailed session notes.

---

## [2026-02-14 23:50] — Improve document extraction QA pairs + detailed processing summary

**Area:** Telegram Bot/Document Processing
**Type:** bugfix

### Files Changed
- `src/lib/telegram/document-handler.ts` — Enhanced AI extraction prompt to require QA pairs; added detailed summary with doc ID, domains, rule list, QA list

### Functions/Symbols Modified
- `handleDocumentUpload()` — Destructure `rulesList`/`qaPairsList` from extractKnowledge; build detailed summary with domain names, rule codes+titles, QA questions
- `extractKnowledge()` — Return type changed to `ExtractResult` interface; prompt rewritten to require 1-2 QA pairs per rule; maxTokens 4096→8192; returns `rulesList` and `qaPairsList`
- `ExtractResult` (interface) — New interface for extractKnowledge return type

### Database Tables
- `Domain` — queried for domain names in summary
- `Rule` — created (no schema change)
- `QAPair` — created (no schema change)

### Summary
Documents uploaded via Telegram bot were producing 0 QA pairs because the AI prompt was too minimal ("Извлеки правила и QA пары"). Rewrote the prompt to explicitly require 1-2 natural-language QA pairs per rule. Also enhanced the post-processing summary to show document name, ID, domain names, full list of rules with codes/titles, and QA pair questions (previously only showed counts).

### Session Notes
→ `.claude/sessions/2026-02-14-235000.md`

---

## [2026-02-14 22:00] — Save original file bytes (rawBytes) in document upload

**Area:** Telegram Bot/Document Processing
**Type:** bugfix

### Files Changed
- `src/lib/telegram/document-handler.ts` — Added `rawBytes: buffer` to prisma.document.create data

### Functions/Symbols Modified
- `handleDocumentUpload()` — Added rawBytes field to document creation

### Database Tables
- `Document` — rawBytes field now populated on Telegram uploads

### Summary
Documents uploaded via Telegram bot were not saving the original file binary (rawBytes) despite the schema having the field. Added `rawBytes: buffer` to the document creation call so the original file is preserved and can be referenced.

### Session Notes
→ `.claude/sessions/2026-02-14-235000.md`

---

## [2026-02-14 21:30] — Raise /add text limit from 2000 to 10000 characters

**Area:** Telegram Bot/Commands
**Type:** bugfix

### Files Changed
- `src/lib/telegram/commands.ts` — Changed text length validation from 2000 to 10000

### Functions/Symbols Modified
- `handleAdd()` — Updated max character limit

### Database Tables
- N/A

### Summary
Admin users were getting errors when adding long knowledge texts via `/add` command because of a 2000 character limit. Raised to 10000 to accommodate longer instructions and documents.

### Session Notes
→ `.claude/sessions/2026-02-14-235000.md`

---

## [2026-02-14 20:00] — Fix in-place rule correction + slash command menu + add Яна as super admin

**Area:** Telegram Bot/Knowledge Management
**Type:** bugfix

### Files Changed
- `src/lib/telegram/knowledge-manager.ts` — Rewrote `correctKnowledge()` to update rules in-place instead of superseding; added `deleteConflictingChunks()` function
- `src/lib/telegram/telegram-api.ts` — Added `setBotCommands()` for Telegram slash menu registration
- `src/app/api/telegram/route.ts` — Added lazy `setBotCommands()` on first message and GET health check

### Functions/Symbols Modified
- `correctKnowledge()` — Complete rewrite: now updates rule body in-place (same ruleCode), deprecates old QA pairs, deletes conflicting chunks, creates fresh chunk
- `deleteConflictingChunks()` — New function: finds and deletes chunks with >30% word overlap with old content
- `setBotCommands()` — New function: registers 12 commands with Telegram API for slash menu
- `POST()` route handler — Added lazy command registration
- `GET()` route handler — Added lazy command registration on health check

### Database Tables
- `Rule` — updated in-place (body, title, sourceSpan, updatedAt)
- `QAPair` — old pairs set to DEPRECATED status
- `DocChunk` — conflicting chunks deleted
- `ChunkDomain` — cascade deleted with chunks
- `TelegramUser` — Яна (234742362) added as SUPER_ADMIN via SQL

### Summary
Critical bug: `/correct` command was superseding rules (creating new ones) instead of updating in-place. Old document chunks with outdated prices remained in search, causing contradictory answers. Rewrote correctKnowledge to: (1) update rule body in-place, (2) deprecate old QA pairs, (3) delete conflicting chunks using word overlap matching, (4) create fresh chunk. Also added Telegram slash command menu (12 commands) and added Яна (234742362) as SUPER_ADMIN.

### Session Notes
→ `.claude/sessions/2026-02-14-235000.md`

---

## [2026-02-14 18:00] — Fix voice keyword routing + add /show /edit /delete + plain text messages

**Area:** Telegram Bot/Voice Handler, Commands
**Type:** bugfix

### Files Changed
- `src/lib/telegram/voice-handler.ts` — Added CORRECT_KEYWORDS regex for correction commands via voice
- `src/lib/telegram/commands.ts` — Added handleShow, handleEdit, handleDelete commands
- `src/lib/telegram/message-router.ts` — Added routing for show, edit, delete commands
- `src/lib/telegram/telegram-api.ts` — Switched sendMessage from MarkdownV2 to plain text

### Functions/Symbols Modified
- `handleVoiceMessage()` — Added CORRECT_KEYWORDS regex (поменяй, измени, исправь, обнови, замени)
- `handleShow()` — New: lists recent rules or shows details of specific R-X
- `handleEdit()` — New: supersedes old rule, creates new version
- `handleDelete()` — New: marks rule as DEPRECATED, deprecates linked QA pairs
- `routeTextMessage()` — Added show/edit/delete command routing
- `sendMessage()` — Removed MarkdownV2 formatting, sends plain text

### Database Tables
- `Rule` — queried/updated by show/edit/delete commands
- `QAPair` — queried by show, deprecated by delete
- `RuleDomain` — copied on edit

### Summary
Voice messages saying "поменяй цену..." were routed to Q&A instead of correction because voice handler only had ADD keywords. Added CORRECT_KEYWORDS. Also added /show, /edit, /delete commands for rule management. Switched Telegram messages from MarkdownV2 to plain text because escaping was doubling message length and causing message splits.

### Session Notes
→ `.claude/sessions/2026-02-14-235000.md`

---

## [2026-02-14 15:00] — Full Telegram bot: access control, knowledge management, document upload

**Area:** Telegram Bot
**Type:** feature

### Files Changed
- `prisma/schema.prisma` — Added TelegramUserRole enum and TelegramUser model
- `src/lib/telegram/telegram-api.ts` — New: sendMessage, sendTypingIndicator, sendUploadingIndicator, downloadFile
- `src/lib/telegram/access-control.ts` — New: DB-backed access control with auto-create super admin
- `src/lib/telegram/message-router.ts` — New: routes text/voice/document by content type + user role
- `src/lib/telegram/commands.ts` — New: /start, /help, /grant, /revoke, /promote, /demote, /users, /add, /correct, handleQuestion
- `src/lib/telegram/voice-handler.ts` — New: OpenAI Whisper transcription + keyword routing
- `src/lib/telegram/document-handler.ts` — New: 3-phase document processing pipeline (classify, extract, chunk)
- `src/lib/telegram/knowledge-manager.ts` — New: AI-assisted knowledge parsing, addKnowledge, correctKnowledge
- `src/app/api/telegram/route.ts` — Simplified from ~220 lines to ~35 lines, delegates to message-router

### Functions/Symbols Modified
- `TelegramUser` model — New Prisma model with telegramId, role, isActive
- `TelegramUserRole` enum — SUPER_ADMIN, ADMIN, USER
- `checkAccess()` — New: DB-backed access check, auto-creates super admin
- `handleUpdate()` — New: main message router
- `handleDocumentUpload()` — New: download → parse → 3-phase pipeline → save
- `addKnowledge()` — New: AI parses text into rules + QA pairs
- `correctKnowledge()` — New: AI finds matching rules and updates
- `handleVoiceMessage()` — New: Whisper transcription + command routing
- All command handlers — New: handleStart, handleHelp, handleGrant, handleRevoke, handlePromote, handleDemote, handleUsers, handleAdd, handleCorrect, handleQuestion

### Database Tables
- `TelegramUser` — New table for bot access control
- `Document` — created by document upload
- `Rule` — created by knowledge extraction
- `QAPair` — created by knowledge extraction
- `DocChunk` — created by chunking phase
- `DocumentDomain`, `RuleDomain`, `QADomain`, `ChunkDomain` — domain linking

### Summary
Transformed the Telegram bot from an open Q&A bot into a secure, admin-managed knowledge system. Added DB-backed access control (SUPER_ADMIN/ADMIN/USER roles), user management commands (/grant, /revoke, /promote, /demote, /users), knowledge management (/add, /correct), voice message handling (OpenAI Whisper), and document upload processing (PDF/DOCX/TXT through full 3-phase AI pipeline). Created 7 new module files and simplified the webhook route. Deployed to Railway with TELEGRAM_SUPER_ADMIN=96683003.

### Session Notes
→ `.claude/sessions/2026-02-14-235000.md`

---
