# Agent Log

> **IMMUTABLE LOG POLICY:** No agent may delete, overwrite, or modify existing entries in this file. Only a human operator may authorize deletion or modification of existing content.

> **INSERTION ORDER: NEWEST ENTRY AT TOP.** All agents MUST insert new entries immediately below this header (after the `---` separator). The log is in strict reverse chronological order — the most recent entry is always first. NEVER append to the bottom.

Persistent log of all agent work in this repository.
Each entry tracks: timestamp, agent session, functionality area, files changed, functions/symbols used, database tables affected, and a link to detailed session notes.

---

## [2026-06-06 16:00] — Fix isBureauTopic Unicode bug + add migration terms + 18/20 test pass

**Area:** AI/Answering Engine / Knowledge Base Quality
**Type:** bugfix

### Files Changed
- `src/lib/ai/enhanced-answering-engine.ts` — replaced BUREAU_TOPIC_PATTERN with BUREAU_TOPIC_PATTERN_CI (/iu flags, no normalizeRussianText); added migration terms (внж, рвп, миграц, вид на жительств, etc.); removed diagnostic console.log

### Functions/Symbols Modified
- `BUREAU_TOPIC_PATTERN` — deleted (replaced by BUREAU_TOPIC_PATTERN_CI)
- `BUREAU_TOPIC_PATTERN_CI` — new (RegExp with /iu flags on raw question)
- `isBureauTopic()` — modified (uses BUREAU_TOPIC_PATTERN_CI, tests original question without normalization)

### Database Tables
- `Rule` — 80 rows updated (Nalivayko title prefix, applied prev session via API)

### Summary
20-question production test showed 15/20 passing with migration questions (ВНЖ, РВП, вид на жительство) all returning 0% confidence. Root cause: `normalizeRussianText().toLowerCase()` on Alpine Linux Node 20 was producing U+FFFD replacement characters for all Cyrillic, causing `isBureauTopic()` to always return false. Fixed by replacing the Cyrillic literal regex + normalization approach with a `new RegExp(pattern, 'iu')` that tests the original question directly. Also added migration-domain terms that were missing from the pattern. Final score: 18/20 (2 remaining failures are legitimate KB gaps — no German/French price data in uploaded documents).

### Session Notes
→ `.claude/sessions/2026-06-06-160000.md`

---

## [2026-06-06 14:00] — Process 5 new .docx documents + fix 3 extraction bugs

**Area:** Document Processing / AI Extraction / Knowledge Base Quality
**Type:** bugfix

### Files Changed
- `src/lib/ai/knowledge-extractor-stream.ts` — added ПРАЙС-ЛИСТЫ section with КРИТИЧЕСКОЕ/ЗАПРЕЩЕНО/ОБЯЗАТЕЛЬНО markers + JSON example for price table consolidation; added common abbreviation exclusions
- `src/lib/document-processing/extraction-lint.ts` — fixed hardFacts(): removed whitespace normalization (`replace(/\s+/g, '')`), now uses `\b\d{3,}\b` directly on raw text
- `src/lib/document-processing/commit.ts` — added empty QA pair guard (skip if question/answer is blank)

### Functions/Symbols Modified
- `hardFacts()` — modified (broken whitespace normalization removed)
- `commitDocumentKnowledge()` — modified (empty QA pair guard added)
- `streamKnowledgeExtraction()` — modified (price table prompt section added)

### Database Tables
- `Rule` — 513 new rows (5 documents committed)
- `QAPair` — 128 new rows
- `DocChunk` — 53 new rows
- `Document` — 5 rows status → COMPLETED

### Summary
User uploaded 5 new .docx documents (price lists, apostille guide, Q&A reference, migration instruction). Processing under manual control revealed 3 bugs: (1) price table granularity — LLM creating one rule per table cell (5× too many); fixed with explicit КРИТИЧЕСКОЕ prompt section + JSON example after first soft attempt was ignored. (2) lint hardFacts() false positives — whitespace normalization concatenated adjacent prices causing every price to appear "hallucinated"; fixed by removing normalization entirely and using `\b` word boundaries. (3) empty QA pair crash — LLM emitted `question: ""`, Prisma NOT NULL violated; fixed with trim() guard. All 5 documents now COMPLETED in production with 0 blocking issues.

