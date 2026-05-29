# Railway Environment Variables Setup

## Required Environment Variable for Memory Optimization

To enable garbage collection in Node.js on Railway, add this environment variable:

```
NODE_OPTIONS=--expose-gc
```

## How to Set it on Railway

### Option 1: Railway Dashboard

1. Go to https://railway.app/project/your-project
2. Select your service (avrora-library)
3. Go to "Variables" tab
4. Click "New Variable"
5. Add:
   - Name: `NODE_OPTIONS`
   - Value: `--expose-gc`
6. Click "Add"
7. Railway will automatically redeploy

### Option 2: Railway CLI

```bash
railway variables set NODE_OPTIONS="--expose-gc"
```

## Why This is Needed

The `--expose-gc` flag allows our code to manually trigger garbage collection using `global.gc()`:

```typescript
// Force garbage collection after phase
if (global.gc) {
  global.gc();
  console.log('[process-stream] Forced GC after PHASE');
}
```

Without this flag, `global.gc()` is undefined and memory cleanup doesn't happen, leading to OOM crashes.

## Verification

After setting the variable and redeploying, check Railway logs for:

```
[process-stream] Forced GC after DOMAIN_CLASSIFICATION
[process-stream] Forced GC after KNOWLEDGE_EXTRACTION
[process-stream] Forced GC after CHUNKING
```

If you see these messages, GC is working correctly.

## Other Memory Optimizations Applied

- Batch size reduced: 12000 → 2000 characters
- Embedding batch size: 5 → 3 items
- Aggressive GC between phases
- Resume capability for failed runs
- Checkpointing after each phase
