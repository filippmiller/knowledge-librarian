import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';
import { verifyProcessingToken } from '@/lib/crypto';
import {
  streamDomainClassification,
  getExistingDomainsForStream,
  getHumanReadablePrompt as getDomainPrompt,
  getTechnicalPrompt as getDomainTechnicalPrompt,
  type DomainStewardStreamResult,
} from '@/lib/ai/domain-steward-stream';
import {
  streamKnowledgeExtraction,
  getExistingRuleCodesForStream,
  getHumanReadablePrompt as getKnowledgePrompt,
  getTechnicalPrompt as getKnowledgeTechnicalPrompt,
  type KnowledgeExtractionStreamResult,
} from '@/lib/ai/knowledge-extractor-stream';
import { splitTextIntoChunks } from '@/lib/ai/chunker';

// In-memory lock to prevent concurrent processing of the same document.
// On Railway (single process), this is sufficient. For multi-instance deployments,
// use a database-based lock instead.
const processingLocks = new Map<string, boolean>();

// Types for SSE events
type SSEEventType =
  | 'phase_start'
  | 'prompt'
  | 'token'
  | 'item_extracted'
  | 'phase_complete'
  | 'error'
  | 'fatal_error'  // Non-recoverable errors (quota, auth, etc.) - client must NOT retry
  | 'complete';

interface SSEEvent {
  type: SSEEventType;
  phase?: string;
  data?: unknown;
}