### Session Notes
→ `.claude/sessions/2026-06-06-140000.md`

---

## [2026-06-06 12:00] — Fix extraction engine resilience + fix 7-build deploy break + commit stale docs

**Area:** Document Processing / Deployment / Knowledge Base
**Type:** bugfix

### Files Changed
- `src/lib/ai/knowledge-extractor-stream.ts` — batch parse failure: throw → skip+warn; added `batch_skipped` event type
- `src/app/api/documents/[id]/route.ts` — reset/retry actions now set `retryCount: 0`
- `src/app/api/documents/[id]/process-stream/route.ts` — `isFatalError` narrowed; batch_skipped surfaced in terminal
- `src/lib/crypto.ts` — ENCRYPTION_KEY validation deferred to `getKey()` (fixes Docker build break since June 4)
- `src/lib/document-processing/commit.ts` — `autoVerifyPending` option; null-safe secondaryDomainSlugs; better empty-staged handling
- `src/app/api/documents/[id]/commit/route.ts` — accept `autoVerifyPending`/`replaceExisting` from request body

### Functions/Symbols Modified
- `streamKnowledgeExtraction()` — modified (batch skip instead of throw)
- `isFatalError()` — modified (narrowed to permanent failures only)
- `getKey()` in crypto.ts — modified (contains ENCRYPTION_KEY check now)
- `commitDocumentKnowledge()` — modified (autoVerifyPending + null safety)
- PATCH reset/retry handlers — modified (retryCount reset)

### Database Tables
- `Document` — retryCount/parseStatus updates; 3 documents set COMPLETED
- `Rule` — 98 new rows (3 documents committed)
- `QAPair` — 35 new rows
- `DocChunk` — 10 new rows with pgvector embeddings
- `StagedExtraction` — 171 rows marked isVerified=true

### Summary
Fixed 4 bugs in the extraction engine: batch JSON parse failures no longer abort entire documents; reset/retry now clears retryCount; isFatalError no longer treats transient errors as permanent. Diagnosed and fixed a Docker build break (ENCRYPTION_KEY module-level throw) that had silently failed 7 consecutive Railway deployments since June 4th. Committed 3 stale EXTRACTED documents (98 rules, 35 QA pairs). 5 documents remain PENDING and need processing via the admin terminal.

### Session Notes
→ `.claude/sessions/2026-06-06-120000.md`

---

## [2026-02-28 22:30] — Fix JSON parsing pipeline + process error-logging document + verify Q&A

**Area:** Document Processing / Knowledge Extraction / Q&A Engine
**Type:** bugfix

### Files Changed
- `src/lib/ai/chat-provider.ts` — 3 fixes: position-based fence stripping, `escapeControlCharsInStrings()`, truncation artifact regex in `coerceJsonSyntax`
- `src/lib/ai/knowledge-extractor-stream.ts` — raise `maxTokens` 8192→16000; relax validation to only require `rules`
- `tmp-upload/test-qa.mjs` — fix endpoint URL `/api/answer` → `/api/ask`

### Functions/Symbols Modified
- `normalizeJsonResponse()` — replaced broken `[`*]{2,}` regex with position-based fence stripping
- `escapeControlCharsInStrings()` — new function; escapes literal `\n`/`\r` inside JSON string values
- `coerceJsonSyntax()` — added regex to repair `"key""` truncation artifact → `"key": ""`
- `streamKnowledgeExtraction()` — maxTokens 8192→16000; optional fields default to `[]`

### Database Tables
- `Rule` — 41 new rules committed (R-234–R-274) from "Инструкция_по_фиксации_ошибок_в_чате"
- `QaPair` — 10 new Q&A pairs committed
- `AiQuestion` — 5 AI questions committed
- `Chunk` — 5 chunks committed

### Summary
Root-cause investigation of "Не удалось распарсить ответ батча 1" revealed three layered bugs in `normalizeJsonResponse`: (1) a `[`*]{2,}` regex matching `**bold**` inside JSON bodies caused lazy match to cut content short; (2) Cyrillic AI responses contain literal `\n` chars inside JSON strings (invalid JSON), causing `coerceJsonSyntax` to fall back to `{}`; (3) `balanceJson` truncation at 8192-token limit produced `"key""` artifacts. All three fixed. maxTokens raised to 16000 to handle Cyrillic text (≈2 chars/token). Document processed successfully: 41 rules committed to KB. Q&A tested — 5/5 questions answered correctly (confidence 0.61–0.75).

