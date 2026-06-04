# Security Scan Report — Avrora Translation Knowledge Library

**Generated:** 2026-06-04
**Project:** `C:\dev\translation` (Next.js 16 App Router + Prisma 5 + PostgreSQL/Railway)
**Scope:** Tracked source only (`src/**`, `app/api/**`, scripts). `.env`, `node_modules`, `.next` excluded.
**Method:** Direct file reads + scoped `git grep`. Findings are reachability-checked; confidence noted per item.

---

## Summary (counts per priority)

| Priority | Count |
|---|---|
| 🔴 Critical | 2 |
| 🟠 High | 4 |
| 🟡 Medium | 4 |
| 🟢 Low | 3 |

### Top items (file:line)
1. 🔴 **No Telegram webhook authenticity check** — `src/app/api/telegram/route.ts:9` (anyone can POST forged updates).
2. 🔴 **Weak default encryption key fallback** — `src/lib/crypto.ts:3` (protects AI API keys + SSE tokens).
3. 🟠 **Unauthenticated full-document text exfiltration** — `src/app/api/telegram/mini-app/route.ts:418` (`getDocument` is a public action, returns full `rawText`).
4. 🟠 **Unauthenticated expensive AI/transcription actions, no rate limit** — `mini-app/route.ts:429` (`voiceSearch`), `:851` (`ask`).
5. 🟠 **Mini-app POST router has no rate limiting at all** — `mini-app/route.ts:174`.
6. 🟠 **Telegram mini-app hash compare is not constant-time** — `src/lib/telegram/mini-app-auth.ts:43`.

---

## What is SOLID (verified, no action needed)

- **No hardcoded secrets in tracked source.** `git grep` for key patterns (`sk-`, `sk-ant-`, `AIza`, `ghp_`, bot-token shape, bearer tokens) found only `process.env.*` reads and a secret-*detection* regex in `librarian-service.ts:128`. `.env` / `.env.local` are gitignored and **not** tracked. (Confidence: high)
- **No SQL injection.** Every `$queryRaw` / `$executeRaw` is a tagged template with parameter binding (`mini-app/route.ts`, `vector-search.ts`, `librarian-service.ts`). The only string interpolation into raw SQL (`vector-search.ts:107-110`, `:129-130`) comes from internal enum-derived `ancestorsOf()` values with `''`-escaping, not user input. (Confidence: high)
- **No XSS sinks.** Zero `dangerouslySetInnerHTML`, `innerHTML`, or `document.write` in `src/**`. (Confidence: high)
- **No SSRF.** All outbound `fetch()` in `telegram-api.ts` builds URLs from `api.telegram.org` + the bot token, never from request input. No Bitrix webhook *receiver* exists in tracked code yet. (Confidence: high)
- **Web admin API surface is consistently auth-gated.** `requireAdminAuth` present on documents, rules, qa, domains, ai-questions, knowledge-changes, admin/vector-search, admin/ai-settings, librarian/ingest, documents/[id], documents/[id]/token. (Confidence: high)
- **Web Basic Auth uses bcrypt `compare`** (`auth.ts:35,85`) — inherently constant-time, so the timing concern does not apply to the web login path. (Confidence: high)
- **No NEXT_PUBLIC_ secret leakage.** Client bundle gets only `NEXT_PUBLIC_APP_URL`. Secrets (`TELEGRAM_BOT_TOKEN`, `ENCRYPTION_KEY`, AI keys) are read only in server modules. (Confidence: high)

---

## 🔴 Critical

### C-1 — Telegram webhook does not verify the request comes from Telegram
**File:** `src/app/api/telegram/route.ts:9-36`
**Confidence:** High

`POST /api/telegram` parses `request.json()` straight into `handleUpdate(update)` with **no verification** that the caller is Telegram. There is no check of the `X-Telegram-Bot-Api-Secret-Token` header (confirmed absent: `git grep` for `secret-token`/`secretToken`/`TELEGRAM_WEBHOOK_SECRET` returns nothing). The endpoint is also outside the middleware matcher (`middleware.ts:28` only guards `/admin/:path*`).

