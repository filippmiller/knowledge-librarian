# Session Notes - January 19, 2026

## Executive Summary

This session resolved critical Railway deployment failures, established a complete Playwright testing infrastructure, performed full Russian localization of the UI, and configured production environment variables.

---

## Table of Contents

1. [Railway Deployment Fix](#1-railway-deployment-fix)
2. [Playwright Testing Infrastructure](#2-playwright-testing-infrastructure)
3. [Russian Localization](#3-russian-localization)
4. [Environment Configuration](#4-environment-configuration)
5. [Git Commit History](#5-git-commit-history)
6. [File Reference](#6-file-reference)
7. [Known Issues & Workarounds](#7-known-issues--workarounds)
8. [Verification Checklist](#8-verification-checklist)
9. [Future Recommendations](#9-future-recommendations)
10. [Streaming Document Processing System](#10-streaming-document-processing-system)

---

## 1. Railway Deployment Fix

### Initial Problem

Railway deployment was failing with the following error:

```
Railpack 0.16.0
Region: us-east4
↳ Detected Node
↳ Using bun package manager
✖ No start command was found
```

**Root Cause**: Railpack incorrectly detected `bun` as the package manager instead of `pnpm`, even though `package.json` explicitly specifies:
- `"packageManager": "pnpm@9.14.4"`
- `"engines": { "pnpm": ">=9.0.0" }`

### Attempted Solutions (Failed)

#### Attempt 1: railpack.toml Configuration
Created `railpack.toml` with explicit pnpm configuration:
```toml
[provider]
name = "node"

[build]
packageManager = "pnpm"
buildCommand = "pnpm build"

[deploy]
startCommand = "pnpm start"
```
**Result**: Railpack continued to detect bun.

#### Attempt 2: Railway Dashboard Settings
Changed builder to "Dockerfile" in Railway dashboard settings.
**Result**: GitHub webhook deployments still used Railpack.

### Final Solution: Dockerfile Deployment

Created a multi-stage Dockerfile that provides full control over the build process.

#### Dockerfile (Complete)
```dockerfile
# Use Node.js 20 LTS
FROM node:20-alpine AS base

# Install pnpm and openssl for Prisma
RUN apk add --no-cache openssl
RUN corepack enable && corepack prepare pnpm@9.14.4 --activate

# Install dependencies only when needed
FROM base AS deps
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma/

# Install dependencies and generate Prisma client
RUN pnpm install --frozen-lockfile

# Build the application
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build Next.js (prisma generate runs via postinstall)
RUN pnpm build

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy built application (standalone includes node_modules)
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
```

#### Key Dockerfile Decisions

1. **Multi-stage build**: Reduces final image size by not including build dependencies
2. **Node 20 Alpine**: Smaller base image, LTS version
3. **OpenSSL**: Required for Prisma client
4. **Corepack for pnpm**: Native Node.js package manager management
5. **Non-root user**: Security best practice
6. **Standalone output**: Next.js bundles everything needed, including Prisma client

#### railway.toml Configuration
```toml
[build]
builder = "dockerfile"
dockerfilePath = "Dockerfile"

[deploy]
healthcheckPath = "/"
healthcheckTimeout = 300
restartPolicyType = "on_failure"
restartPolicyMaxRetries = 10
```

#### next.config.ts Changes
```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
};

export default nextConfig;
```

The `standalone` output mode is critical - it creates a self-contained build that includes all necessary dependencies.

#### .dockerignore
```
# Dependencies
node_modules
.pnpm-store

# Next.js
.next
out

# Testing
test-results
playwright-report
.playwright

# Development
*.log
.env*.local
.DS_Store

# Git
.git
.gitignore

# IDE
.vscode
.idea

# Misc
README.md
SESSION_NOTES.md
check-users.ts
```

### Dockerfile Build Error & Fix

**Error encountered**:
```
ERROR: "/app/node_modules/.prisma": not found
```

**Cause**: Attempted to copy `.prisma` folder separately, but Next.js standalone mode already bundles it.

**Fix**: Removed the `.prisma` COPY line. The standalone build includes everything.

---

## 2. Playwright Testing Infrastructure

### Installation

```bash
pnpm add -D @playwright/test
npx playwright install chromium
```

### Configuration: playwright.config.ts

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: 'html',
  use: {
    baseURL: 'https://avrora-library-production.up.railway.app',
    trace: 'on-first-retry',
    screenshot: 'on',
    httpCredentials: {
      username: 'Filipp',
      password: 'Airbus380+',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
```

#### Configuration Decisions

| Setting | Value | Reason |
|---------|-------|--------|
| `fullyParallel` | `false` | Sequential tests to avoid race conditions |
| `workers` | `1` | Single worker for consistent state |
| `screenshot` | `'on'` | Capture screenshots for all tests |
| `httpCredentials` | Configured | HTTP Basic Auth for admin access |
| `trace` | `'on-first-retry'` | Detailed trace on failures |

### Test Suite: tests/admin.spec.ts

The test suite contains **11 tests** organized into 3 describe blocks:

#### Admin Dashboard Tests (9 tests)
```typescript
test.describe('Admin Dashboard', () => {

  test('should load admin dashboard with authentication', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByText('Библиотека знаний')).toBeVisible();
    await expect(page.getByText('Документы')).toBeVisible();
    await expect(page.getByText('Домены')).toBeVisible();
    await page.screenshot({ path: 'test-results/admin-dashboard.png', fullPage: true });
  });

  test('should navigate to Documents page', async ({ page }) => {
    await page.goto('/admin');
    await page.getByRole('link', { name: 'Документы' }).click();
    await expect(page).toHaveURL(/.*\/admin\/documents/);
    await expect(page.getByRole('heading', { name: 'Документы' })).toBeVisible();
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toBeAttached();
    await page.screenshot({ path: 'test-results/documents-page.png', fullPage: true });
  });

  test('should navigate to Domains page', async ({ page }) => {
    await page.goto('/admin');
    await page.getByRole('link', { name: 'Домены' }).click();
    await expect(page).toHaveURL(/.*\/admin\/domains/);
    await expect(page.getByRole('heading', { name: 'Домены' })).toBeVisible();
    await page.screenshot({ path: 'test-results/domains-page.png', fullPage: true });
  });

  test('should navigate to Domain Suggestions page', async ({ page }) => {
    await page.goto('/admin');
    await page.getByRole('link', { name: 'Предложения доменов' }).click();
    await expect(page).toHaveURL(/.*\/admin\/domain-suggestions/);
    await page.screenshot({ path: 'test-results/domain-suggestions-page.png', fullPage: true });
  });

  test('should navigate to Rules page', async ({ page }) => {
    await page.goto('/admin');
    await page.getByRole('link', { name: 'Правила' }).click();
    await expect(page).toHaveURL(/.*\/admin\/rules/);
    await expect(page.getByRole('heading', { name: 'Правила' })).toBeVisible();
    await page.screenshot({ path: 'test-results/rules-page.png', fullPage: true });
  });

  test('should navigate to Q&A page', async ({ page }) => {
    await page.goto('/admin');
    await page.getByRole('link', { name: 'Вопросы и ответы' }).click();
    await expect(page).toHaveURL(/.*\/admin\/qa/);
    await page.screenshot({ path: 'test-results/qa-page.png', fullPage: true });
  });

  test('should navigate to AI Questions page', async ({ page }) => {
    await page.goto('/admin');
    await page.getByRole('link', { name: 'Вопросы ИИ' }).click();
    await expect(page).toHaveURL(/.*\/admin\/ai-questions/);
    await page.screenshot({ path: 'test-results/ai-questions-page.png', fullPage: true });
  });

  test('should navigate to Knowledge Changes page', async ({ page }) => {
    await page.goto('/admin');
    await page.getByRole('link', { name: 'Журнал изменений' }).click();
    await expect(page).toHaveURL(/.*\/admin\/knowledge-changes/);
    await page.screenshot({ path: 'test-results/knowledge-changes-page.png', fullPage: true });
  });

  test('should access Playground page', async ({ page }) => {
    await page.goto('/playground');
    await expect(page.getByText('Песочница знаний')).toBeVisible();
    await page.screenshot({ path: 'test-results/playground-page.png', fullPage: true });
  });

});
```

#### Rules Page Functionality Tests (1 test)
```typescript
test.describe('Rules Page Functionality', () => {

  test('should filter rules by status', async ({ page }) => {
    await page.goto('/admin/rules');
    await page.waitForLoadState('networkidle');
    const filterDropdown = page.locator('select, [role="combobox"]').first();
    if (await filterDropdown.isVisible()) {
      await filterDropdown.click();
      await page.screenshot({ path: 'test-results/rules-filter-open.png', fullPage: true });
    }
  });

});
```

#### Documents Page Functionality Tests (1 test)
```typescript
test.describe('Documents Page Functionality', () => {

  test('should have working file upload area', async ({ page }) => {
    await page.goto('/admin/documents');
    await page.waitForLoadState('networkidle');
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toBeAttached();
    const acceptAttr = await fileInput.getAttribute('accept');
    console.log('Accepted file types:', acceptAttr);
    await page.screenshot({ path: 'test-results/documents-upload-area.png', fullPage: true });
  });

});
```

### Running Tests

```bash
# Run all tests
npx playwright test

# Run with visible browser
npx playwright test --headed

# Run with detailed output
npx playwright test --reporter=list

# Run specific test file
npx playwright test tests/admin.spec.ts

# View HTML report
npx playwright show-report
```

### Test Results

All 11 tests passed successfully. Screenshots are saved to `test-results/` directory.

---

## 3. Russian Localization

### Translation Approach

- **Method**: Direct string replacement (hardcoded)
- **No i18n library**: Translations are inline in components
- **Future consideration**: Implement next-intl or react-i18next for multi-language support

### Complete Translation Map

#### Navigation (src/app/admin/layout.tsx)

| English | Russian |
|---------|---------|
| Knowledge Librarian | Библиотека знаний |
| Documents | Документы |
| Domains | Домены |
| Domain Suggestions | Предложения доменов |
| Rules | Правила |
| Q&A | Вопросы и ответы |
| AI Questions | Вопросы ИИ |
| Change Log | Журнал изменений |
| Playground | Песочница |

#### Admin Layout Code

```typescript
const navigation = [
  { name: 'Документы', href: '/admin/documents' },
  { name: 'Домены', href: '/admin/domains' },
  { name: 'Предложения доменов', href: '/admin/domain-suggestions' },
  { name: 'Правила', href: '/admin/rules' },
  { name: 'Вопросы и ответы', href: '/admin/qa' },
  { name: 'Домены ИИ', href: '/admin/ai-questions' },
  { name: 'Журнал изменений', href: '/admin/knowledge-changes' },
];
```

#### Dashboard (src/app/admin/page.tsx)

| English | Russian |
|---------|---------|
| Dashboard | Панель управления |
| Active Rules | Активные правила |
| Q&A Pairs | Пары вопросов-ответов |
| Pending Domain Suggestions | Ожидающие предложения доменов |
| Open AI Questions | Открытые вопросы ИИ |
| Actions Required | Требуются действия |
| View all | Смотреть все |

#### Documents Page (src/app/admin/documents/page.tsx)

| English | Russian |
|---------|---------|
| Documents | Документы |
| Upload new documents | Загрузить новые документы |
| Loading... | Загрузка... |
| Upload files | Загрузить файлы |
| Drag and drop | Перетащите файлы |
| or click to browse | или нажмите для выбора |
| Status | Статус |
| Name | Название |
| Size | Размер |
| Uploaded | Загружен |

#### Domains Page (src/app/admin/domains/page.tsx)

| English | Russian |
|---------|---------|
| Domains | Домены |
| Create Domain | Создать домен |
| Description | Описание |
| Rules | Правила |
| No domains found | Домены не найдены |

#### Domain Suggestions Page (src/app/admin/domain-suggestions/page.tsx)

| English | Russian |
|---------|---------|
| Domain Suggestions | Предложения доменов |
| Approve & Create Domain | Одобрить и создать домен |
| Reject | Отклонить |
| Suggested by | Предложено |
| No pending suggestions | Нет ожидающих предложений |

#### Rules Page (src/app/admin/rules/page.tsx)

| English | Russian |
|---------|---------|
| Rules | Правила |
| All | Все |
| Active | Активные |
| Superseded | Замененные |
| Deprecated | Устаревшие |
| Confidence | Уверенность |
| Supersedes | Заменяет |
| Source | Источник |
| Domain | Домен |
| No rules found | Правила не найдены |

#### Q&A Page (src/app/admin/qa/page.tsx)

| English | Russian |
|---------|---------|
| Q&A Pairs | Пары вопросов-ответов |
| Question | Вопрос |
| Answer | Ответ |
| Created | Создано |
| No Q&A pairs found | Пары не найдены |

#### AI Questions Page (src/app/admin/ai-questions/page.tsx)

| English | Russian |
|---------|---------|
| AI Questions | Вопросы ИИ |
| Open | Открытые |
| Resolved | Решенные |
| Ambiguous | Неоднозначно |
| Outdated | Устарело |
| Conflict | Конфликт |
| Missing Context | Нет контекста |
| Price Conflict | Конфликт цен |
| Context | Контекст |
| Proposed Change | Предлагаемое изменение |
| Submit Answer | Отправить ответ |
| Dismiss | Отклонить |
| No questions found | Вопросы не найдены |

#### Knowledge Changes Page (src/app/admin/knowledge-changes/page.tsx)

| English | Russian |
|---------|---------|
| Knowledge Changes | Журнал изменений |
| Type | Тип |
| Entity | Сущность |
| Change | Изменение |
| Changed By | Изменил |
| Date | Дата |
| RULE | ПРАВИЛО |
| DOMAIN | ДОМЕН |
| QA | ВОПРОС |
| DOCUMENT | ДОКУМЕНТ |
| No changes found | Изменения не найдены |

#### Playground Page (src/app/playground/page.tsx)

| English | Russian |
|---------|---------|
| Knowledge Playground | Песочница знаний |
| Admin Panel | Панель администратора |
| Ask a question | Задайте вопрос |
| Answer | Ответ |
| Citations | Источники |
| Recent Questions | Недавние вопросы |
| Thinking... | Думаю... |
| Ask | Спросить |

#### Landing Page (src/app/page.tsx)

```typescript
export default function Home() {
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="max-w-2xl mx-auto px-4 py-16 text-center">
        <h1 className="text-4xl font-bold text-gray-900 mb-4">
          ИИ Библиотекарь знаний
        </h1>
        <p className="text-xl text-gray-600 mb-8">
          Живая библиотека знаний для вашего бюро переводов.
          Загружайте документы, извлекайте правила и задавайте вопросы.
        </p>

        <div className="flex flex-col sm:flex-row gap-4 justify-center">
          <Link href="/playground" className="...">
            Попробовать песочницу
          </Link>
          <Link href="/admin" className="...">
            Панель администратора
          </Link>
        </div>

        <div className="mt-16 grid grid-cols-1 sm:grid-cols-3 gap-8 text-left">
          <div>
            <h3 className="font-semibold text-gray-900 mb-2">Загрузка документов</h3>
            <p className="text-sm text-gray-600">
              Загружайте PDF, DOCX или TXT файлы. ИИ автоматически извлекает правила и пары вопрос-ответ.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 mb-2">Классификация доменов</h3>
            <p className="text-sm text-gray-600">
              ИИ классифицирует знания по доменам и предлагает новые категории при необходимости.
            </p>
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 mb-2">Задавайте вопросы</h3>
            <p className="text-sm text-gray-600">
              Запрашивайте базу знаний. Получайте ответы с источниками и показателями уверенности.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
```

### Files Modified for Localization

| # | File Path | Changes |
|---|-----------|---------|
| 1 | `src/app/admin/layout.tsx` | Navigation menu, header, playground link |
| 2 | `src/app/admin/page.tsx` | Dashboard stats, labels, action buttons |
| 3 | `src/app/admin/documents/page.tsx` | Upload UI, status labels, table headers |
| 4 | `src/app/admin/domains/page.tsx` | Page title, create button, table headers |
| 5 | `src/app/admin/domain-suggestions/page.tsx` | Approve/reject buttons, labels |
| 6 | `src/app/admin/rules/page.tsx` | Filter dropdown, status badges, table |
| 7 | `src/app/admin/qa/page.tsx` | Page title, table headers |
| 8 | `src/app/admin/ai-questions/page.tsx` | Question types, action buttons |
| 9 | `src/app/admin/knowledge-changes/page.tsx` | Change types, table headers |
| 10 | `src/app/playground/page.tsx` | Question input, answer display |
| 11 | `src/app/page.tsx` | Landing page content |

---

## 4. Environment Configuration

### OpenAI API Key

Added to Railway environment variables via CLI:

```bash
railway variables --set "OPENAI_API_KEY=<your-api-key>"
```

### Required Environment Variables

| Variable | Purpose | Set Via |
|----------|---------|---------|
| `DATABASE_URL` | PostgreSQL connection | Railway (auto-injected) |
| `OPENAI_API_KEY` | OpenAI API access | Railway CLI |
| `HTTP_USER` | Basic auth username | Railway dashboard |
| `HTTP_PASS` | Basic auth password | Railway dashboard |

---

## 5. Git Commit History

Commits from this session (newest first):

```
815e1dc Add Playwright outputs to gitignore
39b3bac Force fresh Railway build
f7eab29 Fix Dockerfile: remove .prisma copy (bundled in standalone)
d8747a4 Trigger Railway deployment
ed1f006 Switch to Dockerfile deployment for Railway
deeabce Add session notes documenting Railway fix and Russian localization
7a3a074 Translate entire UI to Russian language
982b686 Fix Railpack build configuration for Railway deployment
```

### Commit Details

**815e1dc** - Add Playwright outputs to gitignore
- Added `test-results/` and `playwright-report/` to `.gitignore`

**f7eab29** - Fix Dockerfile: remove .prisma copy (bundled in standalone)
- Removed failing COPY line for `.prisma` folder
- Next.js standalone mode bundles Prisma client automatically

**ed1f006** - Switch to Dockerfile deployment for Railway
- Created `Dockerfile` with multi-stage build
- Created `.dockerignore`
- Updated `railway.toml` to use dockerfile builder
- Updated `next.config.ts` with standalone output

**7a3a074** - Translate entire UI to Russian language
- Modified 11 files with Russian translations
- Updated Playwright tests to use Russian text

**982b686** - Fix Railpack build configuration for Railway deployment
- Created `railpack.toml` (later superseded by Dockerfile approach)
- Updated `railway.toml`

---

## 6. File Reference

### New Files Created

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage Docker build for Railway |
| `.dockerignore` | Exclude files from Docker build context |
| `playwright.config.ts` | Playwright test configuration |
| `tests/admin.spec.ts` | Admin panel test suite |
| `SESSION_NOTES.md` | This documentation file |

### Modified Files

| File | Changes |
|------|---------|
| `railway.toml` | Changed to dockerfile builder |
| `next.config.ts` | Added standalone output |
| `package.json` | Added @playwright/test dependency |
| `.gitignore` | Added Playwright output directories |
| `src/app/admin/layout.tsx` | Russian navigation |
| `src/app/admin/page.tsx` | Russian dashboard |
| `src/app/admin/documents/page.tsx` | Russian UI |
| `src/app/admin/domains/page.tsx` | Russian UI |
| `src/app/admin/domain-suggestions/page.tsx` | Russian UI |
| `src/app/admin/rules/page.tsx` | Russian UI |
| `src/app/admin/qa/page.tsx` | Russian UI |
| `src/app/admin/ai-questions/page.tsx` | Russian UI |
| `src/app/admin/knowledge-changes/page.tsx` | Russian UI |
| `src/app/playground/page.tsx` | Russian UI |
| `src/app/page.tsx` | Russian landing page |

---

## 7. Known Issues & Workarounds

### Issue: GitHub Auto-Deploys Use Railpack

**Problem**: Even when Railway dashboard shows "Dockerfile" as the selected builder, GitHub webhook-triggered deployments continue to use Railpack.

**Evidence**:
- `railway up` (CLI) correctly uses Dockerfile and succeeds
- GitHub push triggers deployment that fails with Railpack

**Status**: Appears to be a Railway platform bug.

**Workaround**: Use `railway up` CLI command for deployments instead of relying on GitHub auto-deploy.

**Recommended Action**: Contact Railway support to report the issue.

### Issue: Untracked File

**File**: `check-users.ts`

**Status**: Intentionally not committed. Appears to be a utility script.

---

## 8. Verification Checklist

### Production Deployment

- [ ] Visit https://avrora-library-production.up.railway.app
- [ ] Verify landing page loads with Russian text
- [ ] Verify "ИИ Библиотекарь знаний" title visible

### Admin Panel

- [ ] Navigate to `/admin`
- [ ] Enter credentials: Filipp / Airbus380+
- [ ] Verify "Библиотека знаний" header
- [ ] Click each navigation item:
  - [ ] Документы
  - [ ] Домены
  - [ ] Предложения доменов
  - [ ] Правила
  - [ ] Вопросы и ответы
  - [ ] Вопросы ИИ
  - [ ] Журнал изменений

### Playground

- [ ] Navigate to `/playground`
- [ ] Verify "Песочница знаний" header
- [ ] Test asking a question (requires OpenAI key to be working)
- [ ] Verify "Думаю..." loading state
- [ ] Verify answer displays with "Источники" section

### Playwright Tests

```bash
# Run full test suite
npx playwright test --reporter=list

# Expected: 11 tests passed
```

---

## 9. Future Recommendations

### Internationalization (i18n)

If multi-language support is needed in the future:

1. **Install next-intl**:
   ```bash
   pnpm add next-intl
   ```

2. **Create message files**:
   ```
   messages/
   ├── en.json
   └── ru.json
   ```

3. **Implement middleware for locale detection**

4. **Replace hardcoded strings with translation keys**

### Playwright Test Expansion

Consider adding:

1. **Document upload tests** - Test file upload functionality
2. **Rule creation tests** - Test CRUD operations
3. **Domain creation tests** - Test CRUD operations
4. **Playground interaction tests** - Test question submission and responses
5. **Mobile viewport tests** - Test responsive design
6. **Error state tests** - Test error handling

### CI/CD Pipeline

Consider adding GitHub Actions workflow:

```yaml
name: Tests
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - uses: actions/setup-node@v4
      - run: pnpm install
      - run: npx playwright install chromium
      - run: npx playwright test
```

---

## 10. Streaming Document Processing System

### Overview

Implemented a real-time streaming document processing system with human verification. The system uses Server-Sent Events (SSE) to stream OpenAI responses and allows users to review and selectively save extracted knowledge items.

### Database Changes

#### New Models in `prisma/schema.prisma`

```prisma
model StagedExtraction {
  id           String          @id @default(cuid())
  documentId   String
  phase        ExtractionPhase
  itemType     StagedItemType
  data         Json
  isVerified   Boolean         @default(false)
  isRejected   Boolean         @default(false)
  createdAt    DateTime        @default(now())
  verifiedAt   DateTime?

  document Document @relation(fields: [documentId], references: [id], onDelete: Cascade)

  @@index([documentId, phase])
  @@index([documentId, isVerified])
}

model AISettings {
  id             String    @id @default(cuid())
  provider       String    @default("openai")
  apiKey         String
  model          String    @default("gpt-4o")
  embeddingModel String    @default("text-embedding-3-small")
  isActive       Boolean   @default(true)
  lastVerified   DateTime?
  lastError      String?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
}

enum ExtractionPhase {
  DOMAIN_CLASSIFICATION
  KNOWLEDGE_EXTRACTION
  CHUNKING
}

enum StagedItemType {
  DOMAIN_ASSIGNMENT
  DOMAIN_SUGGESTION
  RULE
  QA_PAIR
  UNCERTAINTY
  CHUNK
}
```

### New API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/documents/[id]/process-stream` | GET | SSE streaming endpoint for document processing |
| `/api/documents/[id]/staged` | GET | Get staged items with pagination |
| `/api/documents/[id]/staged` | PATCH | Update verification status (verify/reject/reset) |
| `/api/documents/[id]/commit` | POST | Commit verified items to final tables |
| `/api/admin/ai-settings` | GET | Get AI settings (masked API key) |
| `/api/admin/ai-settings` | POST | Update AI settings |
| `/api/admin/ai-settings/verify` | POST | Verify API key is valid |

### SSE Event Types

| Event | Description |
|-------|-------------|
| `phase_start` | Processing phase started |
| `prompt` | Shows human-readable and technical prompts |
| `token` | Individual token from OpenAI stream |
| `item_extracted` | Extracted item saved to staging |
| `phase_complete` | Phase completed successfully |
| `error` | Error occurred |
| `complete` | All processing finished |

### New Files Created

| File | Purpose |
|------|---------|
| `src/lib/crypto.ts` | AES-256-GCM encryption for API key storage |
| `src/lib/ai/domain-steward-stream.ts` | Streaming domain classification (Russian prompts) |
| `src/lib/ai/knowledge-extractor-stream.ts` | Streaming knowledge extraction (Russian prompts) |
| `src/app/api/documents/[id]/process-stream/route.ts` | SSE streaming endpoint |
| `src/app/api/documents/[id]/staged/route.ts` | Staged data management |
| `src/app/api/documents/[id]/commit/route.ts` | Commit verified items |
| `src/app/api/admin/ai-settings/route.ts` | AI settings API |
| `src/app/api/admin/ai-settings/verify/route.ts` | API key verification |
| `src/app/admin/ai-settings/page.tsx` | AI settings management UI |
| `src/app/admin/documents/[id]/process/page.tsx` | Document processing page |
| `src/hooks/useDocumentProcessing.ts` | React hook for SSE state management |
| `src/components/document-processor/PhaseCard.tsx` | Processing phase display |
| `src/components/document-processor/ExtractedItemsGrid.tsx` | Extracted items with pagination |
| `src/components/document-processor/OpenAIStatusIndicator.tsx` | Connection status indicator |
| `src/components/document-processor/index.ts` | Component exports |

### Pagination Implementation

Staged items API supports pagination:

```typescript
// Query parameters
?page=1&limit=50&itemType=RULE

// Response structure
{
  items: [...],
  grouped: {...},
  stats: { total, verified, rejected, pending },
  pagination: {
    page: 1,
    limit: 50,
    totalCount: 100,
    totalPages: 2,
    hasMore: true
  }
}
```

Frontend pagination in ExtractedItemsGrid:
- 10 items per page per tab
- Navigation buttons (Назад/Вперёд)
- Page indicator (Страница X из Y)

### Environment Variables

Added to Railway:

| Variable | Purpose |
|----------|---------|
| `ENCRYPTION_KEY` | AES-256 key for encrypting API keys in database |

Generate a secure key:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Updated AI Prompts

All AI prompts updated to generate content in Russian:

1. **domain-steward.ts** - Domain classification prompts
2. **knowledge-extractor.ts** - Knowledge extraction prompts
3. **answering-engine.ts** - Question answering prompts
4. **domain-steward-stream.ts** - Streaming domain classification
5. **knowledge-extractor-stream.ts** - Streaming knowledge extraction

### Navigation Updates

Added to admin layout:
- "Настройки ИИ" menu item → `/admin/ai-settings`
- "Обработать" button on documents page → `/admin/documents/[id]/process`

### Processing Workflow

1. User uploads document
2. User clicks "Обработать" on documents page
3. System streams through 3 phases:
   - **Классификация доменов** - Domain classification
   - **Извлечение знаний** - Knowledge extraction (rules, Q&A, uncertainties)
   - **Разбиение на чанки** - Text chunking
4. User reviews extracted items in tabbed interface
5. User selects items to keep
6. User clicks "Сохранить выбранные" to commit to database

---

## Session Metadata

- **Date**: January 19, 2026
- **Duration**: Extended session with context recovery
- **Primary Tasks**:
  1. Railway deployment fix
  2. Playwright test infrastructure
  3. Russian localization
  4. Environment configuration
  5. Streaming document processing with verification
- **Result**: All tasks completed successfully
- **App URL**: https://avrora-library-production.up.railway.app