### Session Notes
→ `.claude/sessions/2026-02-28-json-pipeline-fix-full.md`

---

## [2026-02-28] — Fix knowledge extractor rejecting valid AI batch responses

**Area:** Document Processing / Knowledge Extraction
**Type:** bugfix

### Files Changed
- `src/lib/ai/knowledge-extractor-stream.ts` — relax batch validation; default optional fields to `[]`

### Functions/Symbols Modified
- batch parse block in `extractKnowledgeStream()` — only require `rules`; default `qaPairs` and `uncertainties` to `[]` if absent

### Database Tables
- N/A

### Summary
The AI occasionally returns a batch response containing only the `rules` array, omitting `qaPairs` and `uncertainties` when there are none. The strict three-field validation was throwing "Knowledge Extractor returned invalid JSON" even though the JSON was structurally correct. Fixed by validating only `rules` (required) and safely defaulting the optional fields.

### Session Notes
→ `.claude/sessions/2026-02-28-knowledge-extractor-fix.md`

---

## [2026-02-19 16:00] — Forgiving bot: keyword detection in text, direct rule lookup, smarter search

**Area:** Telegram Bot/Message Router, Smart Admin
**Type:** feature

### Files Changed
- `src/lib/telegram/message-router.ts` — Added keyword detection (ADD_KEYWORDS, CORRECT_KEYWORDS) for text messages; added RULE_LOOKUP_PATTERN for direct rule lookup by code; imported addKnowledge, correctKnowledge, prisma, sendTypingIndicator
- `src/lib/telegram/smart-admin.ts` — Added `add_rule` intent to classifier prompt, AdminIntent type, validIntents, handleSmartAdminAction switch; added `executeAddRule()` function; added ruleCode to OR conditions in `executeSearchRules()`

### Functions/Symbols Modified
- `routeTextMessage()` — Modified: added step 3 (keyword detection for admin), step 4 (rule lookup for all users), renumbered steps 5-6
- `executeSearchRules()` — Modified: added `ruleCode` to OR search conditions
- `executeAddRule()` — New: calls addKnowledge via smart-admin AI classifier
- `classifyAdminIntent()` — Modified: updated validIntents to include `add_rule`
- `handleSmartAdminAction()` — Modified: added `add_rule` case
- `CLASSIFIER_PROMPT` — Modified: added `add_rule` intent description
- `AdminIntent` type — Modified: added `'add_rule'` union member
- `ADD_KEYWORDS` const — New in message-router (copied from voice-handler)
- `CORRECT_KEYWORDS` const — New in message-router (copied from voice-handler)
- `RULE_LOOKUP_PATTERN` const — New: `/правило\s+(?:R-)?(\d+)/i`

### Database Tables
- `Rule` — direct findFirst by ruleCode for rule lookup pattern; ruleCode added to search OR conditions

### Summary
Bot was too rigid — keyword-based intent detection (add/correct) only worked for voice messages, and "покажи правило 100" went through full RAG instead of a direct DB lookup. Added three layers of "forgiveness": (1) admin text starting with "сохрани/добавь/запомни" triggers addKnowledge directly, same for "поменяй/измени" → correctKnowledge; (2) "правило N" pattern queries the DB by ruleCode and shows the rule instantly for all users; (3) add_rule intent in smart-admin classifier as a fallback safety net. Also fixed executeSearchRules to include ruleCode in search.

### Session Notes
→ `.claude/sessions/2026-02-19-forgiving-bot.md`

---

## [2026-02-15 02:00] — Smart admin mode: natural language routing for SUPER_ADMIN

**Area:** Telegram Bot/Smart Admin, Commands, Knowledge Management
**Type:** feature

### Files Changed
- `src/lib/telegram/smart-admin.ts` — New: AI intent classifier, confirmation flow, 7 action executors
- `src/lib/telegram/commands.ts` — Added handleConfirm(); /edit sets confidence=1.0; /show shows confirm hint
- `src/lib/telegram/knowledge-manager.ts` — correctKnowledge() sets confidence=1.0 on updated rules
- `src/lib/telegram/message-router.ts` — Added smart admin routing layer for SUPER_ADMIN plain text

