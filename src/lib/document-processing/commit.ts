import prisma from '@/lib/db';
import { generateEmbeddings } from '@/lib/openai';

export interface CommitResult {
  success: boolean;
  message: string;
  results: {
    domainsLinked: number;
    domainSuggestionsCreated: number;
    rulesCreated: number;
    qaPairsCreated: number;
    aiQuestionsCreated: number;
    chunksCreated: number;
  };
}

/**
 * Commits all verified staged extractions for a document to the knowledge base.
 * Shared by both the admin panel commit endpoint and the Telegram mini-app.
 */
export async function commitDocumentKnowledge(documentId: string): Promise<CommitResult> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
  });

  if (!document) {
    throw new Error('Документ не найден');
  }

  const verifiedItems = await prisma.stagedExtraction.findMany({
    where: { documentId, isVerified: true },
  });

  if (verifiedItems.length === 0) {
    console.log('[COMMIT] No verified items found - likely already saved');
    return {
      success: true,
      message: 'Все элементы уже сохранены',
      results: {
        domainsLinked: 0,
        domainSuggestionsCreated: 0,
        rulesCreated: 0,
        qaPairsCreated: 0,
        aiQuestionsCreated: 0,
        chunksCreated: 0,
      },
    };
  }

  const results = {
    domainsLinked: 0,
    domainSuggestionsCreated: 0,
    rulesCreated: 0,
    qaPairsCreated: 0,
    aiQuestionsCreated: 0,
    chunksCreated: 0,
  };

  const domainIds: string[] = [];

  console.log(`[COMMIT] Processing ${verifiedItems.length} verified items`);

  // Process domain assignments
  const domainAssignments = verifiedItems.filter((i) => i.itemType === 'DOMAIN_ASSIGNMENT');
  for (const item of domainAssignments) {
    const data = item.data as {
      primaryDomainSlug: string;
      secondaryDomainSlugs: string[];
      confidence: number;
    };

    const primaryDomain = await prisma.domain.findUnique({ where: { slug: data.primaryDomainSlug } });
    if (primaryDomain) {
      await prisma.documentDomain.upsert({
        where: { documentId_domainId: { documentId, domainId: primaryDomain.id } },
        update: { isPrimary: true, confidence: data.confidence },
        create: { documentId, domainId: primaryDomain.id, isPrimary: true, confidence: data.confidence },
      });
      domainIds.push(primaryDomain.id);
      results.domainsLinked++;
    }

    for (const secondarySlug of data.secondaryDomainSlugs) {
      const secondaryDomain = await prisma.domain.findUnique({ where: { slug: secondarySlug } });
      if (secondaryDomain) {
        await prisma.documentDomain.upsert({
          where: { documentId_domainId: { documentId, domainId: secondaryDomain.id } },
          update: { isPrimary: false, confidence: data.confidence * 0.8 },
          create: { documentId, domainId: secondaryDomain.id, isPrimary: false, confidence: data.confidence * 0.8 },
        });
        domainIds.push(secondaryDomain.id);
        results.domainsLinked++;
      }
    }
  }

  // Process domain suggestions
  const domainSuggestions = verifiedItems.filter((i) => i.itemType === 'DOMAIN_SUGGESTION');
  for (const item of domainSuggestions) {
    const data = item.data as {
      suggestedSlug: string;
      title: string;
      description: string;
      parentSlug: string | null;
      confidence: number;
      reason: string;
    };
    await prisma.domainSuggestion.create({
      data: {
        suggestedSlug: data.suggestedSlug,
        title: data.title,
        description: data.description,
        parentSlug: data.parentSlug,
        confidence: data.confidence,
        reason: data.reason,
        createdFromDocumentId: documentId,
      },
    });
    results.domainSuggestionsCreated++;
  }

  const uniqueDomainIds = [...new Set(domainIds)];
  const ruleCodeToId = new Map<string, string>();

  // Process rules
  const rules = verifiedItems.filter((i) => i.itemType === 'RULE');
  for (const item of rules) {
    const data = item.data as {
      ruleCode: string;
      title: string;
      body: string;
      confidence: number;
      sourceSpan: { quote: string; locationHint: string };
    };

    const created = await prisma.rule.create({
      data: {
        documentId,
        ruleCode: data.ruleCode,
        title: data.title,
        body: data.body,
        confidence: data.confidence,
        sourceSpan: data.sourceSpan,
      },
    });

    ruleCodeToId.set(data.ruleCode, created.id);

    for (const domainId of uniqueDomainIds) {
      await prisma.ruleDomain.upsert({
        where: { ruleId_domainId: { ruleId: created.id, domainId } },
        update: { confidence: data.confidence },
        create: { ruleId: created.id, domainId, confidence: data.confidence },
      });
    }

    results.rulesCreated++;
  }

  // Process QA pairs
  const qaPairs = verifiedItems.filter((i) => i.itemType === 'QA_PAIR');
  for (const item of qaPairs) {
    const data = item.data as {
      question: string;
      answer: string;
      linkedRuleCode: string | null;
    };

    const ruleId = data.linkedRuleCode ? ruleCodeToId.get(data.linkedRuleCode) : null;

    const created = await prisma.qAPair.create({
      data: {
        documentId,
        ruleId: ruleId || null,
        question: data.question,
        answer: data.answer,
      },
    });

    for (const domainId of uniqueDomainIds) {
      await prisma.qADomain.upsert({
        where: { qaId_domainId: { qaId: created.id, domainId } },
        update: {},
        create: { qaId: created.id, domainId },
      });
    }

    results.qaPairsCreated++;
  }

  // Process uncertainties
  const uncertainties = verifiedItems.filter((i) => i.itemType === 'UNCERTAINTY');
  for (const item of uncertainties) {
    const data = item.data as {
      type: string;
      description: string;
      suggestedQuestion: string;
    };
    await prisma.aIQuestion.create({
      data: {
        issueType: data.type,
        question: data.suggestedQuestion,
        context: { description: data.description },
      },
    });
    results.aiQuestionsCreated++;
  }

  // Process chunks in batches
  const chunks = verifiedItems.filter((i) => i.itemType === 'CHUNK');
  const CHUNK_BATCH_SIZE = 5;

  for (let batchStart = 0; batchStart < chunks.length; batchStart += CHUNK_BATCH_SIZE) {
    const batchChunks = chunks.slice(batchStart, batchStart + CHUNK_BATCH_SIZE);
    const batchContents = batchChunks.map((c) => (c.data as { content: string }).content);
    const batchEmbeddings = await generateEmbeddings(batchContents);

    for (let i = 0; i < batchChunks.length; i++) {
      const item = batchChunks[i];
      const data = item.data as {
        index: number;
        content: string;
        metadata: { startChar: number; endChar: number };
      };

      const created = await prisma.docChunk.create({
        data: {
          documentId,
          chunkIndex: data.index,
          content: data.content,
          embedding: batchEmbeddings[i],
          metadata: data.metadata,
        },
      });

      for (const domainId of uniqueDomainIds) {
        await prisma.chunkDomain.upsert({
          where: { chunkId_domainId: { chunkId: created.id, domainId } },
          update: {},
          create: { chunkId: created.id, domainId },
        });
      }

      results.chunksCreated++;
    }
  }

  await prisma.document.update({
    where: { id: documentId },
    data: { parseStatus: 'COMPLETED' },
  });

  await prisma.stagedExtraction.deleteMany({
    where: { documentId, isVerified: true },
  });

  return {
    success: true,
    message: 'Данные успешно сохранены',
    results,
  };
}
