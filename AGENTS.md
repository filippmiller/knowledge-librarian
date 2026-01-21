# AGENTS.md - Mandatory Rules for AI Agents

> All AI agents operating in this codebase MUST follow these rules.

---

## Knowledge Management Protocol

### Rule 1: Query at Session Start

**BEFORE any work**, query the Librarian knowledge base:

```bash
curl -X POST http://localhost:3000/api/librarian/search \
  -H "Content-Type: application/json" \
  -d '{"query": "YOUR_TASK_KEYWORDS", "limit": 15, "agentId": "YOUR_AGENT_ID"}'
```

**Output this message:**
```
LIBRARIAN: Queried [keywords]. Found [N] entries ([X] verified).
```

Check for:
- CANONICAL entries (authoritative sources)
- VERIFIED entries (confirmed accurate)
- DISPUTED entries (conflicting information - flag for human review)

---

### Rule 2: Submit at Session End

**AFTER completing work** (especially after git commit), submit knowledge:

```bash
curl -X POST http://localhost:3000/api/librarian/ingest \
  -H "Authorization: Basic YOUR_AUTH" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Brief title of what was done",
    "content": "## What I Did\n\n### Summary\n...\n\n### Files Changed\n- path/to/file.ts:100-150",
    "domainSlug": "DOMAIN_SLUG",
    "entryType": "FACT",
    "createdBy": "YOUR_AGENT_ID",
    "evidence": {
      "commit_hash": "abc123",
      "files_changed": ["path/to/file.ts:100-150"],
      "functions_affected": ["functionName"]
    }
  }'
```

**Evidence is REQUIRED.** At least one of:
- `commit_hash` - Git commit hash
- `files_changed` - Files modified (with line numbers if relevant)
- `functions_affected` - Functions changed
- `tables_affected` - Database tables modified
- `api_endpoints` - API routes affected

---

### Rule 3: Maintain Quality

When you **VERIFY** information is correct:
```bash
curl -X POST "http://localhost:3000/api/librarian/entry/{id}/verify" \
  -H "Authorization: Basic YOUR_AUTH" \
  -H "Content-Type: application/json" \
  -d '{"verifiedBy": "YOUR_AGENT_ID"}'
```

When you find **WRONG** information:
```bash
curl -X POST "http://localhost:3000/api/librarian/entry/{id}/dispute" \
  -H "Authorization: Basic YOUR_AUTH" \
  -H "Content-Type: application/json" \
  -d '{"disputedBy": "YOUR_AGENT_ID", "reason": "Why it is wrong"}'
```

When you confirm **STALE** information is still valid:
```bash
curl -X POST "http://localhost:3000/api/librarian/entry/{id}/revalidate" \
  -H "Authorization: Basic YOUR_AUTH" \
  -H "Content-Type: application/json" \
  -d '{"validatedBy": "YOUR_AGENT_ID"}'
```

---

## Entry Types

Use the correct `entryType` when ingesting:

| Type | Use For |
|------|---------|
| `FACT` | Factual statements, observations, findings |
| `PROCEDURE` | Step-by-step processes, workflows |
| `RULE` | Business rules, constraints, policies |
| `DEFINITION` | Term definitions, glossary entries |
| `REFERENCE` | External links, documentation references |

---

## Verification Statuses

| Status | Meaning | Trust Level |
|--------|---------|-------------|
| `CANONICAL` | Authoritative source of truth | Highest (1.0) |
| `VERIFIED` | Reviewed and confirmed accurate | High (0.8) |
| `UNVERIFIED` | New entry, not yet reviewed | Medium (0.5) |
| `STALE` | Outdated, needs refresh | Low (0.3) |
| `DISPUTED` | Conflicting information flagged | Lowest (0.1) |

---

## Ranking Formula

Search results are ranked by:

```
RANK = (0.4 × verification_score) + (0.3 × freshness_score) + (0.3 × relevance_score)
```

This means:
- **CANONICAL** and **VERIFIED** entries appear first
- Recent information ranks higher
- Semantic relevance matters

---

## Security Rules

**NEVER** include in knowledge entries:
- API keys or secrets
- Passwords or credentials
- Private keys (RSA, EC, DSA)
- Bearer tokens or JWTs
- AWS/GCP/Azure credentials

Content is automatically scanned. Violations will be **REJECTED**.

---

## Compliance Tracking

The Librarian tracks agent activity. Sessions without knowledge contributions may be flagged.

**Good agent behavior:**
1. Query before work
2. Check for conflicts
3. Submit learnings
4. Verify/dispute as needed

**Bad agent behavior:**
1. Making changes without querying
2. Ignoring DISPUTED entries
3. Not submitting learnings
4. Submitting duplicate content

---

## Quick Reference

| Action | Endpoint | Method |
|--------|----------|--------|
| Search | `/api/librarian/search` | POST |
| Ingest | `/api/librarian/ingest` | POST (auth) |
| Verify | `/api/librarian/entry/{id}/verify` | POST (auth) |
| Dispute | `/api/librarian/entry/{id}/dispute` | POST (auth) |
| Revalidate | `/api/librarian/entry/{id}/revalidate` | POST (auth) |
| Health | `/api/librarian/health` | GET (auth) |

---

## Example Workflow

```
1. Agent starts task: "Fix login timeout bug"

2. Query Librarian:
   POST /api/librarian/search
   {"query": "login timeout authentication", "agentId": "agent-123"}

   Response: Found 3 entries (2 verified)
   - VERIFIED: "Auth service uses 30-second timeout"
   - VERIFIED: "Login flow in auth_service.ts:150-200"
   - UNVERIFIED: "Timeout config in .env"

3. Agent reviews entries, finds useful context

4. Agent fixes bug, commits: abc123

5. Submit knowledge:
   POST /api/librarian/ingest
   {
     "title": "Fixed login timeout - increased to 60 seconds",
     "content": "## Summary\nIncreased auth timeout from 30s to 60s...",
     "entryType": "FACT",
     "createdBy": "agent-123",
     "evidence": {
       "commit_hash": "abc123",
       "files_changed": ["src/lib/auth_service.ts:155"]
     }
   }

6. Agent verifies the existing entry is still accurate:
   POST /api/librarian/entry/{id}/verify
   {"verifiedBy": "agent-123"}
```

---

**These rules are persistent for this repository.**