### Functions/Symbols Modified
- `classifyAdminIntent()` — New: AI classifier (8 intents, JSON mode, temp=0.1)
- `handleSmartAdminAction()` — New: routes classified intent to appropriate executor
- `hasPendingConfirmation()` — New: checks in-memory Map with 5-min TTL
- `handleConfirmationResponse()` — New: processes да/нет for destructive actions
- `executeConfirmRule()` — New: sets rule confidence to 1.0
- `executeConfirmAllDocRules()` — New: bulk confirm all rules from a document
- `executeSearchRules()` — New: ILIKE search in rule title+body
- `executeListDocuments()` — New: all completed docs with rule counts
- `executeShowStats()` — New: rule/QA/chunk counts, optionally by domain
- `prepareDeleteRule()` — New: preview + confirmation request
- `prepareDeleteDocument()` — New: preview + confirmation request
- `executeDeleteRule()` — New: DEPRECATED in transaction
- `executeDeleteDocument()` — New: cascade deprecate/delete in transaction
- `handleConfirm()` — New: /confirm R-X command handler
- `handleEdit()` — Modified: confidence now 1.0 instead of copying old value
- `handleShow()` — Modified: shows /confirm hint when confidence < 1.0
- `correctKnowledge()` — Modified: sets confidence=1.0 on updated rules
- `routeTextMessage()` — Modified: added confirmation intercept + AI classification for SUPER_ADMIN

### Database Tables
- `Rule` — confidence updated to 1.0 on confirm/edit/correct; DEPRECATED on delete
- `QAPair` — DEPRECATED on rule delete
- `DocChunk` — deleted on document delete
- `Document` — queried for list/stats; marked FAILED on delete
- `RuleDomain`, `QADomain`, `ChunkDomain` — queried for stats

### Summary
SUPER_ADMIN can now interact with the bot using natural Russian text instead of rigid /commands. An AI intent classifier (8 intents, confidence threshold 0.7) routes plain text to smart actions: confirm rules, search, list documents, show stats. Destructive actions (delete rule, delete document) require explicit "да" confirmation with 5-minute timeout. Also added /confirm R-X command for all admins, and set confidence=1.0 on /edit and /correct (human-verified). Regular users and ADMINs are completely unaffected.

### Session Notes
→ `.claude/sessions/2026-02-15-020000.md`

---

## [2026-02-15 00:30] — Role-based commands, /report, /helpme

**Area:** Telegram Bot/Commands, Access Control
**Type:** feature

### Files Changed
- `src/lib/telegram/telegram-api.ts` — Slash menu shows only user commands (start, help, report, helpme)
- `src/lib/telegram/access-control.ts` — Added getAdminTelegramIds(), getAllActiveTelegramIds()
- `src/lib/telegram/commands.ts` — Added handleReport(), handleHelpMe(); updated /start and /help to show /report and /helpme
- `src/lib/telegram/message-router.ts` — Added /report, /helpme routing; centralized admin command blocking

### Functions/Symbols Modified
- `setBotCommands()` — Now registers only 4 user commands instead of 12
- `getAdminTelegramIds()` — New: returns all active ADMIN+SUPER_ADMIN telegram IDs
- `getAllActiveTelegramIds()` — New: returns all active user telegram IDs
- `handleReport()` — New: reports wrong info to all admins via DM
- `handleHelpMe()` — New: broadcasts question to all active users via DM
- `handleStart()` — Shows /report and /helpme to all users
- `handleHelp()` — Shows /report and /helpme to all users
- `routeTextMessage()` — Split into user commands (always) and admin commands (role-gated)

### Database Tables
- `TelegramUser` — queried for admin IDs and all active user IDs

### Summary
Regular users now only see 4 commands in the Telegram slash menu: /start, /help, /report, /helpme. Admin commands are hidden and blocked at the router level for USER role. /report lets any user report wrong information — all admins receive a notification DM. /helpme broadcasts a question to all active users in the system.

### Session Notes
→ `.claude/sessions/2026-02-14-235000.md`

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
