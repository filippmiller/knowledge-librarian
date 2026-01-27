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
  const shouldResume = url.searchParams.get('resume') === 'true';

  // Check if document exists
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      title: true,
      rawText: true,
      parseStatus: true,
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

  // Create a readable stream for SSE
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: SSEEvent) => {
        controller.enqueue(encoder.encode(formatSSE(event)));
      };

      // SSE keepalive - send heartbeat every 15 seconds to prevent Railway proxy timeout
      const heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          // Controller closed, stop heartbeat
          clearInterval(heartbeatInterval);
        }
      }, 15000);

      try {
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
        }

        // ========== PHASE 2: Knowledge Extraction ==========
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

          // Stream knowledge extraction
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
            } else if (event.type === 'result') {
              knowledgeResult = event.data as KnowledgeExtractionStreamResult;
            }
          }

          // Save knowledge extraction results to staged
          if (knowledgeResult) {
            // Save rules
            for (const rule of knowledgeResult.rules) {
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

            // Save QA pairs
            for (const qa of knowledgeResult.qaPairs) {
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

          send({
            type: 'phase_complete',
            phase: 'KNOWLEDGE_EXTRACTION',
            data: { success: true },
          });
        }

        // ========== PHASE 3: Chunking ==========
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
          send({
            type: 'phase_start',
            phase: 'CHUNKING',
            data: { title: 'Разбиение на чанки' },
          });

          send({
            type: 'prompt',
            phase: 'CHUNKING',
            data: {
              humanReadable: `Разбиваю документ "${document.title}" на чанки для поиска.`,
              technical: `Размер чанка: 1000 символов\nПерекрытие: 200 символов`,
            },
          });

          // Split into chunks (this is synchronous, no streaming)
          const chunks = splitTextIntoChunks(document.rawText!);

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
        }

        // ========== Complete ==========
        send({
          type: 'complete',
          data: { success: true },
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Неизвестная ошибка';

        // Determine if this is a fatal error that should not be retried
        const fatal = isFatalError(error);

        send({
          type: fatal ? 'fatal_error' : 'error',
          data: {
            message: errorMessage,
            fatal,
            code: fatal ? 'FATAL' : 'ERROR',
          },
        });

        // Update document status to FAILED for fatal errors
        if (fatal) {
          await prisma.document.update({
            where: { id: documentId },
            data: {
              parseStatus: 'FAILED',
              parseError: errorMessage,
            },
          });
        }
      } finally {
        clearInterval(heartbeatInterval);
        controller.close();
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
