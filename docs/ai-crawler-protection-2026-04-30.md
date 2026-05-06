# AI Crawler Protection Audit - translation - 2026-04-30

## Project

- Project name: translation
- Domain: https://REPLACE_WITH_DOMAIN
- Framework: Next.js
- Project type: mixed public + private platform
- Risk score before: MEDIUM
- Risk score after: LOW

## Public Routes

- /
- /playground
- /telegram-app

## Protected Routes

- /admin
- /admin/ai-questions
- /admin/ai-settings
- /admin/documents
- /admin/documents/*/process
- /admin/domain-suggestions
- /admin/domains
- /admin/knowledge-changes
- /admin/qa
- /admin/rules
- /api/admin/ai-settings
- /api/admin/ai-settings/verify
- /api/admin/vector-search
- /api/ai-questions
- /api/ai-questions/*
- /api/ask
- /api/documents
- /api/documents/*
- /api/documents/*/commit
- /api/documents/*/process-stream
- /api/documents/*/quality
- /api/documents/*/staged
- /api/documents/*/token
- /api/domain-suggestions
- /api/domain-suggestions/*
- /api/domains
- /api/feedback
- /api/health/ai
- /api/knowledge-changes
- /api/librarian/health
- /api/librarian/ingest
- /api/librarian/search
- /api/qa
- /api/rules
- /api/rules/*
- /api/telegram
- /api/telegram/mini-app
- /api/test-sse

Baseline protected prefixes for any deployed service: /api/, /admin/, /dashboard/, /app/, /account/, /settings/, /internal/, /private/, /export/, /reports/, /analytics/, /uploads/, /console/, /paper/, /research/, /strategies/, /markets/, /reversal/

## Existing Controls

- robots.txt: present
- sitemap.xml or sitemap route: missing/not detected
- llms.txt: present
- middleware/auth/rate-limit files detected: 8


## Sensitive Data Surfaces

### API endpoints and route handlers

- src/app/api/admin/ai-settings/route.ts
- src/app/api/admin/ai-settings/verify/route.ts
- src/app/api/admin/vector-search/route.ts
- src/app/api/ai-questions/route.ts
- src/app/api/ai-questions/[id]/route.ts
- src/app/api/ask/route.ts
- src/app/api/documents/route.ts
- src/app/api/documents/[id]/commit/route.ts
- src/app/api/documents/[id]/process-stream/route.ts
- src/app/api/documents/[id]/quality/route.ts
- src/app/api/documents/[id]/route.ts
- src/app/api/documents/[id]/staged/route.ts
- src/app/api/documents/[id]/token/route.ts
- src/app/api/domain-suggestions/route.ts
- src/app/api/domain-suggestions/[id]/route.ts
- src/app/api/domains/route.ts
- src/app/api/feedback/route.ts
- src/app/api/health/ai/route.ts
- src/app/api/knowledge-changes/route.ts
- src/app/api/librarian/health/route.ts
- src/app/api/librarian/ingest/route.ts
- src/app/api/librarian/search/route.ts
- src/app/api/qa/route.ts
- src/app/api/rules/route.ts
- src/app/api/rules/[id]/route.ts
- src/app/api/telegram/mini-app/route.ts
- src/app/api/telegram/route.ts
- src/app/api/test-sse/route.ts

### Middleware/auth/rate-limit indicators

- .claude/sessions/2026-02-06-session2.md
- docs/2026-01-21_SESSION_NOTES_librarian_deployment.md
- SESSION_2026-01-20_streaming-processing-memory-optimization.md
- SESSION_NOTES.md
- src/lib/auth.ts
- src/lib/rate-limiter.ts
- src/lib/telegram/mini-app-auth.ts
- src/middleware.ts

### Export/download/upload/report indicators

- documents/Вопросы менеджеров.xlsx
- playwright-report/data/7a33d5db6370b6de345e990751aa1f1da65ad675.png
- playwright-report/index.html
- sample/Вопросы менеджеров.xlsx
- test-results/full-upload-test-Full-Docu-284cf-verify-knowledge-extraction-chromium/test-finished-1.png
- tests/full-upload-test.spec.ts
- tests/production-upload-test.spec.ts
- tmp-upload/apostille-report.txt
- tmp-upload/ask-apostil-raw.json
- tmp-upload/ask-apostil.json
- tmp-upload/ask-payload.json
- tmp-upload/ask-t1.json
- tmp-upload/ask-t2.json
- tmp-upload/battery-raw.json
- tmp-upload/battery-report.md
- tmp-upload/battery-v2-backup.json
- tmp-upload/battery-v2-raw.json
- tmp-upload/battery-v2-report.md
- tmp-upload/check-users.mjs
- tmp-upload/deploy-check.json
- tmp-upload/miniapp-docs-tab.png
- tmp-upload/miniapp-tabs.png
- tmp-upload/post-deploy-check.json
- tmp-upload/t1-response.json
- tmp-upload/t2-response.json
- tmp-upload/t2-v3.json
- tmp-upload/test-normalize.mjs
- tmp-upload/test-qa.mjs
- tmp-upload/test_docs_tab.py
- tmp-upload/Инструкция отправкой почтой РФ.docx
- tmp-upload/Инструкция_по_взаимодействию_с_Наливайко_офис_в_Шушарах.docx
- tmp-upload/Инструкция_по_выдаче_и_хранению_заказов.docx
- tmp-upload/Инструкция_по_запуску_заказа_в_работу.docx
- tmp-upload/Инструкция_по_обработке_запросов_КП.docx
- tmp-upload/Инструкция_по_приему_заказа_личных_документов_при_переводе_с_молдавского.docx
- tmp-upload/Инструкция_по_расчету_машинного_перевода.docx
- tmp-upload/Инструкция_по_сохранению_исходников_и_сканов.docx
- tmp-upload/Регламент оплаты ЮЛ.docx
- tmp-upload/Согласие_на_молдавский_румынский.docx

### Large data/blob indicators

- src/app/admin/documents/page.tsx
- src/app/api/documents/[id]/process-stream/route.ts
- src/app/playground/page.tsx
- src/app/telegram-app/page.tsx
- src/components/document-processor/LiveTerminal.tsx
- src/generated/prisma/runtime/client.js
- src/generated/prisma/runtime/wasm-compiler-edge.js
- src/hooks/useDocumentProcessing.ts

### Production source-map indicators

- No production source-map enablement detected.

## Files Changed

- public/robots.txt
- public/llms.txt
- docs/ai-crawler-protection-2026-04-30.md

## Cloudflare Settings Needed

- Put the domain behind the Cloudflare orange-cloud proxy.
- Enable WAF and Bot protection/Bot Management where available.
- Enable AI Crawl Control and review the Crawlers, Metrics, and Robots.txt tabs.
- Allow verified Googlebot, Bingbot, YandexBot, and OAI-SearchBot on public SEO pages.
- Block GPTBot, ClaudeBot, CCBot, Bytespider, Meta-ExternalAgent, PerplexityBot, Amazonbot, Applebot-Extended, and Google-Extended.
- Enable AI Labyrinth for suspicious crawler behavior and robots.txt violators where appropriate.
- Add WAF custom rules:
  - Managed Challenge or block requests to protected route prefixes when unauthenticated.
  - Rate-limit /search, /api/search, /export, /download, and detail/listing endpoints.
  - Challenge unknown high-rate bots, sequential ID enumeration, and headless browser fingerprints.
- Monitor IP, user-agent, ASN, country, path, rate, status, auth state, referrer, public/private route class, and bot-like behavior.

Suggested WAF expression templates:

```text
# Block AI training / bulk crawlers globally.
(lower(http.user_agent) contains "gptbot" or lower(http.user_agent) contains "claudebot" or lower(http.user_agent) contains "claude-user" or lower(http.user_agent) contains "google-extended" or lower(http.user_agent) contains "applebot-extended" or lower(http.user_agent) contains "ccbot" or lower(http.user_agent) contains "bytespider" or lower(http.user_agent) contains "meta-externalagent" or lower(http.user_agent) contains "perplexitybot" or lower(http.user_agent) contains "amazonbot")

# Challenge unauthenticated access to protected routes.
((http.request.uri.path wildcard "/api/*" or http.request.uri.path wildcard "/admin/*" or http.request.uri.path wildcard "/dashboard/*" or http.request.uri.path wildcard "/app/*" or http.request.uri.path wildcard "/account/*" or http.request.uri.path wildcard "/settings/*" or http.request.uri.path wildcard "/internal/*" or http.request.uri.path wildcard "/private/*" or http.request.uri.path wildcard "/export/*" or http.request.uri.path wildcard "/reports/*" or http.request.uri.path wildcard "/analytics/*") and not http.cookie contains "REPLACE_WITH_SESSION_COOKIE=")

# Do not challenge known discovery crawlers on public pages.
(cf.client.bot and (lower(http.user_agent) contains "googlebot" or lower(http.user_agent) contains "bingbot" or lower(http.user_agent) contains "yandex" or lower(http.user_agent) contains "oai-searchbot") and not (http.request.uri.path wildcard "/api/*" or http.request.uri.path wildcard "/admin/*" or http.request.uri.path wildcard "/dashboard/*" or http.request.uri.path wildcard "/app/*" or http.request.uri.path wildcard "/account/*" or http.request.uri.path wildcard "/settings/*" or http.request.uri.path wildcard "/internal/*" or http.request.uri.path wildcard "/private/*" or http.request.uri.path wildcard "/export/*" or http.request.uri.path wildcard "/reports/*" or http.request.uri.path wildcard "/analytics/*"))
```


## Route-Level Protection Requirements

- /admin/* must require admin authentication.
- /dashboard/*, /app/*, /account/*, /settings/*, /reports/*, and /analytics/* must require authenticated users.
- /api/private/*, /api/admin/*, /api/export/*, and write APIs must require server-side auth.
- Listing/search APIs must enforce max limits, bounded pagination, and rate limits.
- Export/download endpoints must require auth, rate limits, audit logging, and business justification.
- Do not expose private database-shaped JSON, internal route maps, pricing engines, or full datasets in frontend HTML.
- Disable production browser source maps unless explicitly needed and access-controlled.

## Terms Clause To Add Or Verify

Automated scraping, crawling, extraction, reverse engineering, dataset creation, AI training, replication of UI flows, replication of business logic, and cloning of this platform are prohibited without prior written permission.

Search engine indexing of public marketing pages is permitted. Access to private, authenticated, API, dashboard, admin, export, and analytics areas by automated systems is prohibited.

## Verification Results

- Static scan completed locally on 2026-04-30.
- robots.txt: created if missing, or existing framework/static implementation left in place for manual review
- sitemap.xml: not detected; add/generate once canonical production domain is confirmed
- llms.txt: created if missing
- Live curl verification: not run for this repo unless a production domain was known and network target was safe to probe.


Suggested live checks:

```bash
curl -I https://REPLACE_WITH_DOMAIN/robots.txt
curl -I https://REPLACE_WITH_DOMAIN/sitemap.xml
curl -I https://REPLACE_WITH_DOMAIN/llms.txt
curl -A "OAI-SearchBot" https://REPLACE_WITH_DOMAIN/
curl -A "GPTBot" https://REPLACE_WITH_DOMAIN/
curl -A "ClaudeBot" https://REPLACE_WITH_DOMAIN/
curl -A "Googlebot" https://REPLACE_WITH_DOMAIN/
curl -A "BadBot" https://REPLACE_WITH_DOMAIN/api/private
```

## Remaining TODOs

- Replace REPLACE_WITH_DOMAIN / REPLACE_WITH_CONTACT_EMAIL placeholders where present.
- Confirm the production domain and sitemap generation for any repo marked missing sitemap.
- Manually review API handlers listed above for auth, pagination bounds, and rate limits.
- Configure Cloudflare enforcement; robots.txt and llms.txt are policy signals, not security controls.
- Add crawler/security monitoring dashboards and alerts for high 404s, ID enumeration, rapid pagination, repeated exports, unauthenticated API probing, and UA rotation.