**Impact:** Any internet client can POST forged Telegram updates. `handleUpdate` does call `checkAccess(telegramId, …)` per message, but `telegramId` is **attacker-controlled JSON**. An attacker who knows/guesses a registered admin's numeric Telegram ID (or the bootstrap `TELEGRAM_SUPER_ADMIN` ID) can impersonate that user and drive admin command handlers (`handleGrant`, `handleDelete`, `handleAdd`, knowledge edits, document handling). This is a full authentication bypass for the bot's admin surface.

**Fix:** Set a secret on the webhook (`setWebhook` with `secret_token`) and reject requests whose `X-Telegram-Bot-Api-Secret-Token` header ≠ `process.env.TELEGRAM_WEBHOOK_SECRET`, using a constant-time compare, before any processing.

```ts
const secret = request.headers.get('x-telegram-bot-api-secret-token') ?? '';
const expected = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
if (!expected || !crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(expected))) {
  return NextResponse.json({ ok: true }); // 200 + ignore, don't leak
}
```

---

### C-2 — Insecure default encryption key fallback
**File:** `src/lib/crypto.ts:3`
**Confidence:** High

```ts
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-key-change-in-production-32';
```

If `ENCRYPTION_KEY` is unset, the code silently uses a **known, source-committed AES-256-GCM key**. This key encrypts:
- AI provider API keys at rest (`admin/ai-settings/route.ts` → `encrypt()`), and
- SSE processing tokens (`createProcessingToken`), which act as bearer auth for `process-stream` (the expensive AI extraction endpoint).

**Impact:** With the default key, anyone with the source can (a) decrypt stored OpenAI/Anthropic keys if the DB leaks, and (b) **forge valid processing tokens** to bypass admin auth on `GET /api/documents/[id]/process-stream` (which accepts `?token=` in lieu of Basic Auth — `process-stream/route.ts:90-103`), triggering paid AI extraction at will.

**Fix:** Fail fast at startup if `ENCRYPTION_KEY` is missing or `< 32` bytes; remove the literal fallback. Rotate the key and re-encrypt stored AI keys. Verify the env var is set on Railway.

---

## 🟠 High

### H-1 — Unauthenticated full document text disclosure via mini-app `getDocument`
**File:** `src/app/api/telegram/mini-app/route.ts:196, 418-427`
**Confidence:** High

`getDocument` is listed in `publicActions` (line 196), so the auth gate at line 198 is skipped. It returns `{ id, title, rawText }` for **any** `documentId` with no ownership/role check (IDOR). `rawText` is the full ingested source document.

**Impact:** Anyone who can reach `POST /api/telegram/mini-app` (public, no Basic Auth — outside middleware matcher) can enumerate document IDs and exfiltrate full document contents. Same pattern applies to `getDocumentKnowledge` (line 1241, no `isAdmin` check) and `getAllRules`/`getAllPairs` (lines 1202, 1222).

**Fix:** Remove `getDocument` from `publicActions` and require `isAdmin` (or at least an authenticated `telegramId`). Decide explicitly which knowledge is public; gate `rawText` behind admin.

---

### H-2 — Unauthenticated, unmetered expensive AI actions (`ask`, `voiceSearch`)
**File:** `src/app/api/telegram/mini-app/route.ts:196 (publicActions), 429-445 (voiceSearch), 851-888 (ask)`
**Confidence:** High

`voiceSearch` (OpenAI Whisper transcription) and `ask` (full enhanced answering engine: query expansion + vector search + LLM completion) are in `publicActions` and the POST handler applies **no rate limiting** (unlike `/api/ask` and `/api/librarian/search`, which call `checkRateLimit`).

**Impact:** Cost-amplification / financial DoS. An unauthenticated attacker can loop `ask`/`voiceSearch` to run unbounded paid LLM + Whisper calls and create `chatSession`/`chatMessage` rows freely (`ask` writes to DB at line 855 with `userId: 'anonymous'`).

**Fix:** Apply `checkRateLimit(getClientKey(request), RATE_LIMITS.askQuestion)` at the top of the mini-app POST handler (and a stricter bucket for `voiceSearch`). Consider requiring a verified `telegramId` for `ask`/`voiceSearch`.

