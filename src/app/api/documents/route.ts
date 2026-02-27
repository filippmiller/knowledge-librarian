import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';
import { parseDocument, detectMimeType } from '@/lib/document-parser';
import {
  classifyDocumentDomains,
  getExistingDomains,
  saveDomainSuggestions,
  linkDocumentToDomains,
} from '@/lib/ai/domain-steward';
import {
  extractKnowledge,
  saveExtractedRules,
  saveExtractedQAs,
  createAIQuestions,
  getExistingRuleCodes,
} from '@/lib/ai/knowledge-extractor';
import { createDocumentChunks } from '@/lib/ai/chunker';

/**
 * PATCH /api/documents
 * Bulk operations on documents
 */
export async function PATCH(request: NextRequest): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { action } = body;

    switch (action) {
      case 'reset-stuck': {
        // Reset all documents stuck in PROCESSING for more than 30 minutes
        const stuckTimeout = 30 * 60 * 1000; // 30 minutes
        const cutoff = new Date(Date.now() - stuckTimeout);

        const result = await prisma.document.updateMany({
          where: {
            parseStatus: 'PROCESSING',
            uploadedAt: { lt: cutoff },
          },
          data: {
            parseStatus: 'FAILED',
            parseError: 'Processing timed out. Reset by admin.',
          },
        });

        // Also clear staged extractions for these documents
        const stuckDocs = await prisma.document.findMany({
          where: {
            parseStatus: 'FAILED',
            parseError: 'Processing timed out. Reset by admin.',
          },
          select: { id: true },
        });

        for (const doc of stuckDocs) {
          await prisma.stagedExtraction.deleteMany({
            where: { documentId: doc.id },
          });
        }

        return NextResponse.json({
          message: `Reset ${result.count} stuck documents`,
          count: result.count,
        });
      }

      case 'cancel-all-processing': {
        // Cancel all documents currently processing
        const result = await prisma.document.updateMany({
          where: { parseStatus: 'PROCESSING' },
          data: {
            parseStatus: 'FAILED',
            parseError: 'Processing cancelled by admin.',
          },
        });

        return NextResponse.json({
          message: `Cancelled ${result.count} processing documents`,
          count: result.count,
        });
      }

      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }
  } catch (error) {
    console.error('Error in bulk document operation:', error);
    return NextResponse.json({ error: 'Failed to perform bulk operation' }, { status: 500 });
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  try {
    const processingTimeoutMs = 6 * 60 * 60 * 1000;
    const timeoutCutoff = new Date(Date.now() - processingTimeoutMs);

    await prisma.document.updateMany({
      where: {
        parseStatus: 'PROCESSING',
        uploadedAt: { lt: timeoutCutoff },
      },
      data: {
        parseStatus: 'FAILED',
        parseError: 'Processing timed out. Please retry.',
      },
    });

    const documents = await prisma.document.findMany({
      select: {
        id: true,
        title: true,
        filename: true,
        mimeType: true,
        parseStatus: true,
        parseError: true,
        retryCount: true,
        uploadedAt: true,
        // Explicitly exclude rawText and rawBytes - they can be megabytes each
        domains: {
          include: {
            domain: { select: { slug: true, title: true } },
          },
        },
        _count: {
          select: { rules: true, qaPairs: true, chunks: true },
        },
      },
      orderBy: { uploadedAt: 'desc' },
    });

    return NextResponse.json(documents);
  } catch (error) {
    console.error('Error fetching documents:', error);
    return NextResponse.json({ error: 'Failed to fetch documents' }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const title = formData.get('title') as string | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const filename = file.name;

    // Check for duplicate uploads - prevent re-uploading same file
    const existingDoc = await prisma.document.findFirst({
      where: { filename },
      select: { id: true, title: true, parseStatus: true },
    });

    if (existingDoc) {
      return NextResponse.json({
        error: `Документ "${existingDoc.title}" (${filename}) уже загружен (статус: ${existingDoc.parseStatus}). Удалите существующий документ перед повторной загрузкой.`,
        existingId: existingDoc.id,
      }, { status: 409 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || detectMimeType(filename);

    // Step 1: Parse document text FIRST (required for SSE processing)
    console.log(`[Upload] Parsing document: ${filename}`);
    let rawText: string;
    try {
      rawText = await parseDocument(buffer, mimeType, filename);
      console.log(`[Upload] Parsed ${rawText.length} characters from ${filename}`);
    } catch (parseError) {
      console.error(`[Upload] Failed to parse ${filename}:`, parseError);
      return NextResponse.json({ 
        error: `Failed to parse document: ${parseError instanceof Error ? parseError.message : 'Unknown error'}` 
      }, { status: 400 });
    }

    // Step 2: Create document record WITH rawText
    const document = await prisma.document.create({
      data: {
        title: title || filename,
        filename,
        mimeType,
        rawBytes: buffer,
        rawText, // Include parsed text so SSE can proceed
        parseStatus: 'PENDING', // PENDING until user opens processing terminal
      },
    });

    console.log(`[Upload] Document created: ${document.id} (PENDING)`);

    // NOTE: AI processing is handled by the Librarian Terminal (SSE stream).
    // Status transitions: PENDING → PROCESSING (when SSE starts) → COMPLETED (after commit)

    return NextResponse.json({
      id: document.id,
      message: 'Document uploaded and parsed, ready for processing',
    });
  } catch (error) {
    console.error('Error uploading document:', error);
    return NextResponse.json({ error: 'Failed to upload document' }, { status: 500 });
  }
}

async function processDocument(
  documentId: string,
  buffer: Buffer,
  mimeType: string,
  filename: string
) {
  try {
    // Step 1: Parse document text
    const rawText = await parseDocument(buffer, mimeType, filename);

    await prisma.document.update({
      where: { id: documentId },
      data: { rawText },
    });

    // Step 2: Classify domains
    const existingDomains = await getExistingDomains();
    const domainResult = await classifyDocumentDomains(rawText, existingDomains);

    // Save domain suggestions
    if (domainResult.newDomainSuggestions.length > 0) {
      await saveDomainSuggestions(documentId, domainResult.newDomainSuggestions);
    }

    // Link document to domains
    await linkDocumentToDomains(documentId, domainResult.documentDomains);

    // Get domain IDs for the document
    const documentDomains = await prisma.documentDomain.findMany({
      where: { documentId },
      select: { domainId: true },
    });
    const domainIds = documentDomains.map((d) => d.domainId);

    // Step 3: Extract knowledge
    const existingRuleCodes = await getExistingRuleCodes();
    const knowledge = await extractKnowledge(rawText, existingRuleCodes);

    // Save rules
    const createdRules = await saveExtractedRules(documentId, knowledge.rules, domainIds);
    const ruleCodeToId = new Map(createdRules.map((r) => [r.ruleCode, r.id]));

    // Save Q&A pairs
    await saveExtractedQAs(documentId, knowledge.qaPairs, ruleCodeToId, domainIds);

    // Save uncertainties as AI questions
    if (knowledge.uncertainties.length > 0) {
      await createAIQuestions(knowledge.uncertainties);
    }

    // Step 4: Create chunks with embeddings
    await createDocumentChunks(documentId, rawText, domainIds);

    // Mark as completed
    await prisma.document.update({
      where: { id: documentId },
      data: { parseStatus: 'COMPLETED' },
    });
  } catch (error) {
    console.error('Error processing document:', error);
    await prisma.document.update({
      where: { id: documentId },
      data: {
        parseStatus: 'FAILED',
        parseError: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
}
