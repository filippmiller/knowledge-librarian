# Session Notes: Fix JSON Parsing Pipeline + Process Error-Logging Document

**Date:** 2026-02-28 22:30
**Area:** Document Processing / Knowledge Extraction / Q&A Engine
**Type:** bugfix
**Log Entry:** `.claude/agent-log.md` (entry at 2026-02-28 22:30)
**Commits:** `ea627de` — fix(knowledge-extractor): JSON pipeline + token limit, `f8366ff` — fix(test): use correct /api/ask endpoint

## Context

User reported "Не удалось распарсить ответ батча 1" error when processing "Инструкция_по_фиксации_ошибок_в_чате.docx" in the mini-app. Investigation via Railway logs revealed three layered bugs in the JSON normalization pipeline.

## What Was Done

### Phase 1: Initial hypothesis — missing optional fields

Railway logs showed `Knowledge Extractor returned invalid JSON`. The AI returned JSON with `rules` but omitted `qaPairs` and `uncertainties`.

Fix: Changed batch validation in `knowledge-extractor-stream.ts` to only require `rules`, defaulting optional fields to `[]`.

→ This was necessary but **not sufficient** — error persisted.

### Phase 2: Root cause in `normalizeJsonResponse` — fence stripping regex

Added debug logging and found `cleaned: {}` — the full pipeline was returning an empty object.

Root cause: `normalizeJsonResponse` used regex `/[`*]{2,}(?:json)?\s*([\s\S]*?)\s*[`*]{2,}/i` which:
- Matched asterisks (`**bold**` text inside JSON body)
- Lazy `*?` caused match to stop at the first `**` in the body, discarding the rest

Fix: Replaced regex with position-based fence stripping:
```typescript
if (trimmed.startsWith('`')) {
  const firstNewline = trimmed.indexOf('\n');
  if (firstNewline !== -1) {
    trimmed = trimmed.slice(firstNewline + 1).trim();
  } else {
    trimmed = trimmed.replace(/^`+(?:json)?\s*/i, '').trim();
  }
  const closingFence = trimmed.lastIndexOf('\n```');
  if (closingFence !== -1) {
    trimmed = trimmed.slice(0, closingFence).trim();
  } else if (trimmed.endsWith('`')) {
    trimmed = trimmed.replace(/`+\s*$/, '').trim();
  }
}
```

→ Still failing after this fix alone.

### Phase 3: Root cause — literal `\n` inside JSON string values

`coerceJsonSyntax` trace logging showed: `first parse failed: Unexpected string in JSON at position 19706`, with `tail: "answer"""}]}`.

Cyrillic AI responses contain literal newline characters inside JSON string values (the `body` field of rules). This is invalid JSON. `JSON.parse` fails, and `coerceJsonSyntax` falls back to `{}`.

Fix: Added `escapeControlCharsInStrings()` — a char-by-char parser that correctly identifies JSON string boundaries and escapes `\n` → `\\n`, `\r` → `\\r` inside strings without touching structural whitespace:

```typescript
function escapeControlCharsInStrings(json: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (inString) {
      if (escaped) { escaped = false; result += char; }
      else if (char === '\\') { escaped = true; result += char; }
      else if (char === '"') { inString = false; result += char; }
      else if (char === '\n') { result += '\\n'; }
      else if (char === '\r') { result += '\\r'; }
      else { result += char; }
    } else {
      if (char === '"') inString = true;
      result += char;
    }
  }
  return result;
}
```

### Phase 4: Root cause — token limit truncation + `balanceJson` artifact

Tail analysis showed `"answer""` — a `balanceJson` truncation artifact. When the AI response is cut off mid-value, `balanceJson` closes the string with `"`, leaving `"key""` instead of a valid value.

Additional cause: 8192 token limit is too low for Cyrillic text. Cyrillic chars cost ≈2 tokens each vs ≈4 chars/token for Latin. A 16,000-char Cyrillic response needs ~8,000 tokens — right at the old limit.

Fixes:
- `maxTokens` raised from 8192 → 16000 in `knowledge-extractor-stream.ts`
- Added regex in `coerceJsonSyntax` to repair truncation artifact:
  ```typescript
  sanitized = sanitized.replace(/"([^"\\]+)""\s*([},\]])/g, '"$1": ""$2');
  ```

### Phase 5: Deployment issue

During investigation, discovered Railway auto-deploy (triggered by git push) was overriding `railway up --detach` uploads. Critical rule: **always commit ALL changes before running `railway up --detach`**.

### Phase 6: Document processing

After all fixes committed and deployed, triggered reprocessing via API. Document processed successfully in 1 batch.

### Phase 7: Staged items verification + commit

Document landed in EXTRACTED status with 64 staged items unverified. Required:
1. PATCH `/api/documents/{id}/staged` with all 64 item IDs and `action: "verify"`
2. POST `/api/documents/{id}/commit`

Result: 41 rules (R-234–R-274), 10 QA pairs, 5 AI questions, 5 chunks committed.

### Phase 8: Q&A verification

Created `tmp-upload/test-qa.mjs` with 5 test questions. Fixed endpoint URL (`/api/answer` → `/api/ask`). All 5 questions answered correctly:

| Question | Confidence |
|----------|------------|
| Format for Bitrix24 error reports | 0.75 |
| What are Type 1 errors? | 0.61 |
| What counts as manager error? | 0.68 |
| How to record semantic translator error? | 0.67 |
| What to do if translator loses document? | 0.67 |

## Technical Details

| Aspect | Detail |
|--------|--------|
| Commit Type | fix |
| Scope | knowledge-extractor, chat-provider, test |
| Breaking Change | No |
| Files Modified | 3 |
| Rules Committed | 41 (R-234–R-274) |
| Q&A Pairs Committed | 10 |
| Chunks Committed | 5 |

## Key Insight for Future Agents

**Cyrillic text token cost**: Cyrillic is ~2 chars/token (vs ~4 for Latin). A document with 16,000 Cyrillic chars needs ~8,000 tokens for output. Always use `maxTokens: 16000` for knowledge extraction with Russian text.

**Railway deployment conflict**: GitHub auto-deploy (triggered by git push) overwrites `railway up --detach`. Always commit ALL changes to git first, then deploy.

**JSON pipeline order matters**: `escapeControlCharsInStrings()` must run BEFORE `balanceJson()` — it needs valid string state to correctly identify boundaries.

## Verification

- [x] All fixes committed: `ea627de`
- [x] Test script committed: `f8366ff`
- [x] Pushed to origin/main
- [x] Document "Инструкция_по_фиксации_ошибок_в_чате" processed: 41 rules committed
- [x] Q&A tested: 5/5 questions answered correctly
- [x] Agent log entry created
- [x] Session notes created
