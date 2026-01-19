import { NextRequest } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';
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
  | 'complete';

interface SSEEvent {
  type: SSEEventType;
  phase?: string;
  data?: unknown;
}

function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const { id: documentId } = await params;

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

      try {
        // Clear existing staged extractions for this document
        await prisma.stagedExtraction.deleteMany({
          where: { documentId },
        });

        // ========== PHASE 1: Domain Classification ==========
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

        // ========== PHASE 2: Knowledge Extraction ==========
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

        // ========== PHASE 3: Chunking ==========
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

        // ========== Complete ==========
        send({
          type: 'complete',
          data: { success: true },
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Неизвестная ошибка';
        send({
          type: 'error',
          data: { message: errorMessage },
        });
      } finally {
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
