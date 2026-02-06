# Knowledge Librarian - Work Log

## 2026-02-06 Session 2 - EXTRACTED Status & Production Processing

**Status**: Completed
**Duration**: ~3.5 hours
**Commits**: 9962c22

### What was done
- Found and fixed critical bug: EXTRACTED documents re-processed from scratch on reopen (83s wasted + data loss)
- Added server-side guard to force resume mode for EXTRACTED documents
- End-to-end tested resume flow: 4.1s DB load vs 83s re-processing
- Deployed all changes to production Railway
- Processed all 5 PENDING documents on production (183 items in 168.7s, zero errors)
- Committed all 6 EXTRACTED documents to knowledge base
- Final state: 15/15 documents COMPLETED

### Decisions made
- Server-side resume guard chosen over client-side for robustness
- Sequential production processing to avoid Railway/AI API overload
- Node.js SSE consumer script when Playwright unavailable

### Issues encountered
- Playwright MCP tools became unavailable mid-session; switched to Node.js scripts
- PowerShell commands timeout on large API responses; used Node.js piping instead

### Next steps
- All documents processed and committed - knowledge base is complete
- Consider adding batch processing UI for multiple documents
- Address Next.js 16 middleware deprecation warning (middleware.ts -> proxy.ts)

---

## 2026-02-06 Session 1 - Resilience & Error-Proofing

**Status**: Completed
**Commits**: 8787fce, and prior commits

### What was done
- Added EXTRACTED enum to ParseStatus in Prisma schema
- Implemented SSE disconnect resilience (processing continues in background)
- Added reconnection logic: 5 attempts, exponential backoff up to 10s
- Added React Strict Mode guard to prevent duplicate processing
- Added concurrent processing lock (in-memory Map)
- Added 6-hour auto-fail for stuck PROCESSING documents
- Added duplicate upload protection
- Added EXTRACTED badge, "Проверить" button, review counter in UI
- Reset 5 stuck PROCESSING documents to PENDING
- Successfully processed first test document end-to-end

### Issues encountered
- Prisma DLL lock from dev server holding query_engine-windows.dll.node
- PowerShell `$_` interpolation issues in bash shell