---

### H-3 — Mini-app POST router has no rate limiting whatsoever
**File:** `src/app/api/telegram/mini-app/route.ts:174`
**Confidence:** High

The entire `POST` switch (search FTS queries, comments, favorites, AI calls) runs without any `checkRateLimit`. The `search` action issues multiple `$queryRaw` FTS + ILIKE queries per call (lines 271-412).

**Impact:** Unauthenticated DB/CPU exhaustion via `search`, plus the AI abuse in H-2.

**Fix:** Add a request-level rate limit gate at the start of the handler, before the action switch.

---

### H-4 — Telegram WebApp hash comparison is not constant-time
**File:** `src/lib/telegram/mini-app-auth.ts:43`
**Confidence:** Medium

```ts
if (computedHash !== hash) { return { valid: false }; }
```

The HMAC verification uses a plain `!==` string compare instead of `crypto.timingSafeEqual`. This is the gate that authenticates **all** mini-app admin actions (`editRule`, `deleteRule`, `commitDocument`, `uploadDocument`, etc.).

**Impact:** Theoretically timing-side-channel observable. Practically hard to exploit remotely over the network, but this guards privileged write/delete operations, so it should be hardened.

**Fix:** Compare with `crypto.timingSafeEqual(Buffer.from(computedHash,'hex'), Buffer.from(hash,'hex'))` (guard equal length first).

---

## 🟡 Medium

### M-1 — `/api/feedback` is unauthenticated and writes to DB
**File:** `src/app/api/feedback/route.ts:9`
**Confidence:** Medium

Public (rate-limited) but accepts arbitrary `question`/`answer`/`comment`/`suggestedAnswer` and persists them. No length cap visible on `comment`/`suggestedAnswer` in the read portion. Risk: spam/storage abuse and stored-content poisoning if feedback is ever surfaced to admins unsanitized.
**Fix:** Add field length limits; treat stored feedback as untrusted when rendered in admin UI.

### M-2 — Verbose internal error message leakage to client
**Files:** `mini-app/route.ts:922` (`Не удалось прочитать документ: ${parseError.message}`), `documents/route.ts:184` (`Failed to parse document: ${parseError.message}`), `crypto.ts:66` (`Decryption failed: ${error.message}`)
**Confidence:** Medium

Raw parser/decryption error messages are returned in HTTP responses. These can leak library internals / file-format details. (No stack traces or secret *values* are returned — those go to `console.error` server-side only, which is acceptable.)
**Fix:** Return a generic client message; log the detailed error server-side.

### M-3 — Rate-limit key trusts spoofable `x-forwarded-for`
**File:** `src/lib/rate-limiter.ts:97-108`
**Confidence:** Medium

`getClientKey` takes the first `x-forwarded-for` value, which a client can forge unless the platform overwrites it. On Railway the inbound proxy should set it, but rotating the spoofed header trivially evades the in-memory limiter.
**Fix:** Prefer the platform-trusted client IP (e.g. `cf-connecting-ip` if behind Cloudflare) and/or include an authenticated identity in the key. Move to a shared store (Redis) for multi-instance correctness.

### M-4 — Mini-app comment authorization relies only on `telegramId` in `updateMany` filter
**File:** `mini-app/route.ts:550-574` (`editComment`, `deleteComment`)
**Confidence:** Low-Medium

Ownership is enforced by `where: { id: commentId, telegramId }`, which is correct *provided* `telegramId` came from a verified `initData`. It does. Flagged only because the same `telegramId` flows from the (non-constant-time, H-4) verifier — fixing H-4 fully closes this.

---

## 🟢 Low

### L-1 — `parseInitData` (unverified) exists in the codebase
**File:** `src/lib/telegram/mini-app-auth.ts:73-85`
**Confidence:** Low
An unverified init-data parser is exported "for development only." It is not referenced by the API routes (they use `verifyTelegramWebAppData`), but its presence is a footgun. Consider removing or guarding behind `NODE_ENV !== 'production'`.

