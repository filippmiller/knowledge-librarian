# Session: Forgiving Bot — UX Improvements
**Date**: 2026-02-19
**Agent**: Claude Code (Opus 4.6)
**Status**: Completed

## Context
User discovered 2 critical UX bugs:
1. Admin typed "сохрани правило..." as text → bot ignored save intent, answered from RAG
2. After `/add` created R-100, user asked "покажи правило 100" → bot couldn't find the rule it just created

Root cause: keyword-based intent detection (ADD_KEYWORDS, CORRECT_KEYWORDS) only existed in `voice-handler.ts`. Text messages skipped this entirely and went to RAG or required exact `/commands`.

## Work Performed

### Phase 1: Keyword Detection in Text Messages
- Added `ADD_KEYWORDS` and `CORRECT_KEYWORDS` regex patterns to `message-router.ts` (copied from voice-handler)
- Inserted check between command parsing (step 2) and smart-admin classifier (step 3)
- Works for ADMIN and SUPER_ADMIN roles
- Files: `src/lib/telegram/message-router.ts`

### Phase 2: Direct Rule Lookup by Pattern
- Added `RULE_LOOKUP_PATTERN = /правило\s+(?:R-)?(\d+)/i`
- Matches "правило 100", "правило R-100", "покажи правило 100"
- Direct `prisma.rule.findFirst({ where: { ruleCode: 'R-N' } })` query
- Works for ALL users (not just admin)
- Falls through to RAG if rule not found
- Files: `src/lib/telegram/message-router.ts`

### Phase 3: Search Includes ruleCode
- Added `ruleCode` to OR conditions in `executeSearchRules`
- Files: `src/lib/telegram/smart-admin.ts`

### Phase 4: add_rule Intent in Smart Admin
- Added `add_rule` to `AdminIntent` type
- Updated `CLASSIFIER_PROMPT` with new intent description
- Added to `validIntents` array
- Added `executeAddRule` function and case in `handleSmartAdminAction`
- Files: `src/lib/telegram/smart-admin.ts`

## Technical Decisions
| Decision | Rationale | Alternatives |
|----------|-----------|-------------|
| Keyword detection before smart-admin | Fast, deterministic, no AI call needed | Could rely on classifier only, but adds latency and cost |
| Rule lookup for ALL users | Any user may want to see a specific rule by code | Could restrict to admins, but no security concern |
| Fallthrough to RAG on rule not found | User might be asking about a concept, not a specific code | Could show "not found" and stop |
| add_rule as safety net in classifier | Catches edge cases where regex doesn't match but intent is clear | Could skip, but defense in depth |

## Processing Order (after changes)
1. Pending confirmation intercept (SUPER_ADMIN)
2. `/command` parsing
3. **NEW**: Keyword detection: "сохрани/добавь" → addKnowledge, "поменяй/измени" → correctKnowledge (ADMIN+)
4. **NEW**: Direct rule lookup: "правило N" → DB query (all users)
5. AI intent classifier (SUPER_ADMIN)
6. RAG Q&A fallback (everyone)

## Files Changed (Full List)

| File | Action | Description |
|------|--------|-------------|
| `src/lib/telegram/message-router.ts` | Modified | Added imports (addKnowledge, correctKnowledge, prisma, sendTypingIndicator), keyword regexes, rule lookup pattern, 2 new routing steps |
| `src/lib/telegram/smart-admin.ts` | Modified | Added add_rule intent (type, prompt, validIntents, handler, executor), ruleCode in search OR conditions |

## Functions & Symbols

| Symbol | File | Action | Description |
|--------|------|--------|-------------|
| `ADD_KEYWORDS` | message-router.ts | New | Regex for add/save keywords in text messages |
| `CORRECT_KEYWORDS` | message-router.ts | New | Regex for correct/change keywords in text messages |
| `RULE_LOOKUP_PATTERN` | message-router.ts | New | Regex to match "правило N" / "правило R-N" |
| `routeTextMessage()` | message-router.ts | Modified | Added steps 3 (keyword detection) and 4 (rule lookup) |
| `AdminIntent` | smart-admin.ts | Modified | Added `'add_rule'` to union type |
| `CLASSIFIER_PROMPT` | smart-admin.ts | Modified | Added add_rule intent description |
| `classifyAdminIntent()` | smart-admin.ts | Modified | Updated validIntents array |
| `handleSmartAdminAction()` | smart-admin.ts | Modified | Added add_rule case |
| `executeAddRule()` | smart-admin.ts | New | Calls addKnowledge via smart-admin |
| `executeSearchRules()` | smart-admin.ts | Modified | Added ruleCode to OR search conditions |

## Database Impact

| Table | Action | Details |
|-------|--------|---------|
| `Rule` | Query | findFirst by ruleCode for direct rule lookup; ruleCode added to search OR conditions |

## Deployment
- Railway: `railway up --detach`, build + deploy successful
- Next.js 16.1.3 started on port 8080, no errors

## Commits
- `1ba28d3` — feat: forgiving bot — keyword detection, direct rule lookup, smarter search
- `5573028` — docs: add work-log entry for forgiving bot UX changes

## Gotchas & Notes for Future Agents

- **Keyword regexes are duplicated** between `voice-handler.ts` and `message-router.ts`. If you update one, update both. Consider extracting to a shared constants file if more locations need them.
- **RULE_LOOKUP_PATTERN** only matches Cyrillic "правило" — English "rule 100" or "show R-100" will NOT be caught by this pattern. They fall through to RAG or smart-admin classifier.
- **Rule lookup falls through to RAG** if the rule code doesn't exist. This is intentional — user might be asking about a concept (e.g., "правило 100 о переводах") rather than requesting an exact code.
- **add_rule in smart-admin is a safety net** — keyword detection in step 3 should catch most cases. The classifier catches edge cases where the user phrases it differently (e.g., "занеси в базу знаний что...").
- **Processing order matters**: keyword detection (step 3) runs BEFORE smart-admin classifier (step 5). This means keyword matches bypass the AI classifier entirely — faster and cheaper.