function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// Check if error is fatal (should not be retried)
function isFatalError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  // AI provider quota/billing errors
  if (lowerMessage.includes('429') || lowerMessage.includes('quota')) return true;
  if (lowerMessage.includes('rate limit')) return true;

  // Auth errors
  if (lowerMessage.includes('401') || lowerMessage.includes('unauthorized')) return true;
  if (lowerMessage.includes('403') || lowerMessage.includes('forbidden')) return true;
  if (lowerMessage.includes('invalid api key')) return true;

  // Bad request (usually means invalid input, won't fix itself)
  if (lowerMessage.includes('400') || lowerMessage.includes('bad request')) return true;

  // Server errors from AI provider
  if (lowerMessage.includes('500') || lowerMessage.includes('502') || lowerMessage.includes('503')) return true;

  return false;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id: documentId } = await params;
  
  // Check for token-based auth (used by EventSource which can't send headers)
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  
  if (token) {
    // Token-based authentication for SSE
    const tokenResult = verifyProcessingToken(token, documentId);
    if (!tokenResult.valid) {
      console.error('[process-stream] Token auth failed:', tokenResult.error);
      return new Response(JSON.stringify({ error: `Auth failed: ${tokenResult.error}` }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    console.log('[process-stream] Token auth successful for document:', documentId);
  } else {
    // Fall back to Basic Auth for direct API calls
    const authError = await requireAdminAuth(request);
    if (authError) return authError;
  }
  
  // Check for resume mode (reconnection should resume, not restart)
  let shouldResume = url.searchParams.get('resume') === 'true';

  // Check if document exists
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      title: true,
      rawText: true,
      parseStatus: true,
      retryCount: true,
    },
  });

  if (!document) {
    return new Response(JSON.stringify({ error: 'Документ не найден' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!document.rawText) {
    return new Response(
      JSON.stringify({ error: 'Документ ещё не обработан (нет текста)' }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // DEAD documents cannot be processed — they must be revived first via the admin panel.
  if (document.parseStatus === 'DEAD') {
    return new Response(
      JSON.stringify({ error: 'Документ превысил лимит попыток. Реанимируйте его в панели управления.' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const MAX_RETRIES = 3;

  // EXTRACTED documents MUST always use resume mode to preserve their staged data.
  // Without this, clicking "Проверить" would delete all staged data and re-process.
  if (document.parseStatus === 'EXTRACTED') {
    shouldResume = true;
    console.log(`[process-stream] Document ${documentId} is EXTRACTED - forcing resume mode`);
  }

  // Check for resume mode - if resuming, check if processing already completed
  if (shouldResume) {
    const existingProgress = await prisma.stagedExtraction.groupBy({
      by: ['phase'],
      where: { documentId },
      _count: { id: true },
    });
    const phasesWithData = existingProgress.filter(g => g._count.id > 0).map(g => g.phase);

    // If all 3 phases are already done, just return a completed response
    if (phasesWithData.includes('DOMAIN_CLASSIFICATION') &&
        phasesWithData.includes('KNOWLEDGE_EXTRACTION') &&
        phasesWithData.includes('CHUNKING')) {
      console.log(`[process-stream] All phases already complete for ${documentId}, serving from DB`);
      // Let it fall through to resume mode which will re-emit from DB
    }
  }

  // Concurrent processing guard - prevent duplicate processing of the same document.
  // This blocks ALL new connections (including resume) if processing is in progress.
  // The client's reconnection logic will retry automatically after processing completes.
  if (processingLocks.has(documentId)) {
    console.log(`[process-stream] Document ${documentId} is already being processed (resume=${shouldResume})`);
    return new Response(
      JSON.stringify({ error: 'Документ уже обрабатывается. Переподключение произойдёт автоматически.' }),
      {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Create a readable stream for SSE
  const encoder = new TextEncoder();

  // Track whether the client is still connected
  let clientDisconnected = false;

  const stream = new ReadableStream({
    cancel() {
      // Called when the client disconnects (closes browser, modal, etc.)
      clientDisconnected = true;
      console.log(`[process-stream] Client disconnected for document ${documentId} - processing will continue`);
    },
    async start(controller) {
      // Acquire processing lock
      processingLocks.set(documentId, true);

      // DLQ: create an attempt record
      const attempt = await prisma.processingAttempt.create({
        data: { documentId, status: 'RUNNING' },
      });
      const attemptStart = Date.now();
      let currentPhase = 'INIT';

      // Safe send: silently fails when client has disconnected.
      // Processing continues regardless - results are saved to DB.
      const send = (event: SSEEvent) => {
        if (clientDisconnected) return;
        try {
          controller.enqueue(encoder.encode(formatSSE(event)));
        } catch {
          // Stream closed - mark as disconnected but keep processing
          clientDisconnected = true;
          console.log(`[process-stream] Stream write failed for ${documentId} - continuing processing in background`);
        }
      };

      // SSE keepalive - send heartbeat every 15 seconds to prevent Railway proxy timeout
      const heartbeatInterval = setInterval(() => {
        if (clientDisconnected) {
          clearInterval(heartbeatInterval);
          return;
        }
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          // Controller closed, stop heartbeat
          clientDisconnected = true;
          clearInterval(heartbeatInterval);
        }
      }, 15000);

      try {
        // Update document status to PROCESSING (only if not already EXTRACTED for resume)
        // EXTRACTED docs being resumed should keep their status until the stream completes.
        if (document.parseStatus !== 'EXTRACTED') {
          await prisma.document.update({
            where: { id: documentId },
            data: {
              parseStatus: 'PROCESSING',
              parseError: null,
            },
          });
        }

        // Check existing progress for resume capability
        const existingStaged = await prisma.stagedExtraction.groupBy({
          by: ['phase'],
          where: { documentId },
          _count: { id: true },
        });
        
        const completedPhases = new Set(
          existingStaged
            .filter(g => g._count.id > 0)
            .map(g => g.phase)
        );

        // Only clear if not resuming or no prior progress
        if (!shouldResume || completedPhases.size === 0) {
          await prisma.stagedExtraction.deleteMany({
            where: { documentId },
          });
          completedPhases.clear();
        }

        // ========== PHASE 1: Domain Classification ==========
        currentPhase = 'DOMAIN_CLASSIFICATION';
        if (completedPhases.has('DOMAIN_CLASSIFICATION')) {
          // Resume: re-emit existing results
          send({
            type: 'phase_start',
            phase: 'DOMAIN_CLASSIFICATION',
            data: { title: 'Классификация доменов (восстановлено)' },
          });
          
          const existingDomainResults = await prisma.stagedExtraction.findMany({
            where: { documentId, phase: 'DOMAIN_CLASSIFICATION' },
          });
          
          for (const staged of existingDomainResults) {
            send({
              type: 'item_extracted',
              phase: 'DOMAIN_CLASSIFICATION',
              data: {
                id: staged.id,
                itemType: staged.itemType,
                content: staged.data,
              },
            });
          }
          
          send({
            type: 'phase_complete',
            phase: 'DOMAIN_CLASSIFICATION',
            data: { success: true, resumed: true },
          });
        } else {
          send({
            type: 'phase_start',
            phase: 'DOMAIN_CLASSIFICATION',
            data: { title: 'Классификация доменов' },
          });

          const existingDomains = await getExistingDomainsForStream();

          // Send prompts
          send({
            type: 'prompt',
            phase: 'DOMAIN_CLASSIFICATION',
            data: {
              humanReadable: getDomainPrompt(document.title),
              technical: getDomainTechnicalPrompt(document.rawText!, existingDomains),
            },
          });

          // Stream domain classification
          let domainResult: DomainStewardStreamResult | null = null;
          for await (const event of streamDomainClassification(
            document.rawText!,
            existingDomains
          )) {
            if (event.type === 'token') {
              send({
                type: 'token',
                phase: 'DOMAIN_CLASSIFICATION',
                data: event.data,
              });
            } else if (event.type === 'result') {
              domainResult = event.data as DomainStewardStreamResult;
            }
          }

          // Save domain classification results to staged
          if (domainResult) {
            // Save domain assignments
            for (const domain of domainResult.documentDomains) {
              const staged = await prisma.stagedExtraction.create({
                data: {
                  documentId,
                  phase: 'DOMAIN_CLASSIFICATION',
                  itemType: 'DOMAIN_ASSIGNMENT',
                  data: domain as object,
                },
              });
              send({
                type: 'item_extracted',
                phase: 'DOMAIN_CLASSIFICATION',
                data: {
                  id: staged.id,
                  itemType: 'DOMAIN_ASSIGNMENT',
                  content: domain,
                },
              });
            }

            // Save domain suggestions
            for (const suggestion of domainResult.newDomainSuggestions) {
              const staged = await prisma.stagedExtraction.create({
                data: {
                  documentId,
                  phase: 'DOMAIN_CLASSIFICATION',
                  itemType: 'DOMAIN_SUGGESTION',
                  data: suggestion as object,
                },
              });
              send({
                type: 'item_extracted',
                phase: 'DOMAIN_CLASSIFICATION',
                data: {
                  id: staged.id,
                  itemType: 'DOMAIN_SUGGESTION',
                  content: suggestion,
                },
              });
            }
          }

          send({
            type: 'phase_complete',
            phase: 'DOMAIN_CLASSIFICATION',
            data: { success: true },
          });
          
          // Force garbage collection after phase 1
          if (global.gc) {
            global.gc();
            console.log('[process-stream] Forced GC after DOMAIN_CLASSIFICATION');
          }
        }

        // ========== PHASE 2: Knowledge Extraction ==========
        currentPhase = 'KNOWLEDGE_EXTRACTION';
        if (completedPhases.has('KNOWLEDGE_EXTRACTION')) {
          // Resume: re-emit existing results
          send({
            type: 'phase_start',
            phase: 'KNOWLEDGE_EXTRACTION',
            data: { title: 'Извлечение знаний (восстановлено)' },
          });
          
          const existingKnowledgeResults = await prisma.stagedExtraction.findMany({
            where: { documentId, phase: 'KNOWLEDGE_EXTRACTION' },
          });
          
          for (const staged of existingKnowledgeResults) {
            send({
              type: 'item_extracted',
              phase: 'KNOWLEDGE_EXTRACTION',
              data: {
                id: staged.id,
                itemType: staged.itemType,
                content: staged.data,
              },
            });
          }
          
          send({
            type: 'phase_complete',
            phase: 'KNOWLEDGE_EXTRACTION',
            data: { success: true, resumed: true },
          });
        } else {
          send({
            type: 'phase_start',
            phase: 'KNOWLEDGE_EXTRACTION',
            data: { title: 'Извлечение знаний' },
          });

          const existingRuleCodes = await getExistingRuleCodesForStream();
          const startCode =
            existingRuleCodes.length > 0
              ? Math.max(...existingRuleCodes.map((c) => parseInt(c.replace('R-', '')))) + 1
              : 1;

          // Send prompts
          send({
            type: 'prompt',
            phase: 'KNOWLEDGE_EXTRACTION',
            data: {
              humanReadable: getKnowledgePrompt(document.title),
              technical: getKnowledgeTechnicalPrompt(document.rawText!, startCode),
            },
          });

          // Stream knowledge extraction (now with batch processing)
          let knowledgeResult: KnowledgeExtractionStreamResult | null = null;
          for await (const event of streamKnowledgeExtraction(
            document.rawText!,
            existingRuleCodes
          )) {
            if (event.type === 'token') {
              send({
                type: 'token',
                phase: 'KNOWLEDGE_EXTRACTION',
                data: event.data,
              });
            } else if (event.type === 'batch_progress') {
              // Report batch progress to client
              const progressData = event.data as { current: number; total: number };
              send({
                type: 'token',
                phase: 'KNOWLEDGE_EXTRACTION',
                data: `\n[Batch ${progressData.current}/${progressData.total}]\n`,
              });
              console.log(`[process-stream] Knowledge extraction batch ${progressData.current}/${progressData.total}`);
            } else if (event.type === 'result') {
              knowledgeResult = event.data as KnowledgeExtractionStreamResult;
            }
          }
          
          console.log(`[process-stream] Knowledge extraction complete: ${knowledgeResult?.rules.length || 0} rules, ${knowledgeResult?.qaPairs.length || 0} QAs`);

          // Save knowledge extraction results to staged
          if (knowledgeResult) {
            console.log(`[process-stream] Saving ${knowledgeResult.rules.length} rules to staged...`);
            
            // Save rules
            for (let i = 0; i < knowledgeResult.rules.length; i++) {
              const rule = knowledgeResult.rules[i];
              console.log(`[process-stream] Saving rule ${i + 1}/${knowledgeResult.rules.length}: ${rule.ruleCode}`);
              const staged = await prisma.stagedExtraction.create({
                data: {
                  documentId,
                  phase: 'KNOWLEDGE_EXTRACTION',
                  itemType: 'RULE',
                  data: rule as object,
                },
              });
              send({
                type: 'item_extracted',
                phase: 'KNOWLEDGE_EXTRACTION',
                data: {
                  id: staged.id,
                  itemType: 'RULE',
                  content: rule,
                },
              });
            }

            console.log(`[process-stream] Rules saved! Now saving ${knowledgeResult.qaPairs.length} QA pairs...`);
            
            // Save QA pairs
            for (let i = 0; i < knowledgeResult.qaPairs.length; i++) {
              const qa = knowledgeResult.qaPairs[i];
              const staged = await prisma.stagedExtraction.create({
                data: {
                  documentId,
                  phase: 'KNOWLEDGE_EXTRACTION',
                  itemType: 'QA_PAIR',
                  data: qa as object,
                },
              });
              send({
                type: 'item_extracted',
                phase: 'KNOWLEDGE_EXTRACTION',
                data: {
                  id: staged.id,
                  itemType: 'QA_PAIR',
                  content: qa,
                },
              });
            }

            console.log(`[process-stream] QA pairs saved! Now saving ${knowledgeResult.uncertainties.length} uncertainties...`);
            
            // Save uncertainties
            for (const uncertainty of knowledgeResult.uncertainties) {
              const staged = await prisma.stagedExtraction.create({
                data: {
                  documentId,
                  phase: 'KNOWLEDGE_EXTRACTION',
                  itemType: 'UNCERTAINTY',
                  data: uncertainty as object,
                },
              });
              send({
                type: 'item_extracted',
                phase: 'KNOWLEDGE_EXTRACTION',
                data: {
                  id: staged.id,
                  itemType: 'UNCERTAINTY',
                  content: uncertainty,
                },
              });
            }
          }

          console.log('[process-stream] Sending phase_complete for KNOWLEDGE_EXTRACTION...');
          send({
            type: 'phase_complete',
            phase: 'KNOWLEDGE_EXTRACTION',
            data: { success: true },
          });
          console.log('[process-stream] phase_complete sent!');
          
          // Force garbage collection after phase 2 (most memory-intensive)
          if (global.gc) {
            global.gc();
            console.log('[process-stream] Forced GC after KNOWLEDGE_EXTRACTION');
          }
        }

        console.log('[process-stream] Starting PHASE 3: CHUNKING...');
        console.log(`[process-stream] completedPhases has CHUNKING: ${completedPhases.has('CHUNKING')}`);
        
        // ========== PHASE 3: Chunking ==========
        currentPhase = 'CHUNKING';
        if (completedPhases.has('CHUNKING')) {
          // Resume: re-emit existing results
          send({
            type: 'phase_start',
            phase: 'CHUNKING',
            data: { title: 'Разбиение на чанки (восстановлено)' },
          });
          
          const existingChunks = await prisma.stagedExtraction.findMany({
            where: { documentId, phase: 'CHUNKING' },
          });
          
          for (const staged of existingChunks) {
            const chunkData = staged.data as { index?: number; content?: string };
            send({
              type: 'item_extracted',
              phase: 'CHUNKING',
              data: {
                id: staged.id,
                itemType: 'CHUNK',
                content: {
                  index: chunkData.index,
                  preview: (chunkData.content || '').slice(0, 100) + '...',
                },
              },
            });
          }
          
          send({
            type: 'phase_complete',
            phase: 'CHUNKING',
            data: { success: true, chunkCount: existingChunks.length, resumed: true },
          });
        } else {
          console.log('[process-stream] CHUNKING not in completedPhases, starting fresh chunking...');
          send({
            type: 'phase_start',
            phase: 'CHUNKING',
            data: { title: 'Разбиение на чанки' },
          });
          console.log('[process-stream] CHUNKING phase_start sent!');

          send({
            type: 'prompt',
            phase: 'CHUNKING',
            data: {
              humanReadable: `Разбиваю документ "${document.title}" на чанки для поиска.`,
              technical: `Размер чанка: 1000 символов\nПерекрытие: 200 символов`,
            },
          });

          console.log('[process-stream] Calling splitTextIntoChunks...');
          // Split into chunks (this is synchronous, no streaming)
          const chunks = splitTextIntoChunks(document.rawText!);
          console.log(`[process-stream] splitTextIntoChunks returned ${chunks.length} chunks`);

          // Save chunks to staged
          for (const chunk of chunks) {
            const staged = await prisma.stagedExtraction.create({
              data: {
                documentId,
                phase: 'CHUNKING',
                itemType: 'CHUNK',
                data: {
                  index: chunk.index,
                  content: chunk.content,
                  metadata: chunk.metadata,
                },
              },
            });
            send({
              type: 'item_extracted',
              phase: 'CHUNKING',
              data: {
                id: staged.id,
                itemType: 'CHUNK',
                content: {
                  index: chunk.index,
                  preview: chunk.content.slice(0, 100) + '...',
                },
              },
            });
          }

          send({
            type: 'phase_complete',
            phase: 'CHUNKING',
            data: { success: true, chunkCount: chunks.length },
          });
          
          // Force garbage collection after phase 3
          if (global.gc) {
            global.gc();
            console.log('[process-stream] Forced GC after CHUNKING');
          }
        }

        // ========== Complete ==========
        console.log(`[process-stream] All phases complete for ${documentId}. Client connected: ${!clientDisconnected}`);

        // Mark document as EXTRACTED - all phases done, staged data ready for user review/commit.
        // This distinguishes from PROCESSING (actively running) and COMPLETED (committed to final tables).
        await prisma.document.update({
          where: { id: documentId },
          data: {
            parseStatus: 'EXTRACTED',
            parseError: null,
            retryCount: 0, // reset on success
          },
        });

        // DLQ: mark attempt as SUCCESS
        await prisma.processingAttempt.update({
          where: { id: attempt.id },
          data: { status: 'SUCCESS', completedAt: new Date(), durationMs: Date.now() - attemptStart },
        });

        send({
          type: 'complete',
          data: { success: true },
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Неизвестная ошибка';

        console.error(`[process-stream] Error processing ${documentId}:`, errorMessage);

        // Determine if this is a fatal error that should not be retried
        const fatal = isFatalError(error);

        // DLQ: mark attempt as FAILED and increment retryCount
        await prisma.processingAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'FAILED',
            completedAt: new Date(),
            durationMs: Date.now() - attemptStart,
            errorMessage,
            failedPhase: currentPhase,
          },
        });

        const newRetryCount = (document.retryCount ?? 0) + 1;
        const isDead = newRetryCount >= MAX_RETRIES;

        await prisma.document.update({
          where: { id: documentId },
          data: {
            parseStatus: isDead ? 'DEAD' : 'FAILED',
            parseError: errorMessage,
            retryCount: newRetryCount,
          },
        });

        if (isDead) {
          console.error(`[process-stream] Document ${documentId} is now DEAD after ${newRetryCount} retries`);
        }

        send({
          type: fatal ? 'fatal_error' : 'error',
          data: {
            message: errorMessage,
            fatal,
            code: isDead ? 'DEAD' : fatal ? 'FATAL' : 'ERROR',
            retryCount: newRetryCount,
            maxRetries: MAX_RETRIES,
          },
        });
      } finally {
        // Release processing lock
        processingLocks.delete(documentId);
        clearInterval(heartbeatInterval);
        if (!clientDisconnected) {
          try {
            controller.close();
          } catch {
            // Already closed
          }
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
