# AI Knowledge Librarian V2

**Date:** 2026-01-19
**Status:** Initial Implementation Complete

## Overview

The AI Knowledge Librarian is a living knowledge library platform for a translation bureau.
It combines document processing, AI-powered knowledge extraction, and a human-in-the-loop
approval system to create a constantly improving knowledge base.

## Core Philosophy

1. **Knowledge is NOT immutable** - Rules and facts can be updated, versioned, and deprecated
2. **AI is NOT an oracle** - It is a librarian-assistant that proposes and explains
3. **Every uncertainty surfaces as a question** - AI asks when unsure
4. **Every change is explainable and reversible** - Full audit trail
5. **Humans approve meaning; AI handles structure** - Clear division of responsibility

## Architecture

### Tech Stack

- **Frontend:** Next.js 16 (App Router), TypeScript, Tailwind, shadcn/ui
- **Backend:** Next.js API routes, OpenAI API
- **Database:** PostgreSQL with pgvector, Prisma ORM
- **Infrastructure:** Railway

### Database Schema

```
Document → DocChunk (with vector embeddings)
         → Rule (versioned)
         → QAPair (versioned)
         → DomainSuggestion

Domain (hierarchical, self-referential)

KnowledgeChange (audit log)
AIQuestion (human-in-the-loop)
ChatSession → ChatMessage
```

### AI Components

1. **Domain Steward** (`src/lib/ai/domain-steward.ts`)
   - Classifies documents into domains
   - Suggests new subdomains when needed
   - Never creates domains silently

2. **Knowledge Extractor** (`src/lib/ai/knowledge-extractor.ts`)
   - Extracts business rules from documents
   - Generates Q&A pairs
   - Flags uncertainties for human review

3. **Chunker** (`src/lib/ai/chunker.ts`)
   - Splits documents into semantic chunks
   - Generates embeddings for vector search

4. **Answering Engine** (`src/lib/ai/answering-engine.ts`)
   - Classifies user intent
   - Retrieves relevant knowledge
   - Generates answers with citations

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/documents` | GET/POST | List/upload documents |
| `/api/documents/[id]` | GET/DELETE | Get/delete document |
| `/api/domains` | GET/POST | List/create domains |
| `/api/domain-suggestions` | GET | List suggestions |
| `/api/domain-suggestions/[id]` | PATCH | Approve/reject |
| `/api/rules` | GET | List rules |
| `/api/rules/[id]` | GET/PATCH | Get/update rule |
| `/api/qa` | GET | List Q&A pairs |
| `/api/ask` | POST | Ask a question |
| `/api/ai-questions` | GET | List AI questions |
| `/api/ai-questions/[id]` | PATCH | Answer/dismiss |
| `/api/knowledge-changes` | GET | Audit log |

## Admin Panel

Located at `/admin`, provides interfaces for:

- Document management and upload
- Domain hierarchy management
- Domain suggestion approval
- Rule viewing and editing
- Q&A pair management
- AI question handling
- Knowledge change audit log

## Playground

Located at `/playground`:

- Interactive Q&A interface
- Shows confidence scores
- Displays citations
- Optional debug view (retrieved chunks, intent classification)

## Deployment

### Railway Setup

1. Create new Railway project
2. Add PostgreSQL database
3. Set environment variables:
   - `DATABASE_URL` (auto-configured by Railway)
   - `OPENAI_API_KEY`
   - `ADMIN_PASSWORD`
4. Deploy from GitHub or CLI

### Database Migration

```bash
# Generate Prisma client
pnpm db:generate

# Push schema to database
pnpm db:push

# Seed base domains
pnpm db:seed
```

### Local Development

```bash
# Install dependencies
pnpm install

# Set up environment
cp .env.example .env
# Edit .env with your values

# Run development server
pnpm dev
```

## Security

- Basic authentication for admin routes
- Environment variables for secrets
- Audit logging for all changes
- No secrets committed to git

## Knowledge Lifecycle

### Document Upload Flow

1. User uploads document
2. System parses text (PDF, DOCX, TXT)
3. Domain Steward classifies domains
4. Knowledge Extractor extracts rules and Q&A
5. Chunker creates embeddings
6. AI questions created for uncertainties

### Knowledge Update Flow

1. Admin or AI proposes change
2. System creates KnowledgeChange record
3. If from AI: requires admin approval
4. If approved: creates new version, supersedes old
5. Full audit trail maintained

### Human-in-the-Loop

AI asks questions when it encounters:
- Conflicting values (prices, dates)
- Ambiguous wording
- Potentially outdated information
- Confidence below threshold

Admin responds via AI Questions page.

## Base Domains

Pre-seeded domains:

1. `general_ops` - General Operations
2. `notary` - Notary Services
3. `pricing` - Pricing
4. `translation_ops` - Translation Operations
5. `formatting_delivery` - Formatting & Delivery
6. `it_tools` - IT & Tools
7. `hr_internal` - HR & Internal
8. `sales_clients` - Sales & Clients
9. `legal_compliance` - Legal & Compliance

Subdomains can be added manually or via AI suggestion.

## Future Enhancements

1. **Telegram Bot** - See `docs/telegram-bot.md`
2. **Batch document processing**
3. **Export/import knowledge**
4. **Multi-language support**
5. **Advanced search with filters**
6. **Version diff visualization**
7. **Scheduled knowledge review**

## Lessons Learned

1. **Versioning is essential** - Knowledge changes; track it
2. **AI confidence matters** - Low confidence = ask human
3. **Domain structure enables precision** - Better retrieval
4. **Audit everything** - Trust requires transparency
5. **Simple UI wins** - Admin panel should be obvious

## Files Structure

```
src/
├── app/
│   ├── api/
│   │   ├── ask/
│   │   ├── documents/
│   │   ├── domains/
│   │   ├── domain-suggestions/
│   │   ├── rules/
│   │   ├── qa/
│   │   ├── ai-questions/
│   │   └── knowledge-changes/
│   ├── admin/
│   │   ├── documents/
│   │   ├── domains/
│   │   ├── domain-suggestions/
│   │   ├── rules/
│   │   ├── qa/
│   │   ├── ai-questions/
│   │   └── knowledge-changes/
│   └── playground/
├── components/ui/
├── lib/
│   ├── ai/
│   │   ├── domain-steward.ts
│   │   ├── knowledge-extractor.ts
│   │   ├── chunker.ts
│   │   └── answering-engine.ts
│   ├── db.ts
│   ├── openai.ts
│   ├── auth.ts
│   ├── document-parser.ts
│   └── utils.ts
└── generated/prisma/
prisma/
├── schema.prisma
└── seed.ts
docs/
├── telegram-bot.md
└── 2026-01-19-ai-knowledge-librarian-v2.md
```

## Contact & Support

This system was built for internal use. For questions or issues,
consult the admin documentation or review the codebase.