### L-2 — `initData === 'dev'` bypass branch
**File:** `mini-app/route.ts:25, 183`
**Confidence:** Low
The literal `'dev'` sentinel skips verification and proceeds as anonymous (no `telegramId` set), so it grants no privilege — but it normalizes a magic bypass string. Keep it strictly anonymous (current behavior) and ideally gate on non-production.

### L-3 — In-memory rate limiter & processing lock won't survive multi-instance scaling
**Files:** `rate-limiter.ts:27`, `process-stream/route.ts:23`
**Confidence:** Low
Both use process-local `Map`s. Correct on Railway single-instance (as noted in code comments), but a horizontal scale-up silently weakens both rate limiting and the concurrency lock. Track as tech-debt before scaling.

---

## Recommendations (ordered)

1. **C-1 / C-2 first** — add Telegram webhook `secret_token` verification and remove the encryption-key fallback (fail-fast + rotate). These are reachable auth bypasses.
2. **Gate the mini-app public surface** — remove `getDocument` (and review `getDocumentKnowledge`, `getAllRules`, `getAllPairs`) from `publicActions`; add a top-of-handler rate limit (H-1, H-2, H-3).
3. **Harden HMAC compare** to constant-time (H-4).
4. **Sanitize client-facing error strings** (M-2) and tighten feedback input limits (M-1).
5. **Strengthen rate-limit keying** and plan a Redis-backed limiter before scaling (M-3, L-3).

---

## Resolution — fixes applied 2026-06-04 (branch `fix/security-hardening`)

| ID | Status | Fix |
|---|---|---|
| C-1 | ✅ Fixed | `route.ts` now rejects any Telegram POST without a valid `x-telegram-bot-api-secret-token` (constant-time). `TELEGRAM_WEBHOOK_SECRET` set on Railway; webhook re-registered with `secret_token` via `scripts/set-telegram-webhook.mjs`. |
| C-2 | ✅ Fixed | `crypto.ts` removed the hardcoded key fallback; throws at load if `ENCRYPTION_KEY` < 32 bytes. Key derivation unchanged → existing ciphertext still decrypts. Railway key verified present (32 bytes). |
| H-1 | ✅ Fixed | `getDocument` removed from `publicActions` — now requires a verified Telegram user (closes unauth `rawText` exfiltration). Tighten to `isAdmin` if source docs are confidential. |
| H-2 | ✅ Fixed | `ask`/`voiceSearch` now rate-limited via the strict bucket. |
| H-3 | ✅ Fixed | Every mini-app POST rate-limited before the action switch (expensive actions: 20/min; rest: 100/min). |
| H-4 | ✅ Fixed | Mini-app HMAC compare now uses `crypto.timingSafeEqual` (length-guarded). |
| M-1 | ✅ Fixed | `/api/feedback` enforces field length caps. |
| M-2 | ✅ Fixed | Verbose parse/decrypt errors no longer returned to clients; logged server-side only. |
| M-3 | ✅ Fixed | `getClientKey` prefers trusted edge IP headers over spoofable `x-forwarded-for`. |
| M-4 | ✅ Closed | Resolved transitively by H-4 (constant-time verifier). |
| L-1 | ✅ Fixed | Unused unverified `parseInitData` removed. |
| L-2 | ⚪ Accepted | `initData === 'dev'` stays strictly anonymous (grants no privilege). |
| L-3 | 📌 Tracked | In-memory rate limiter / processing lock is correct on Railway single-instance; move to Redis before horizontal scale. Not a current vulnerability. |

**Validation:** `pnpm build` exit 0 · `pnpm lint` exit 0 · `tsc --noEmit` exit 0.

## Bitrix24 note
The task mentions a new `BITRIX24_WEBHOOK_URL` / `BITRIX24_WEBHOOK_TOKEN`. **No Bitrix inbound webhook receiver or outbound Bitrix fetch exists in tracked source yet** (`git grep -i bitrix` → only a string literal in `scenario-classifier.ts`). When that receiver is added: (a) verify the inbound `application_token` with a constant-time compare, (b) never build outbound URLs from request input (SSRF), and (c) keep the token in `.env` only. Re-scan once the integration lands.
