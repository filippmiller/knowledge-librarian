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
      include: {
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

    const buffer = Buffer.from(await file.arrayBuffer());
    const filename = file.name;
    const mimeType = file.type || detectMimeType(filename);

    // Create document record
    const document = await prisma.document.create({
      data: {
        title: title || filename,
        filename,
        mimeType,
        rawBytes: buffer,
        parseStatus: 'PROCESSING',
      },
    });

    // Process document asynchronously
    processDocument(document.id, buffer, mimeType, filename).catch(console.error);

    return NextResponse.json({
      id: document.id,
      message: 'Document uploaded, processing started',
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
