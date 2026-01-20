# Session Notes - January 20, 2026
## Streaming Document Processing & Memory Optimization

---

## Summary

This session focused on deploying and testing the streaming document processing system, resolving API key issues, and optimizing memory usage for embedding generation.

---

## Issues Resolved

### 1. OpenAI API Key Revoked

**Symptom**: Documents failing with 401 error
```
401 You didn't provide an API key
```

**Root Cause**: Original API key was accidentally exposed in SESSION_NOTES.md during a git push attempt. GitHub's secret scanning detected and notified OpenAI, which auto-revoked the key.

**Resolution**:
- User generated new service account key (`sk-svcacct-...`)
- Updated Railway environment variable
- Deployed with `railway up`

---

### 2. JavaScript Heap Out of Memory

**Symptom**: Server crashing during document processing
```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
```

**Initial Fix**: Increased heap to 4GB
```bash
railway variables --set "NODE_OPTIONS=--max-old-space-size=4096"
```

**Result**: Still crashed at ~4GB during embedding generation

**Final Fix**: Batched embedding processing (5 chunks at a time)

---

### 3. Documents Stuck in PROCESSING Status

**Symptom**: Documents showing PROCESSING with Rules/QA extracted but Chunks=0

**Root Cause**: Async `processDocument()` function interrupted by server restarts. Steps 1-3 completed but Step 4 (chunking) failed.

**Resolution**: Use streaming processing page to reprocess documents manually

---

## Code Changes

### Memory Optimization

**File: `src/lib/ai/chunker.ts`**
```typescript
const EMBEDDING_BATCH_SIZE = 5;

for (let batchStart = 0; batchStart < chunks.length; batchStart += EMBEDDING_BATCH_SIZE) {
  const batchEnd = Math.min(batchStart + EMBEDDING_BATCH_SIZE, chunks.length);
  const batchChunks = chunks.slice(batchStart, batchEnd);

  const batchEmbeddings = await generateEmbeddings(batchChunks.map((c) => c.content));

  // Save immediately to database
  for (let i = 0; i < batchChunks.length; i++) {
    await prisma.docChunk.create({...});
  }

  // Allow GC between batches
  if (global.gc) global.gc();
}
```

**File: `src/app/api/documents/[id]/commit/route.ts`**
- Same batched processing applied

---

## Environment Variables Updated

| Variable | Value | Purpose |
|----------|-------|---------|
| `OPENAI_API_KEY` | `sk-svcacct-...` | New service account key |
| `NODE_OPTIONS` | `--max-old-space-size=4096` | 4GB heap limit |
| `ENCRYPTION_KEY` | (set earlier) | API key encryption |

---

## Tests Created

| File | Purpose |
|------|---------|
| `tests/document-processing.spec.ts` | Document upload test |
| `tests/streaming-process.spec.ts` | Streaming UI test |
| `tests/reprocess-document.spec.ts` | Reprocessing via streaming |

---

## Verification Results

### Playwright Tests
- 11 original admin tests: ✅ All passed
- Document processing tests: ✅ Passed

### Streaming Processing Page
- Phase 1 (Domain Classification): ✅ Works
- Phase 2 (Knowledge Extraction): ✅ Streams JSON in real-time
- Phase 3 (Chunking): ✅ Creates chunks
- UI displays extracted items correctly
- "Сохранить выбранные" button functional

### API Endpoints
- `/api/ask`: ✅ Responds with answers and citations
- `/api/documents`: ✅ Returns document list
- Admin auth: ✅ Working

---

## Commits

1. `da3abd9` - Add streaming document processing with human verification
2. `c8d7b3d` - Optimize embedding generation with batched processing

---

## Key Learnings

1. **Never commit API keys** - GitHub secret scanning will auto-revoke them
2. **Batch embedding generation** - Processing all at once causes OOM
3. **Async processing not resilient** - Server restarts lose in-flight work
4. **Railway deployment** - Always use `railway up`, not git push (Railpack bug)

---

## Deployment Reminder

```bash
# ALWAYS deploy with CLI, not git push
railway up
```

GitHub auto-deploy uses Railpack which ignores Dockerfile configuration.

---

## Next Steps (for future sessions)

1. Reprocess stuck documents via streaming UI
2. Consider job queue for resilient document processing
3. Add "Retry Processing" button for failed documents
4. Enable pgvector for scalable vector search

---

## Session Metadata

- **Date**: January 20, 2026
- **Duration**: ~2 hours
- **Focus**: Streaming processing deployment, API key resolution, memory optimization
- **Result**: All systems operational
- **App URL**: https://avrora-library-production.up.railway.app
