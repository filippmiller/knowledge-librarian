import prisma from '@/lib/db';
import { generateEmbeddings } from '@/lib/openai';
import { lintRules, type LintInput, type LintWarning } from './extraction-lint';

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
  /** Quality-gate warnings on the extracted rules (non-blocking, for admin review). */
  qualityWarnings?: LintWarning[];
}

export interface CommitOptions {
  replaceExisting?: boolean;
  /**
   * When true, treat all non-rejected staged items as verified.
   * Use this when calling from an automated flow that doesn't require
   * human review (e.g. direct admin API commit without the UI review step).
   */
  autoVerifyPending?: boolean;
}

async function resetCommittedDocumentKnowledge(documentId: string) {
  const qaPairs = await prisma.qAPair.findMany({
    where: { documentId },
    select: { id: true },
  });
  const qaPairIds = qaPairs.map((qa) => qa.id);
  if (qaPairIds.length > 0) {
    await prisma.knowledgeChange.deleteMany({
      where: { targetType: 'QA_PAIR', targetId: { in: qaPairIds } },
    });
  }
  await prisma.qAPair.deleteMany({ where: { documentId } });

  const rules = await prisma.rule.findMany({
    where: { documentId },
    select: { id: true },
  });
  const ruleIds = rules.map((rule) => rule.id);
  if (ruleIds.length > 0) {
    await prisma.knowledgeChange.deleteMany({
      where: { targetType: 'RULE', targetId: { in: ruleIds } },
    });
  }
  await prisma.rule.deleteMany({ where: { documentId } });

  await prisma.docChunk.deleteMany({ where: { documentId } });
  await prisma.documentDomain.deleteMany({ where: { documentId } });
  await prisma.domainSuggestion.deleteMany({ where: { createdFromDocumentId: documentId } });
}

/**
 * Commits all verified staged extractions for a document to the knowledge base.
 * Shared by both the admin panel commit endpoint and the Telegram mini-app.
 */
export async function commitDocumentKnowledge(documentId: string, options: CommitOptions = {}): Promise<CommitResult> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
  });

  if (!document) {
    throw new Error('Документ не найден');
  }

  // Auto-verify pending items if requested (used by admin commit without UI review)
  if (options.autoVerifyPending) {
    await prisma.stagedExtraction.updateMany({
      where: { documentId, isVerified: false, isRejected: false },
      data: { isVerified: true, verifiedAt: new Date() },
    });
  }

  const verifiedItems = await prisma.stagedExtraction.findMany({
    where: { documentId, isVerified: true },
  });

  if (verifiedItems.length === 0) {
    // Check if there are any staged items at all
    const totalStaged = await prisma.stagedExtraction.count({ where: { documentId } });
    if (totalStaged === 0) {
      console.log('[COMMIT] No staged items found - document may already be fully committed');
      // Mark document COMPLETED if it has rules/QA in the permanent tables
      const ruleCount = await prisma.rule.count({ where: { documentId } });
      if (ruleCount > 0) {
        await prisma.document.update({ where: { id: documentId }, data: { parseStatus: 'COMPLETED' } });
      }
      return {
        success: true,
        message: 'Документ уже сохранён в базу знаний',
        results: { domainsLinked: 0, domainSuggestionsCreated: 0, rulesCreated: 0, qaPairsCreated: 0, aiQuestionsCreated: 0, chunksCreated: 0 },
      };
    }
    console.log('[COMMIT] No verified items found - use autoVerifyPending:true or review items in the admin panel first');
    return {
      success: false,
      message: 'Нет подтверждённых элементов. Проверьте и подтвердите элементы в панели управления, или используйте параметр autoVerifyPending.',
      results: { domainsLinked: 0, domainSuggestionsCreated: 0, rulesCreated: 0, qaPairsCreated: 0, aiQuestionsCreated: 0, chunksCreated: 0 },
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
  if (options.replaceExisting) {
    await resetCommittedDocumentKnowledge(documentId);
  }

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

    for (const secondarySlug of (data.secondaryDomainSlugs ?? [])) {
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
  const lintInputs: LintInput[] = [];
  for (const item of rules) {
    const data = item.data as {
      ruleCode: string;
      title: string;
      body: string;
      confidence: number;
      sourceSpan: { quote: string; locationHint: string };
    };

    // Quality gate (non-blocking): collect for anti-hallucination / junk checks.
    lintInputs.push({
      ruleCode: data.ruleCode,
      title: data.title,
      body: data.body,
      sourceQuote: data.sourceSpan?.quote ?? '',
    });

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

  // Quality gate — surface (don't block) suspicious extractions for admin review.
  const qualityWarnings = lintRules(lintInputs);
  if (qualityWarnings.length > 0) {
    console.warn(`[COMMIT] ${qualityWarnings.length} quality warning(s) on document ${documentId}:`,
      qualityWarnings.map((w) => `${w.ruleCode}:${w.kind} (${w.detail})`).join(' | '));
    // Persist a review item so the warnings aren't lost in logs.
    await prisma.aIQuestion.create({
      data: {
        issueType: 'extraction_quality',
        question: `Документ ${document.title}: ${qualityWarnings.length} предупреждений качества при извлечении (проверьте правила).`,
        context: { documentId, warnings: qualityWarnings as unknown as object },
      },
    }).catch((e) => console.warn('[COMMIT] failed to persist quality warnings:', e));
  }

  // Process QA pairs
  const qaPairs = verifiedItems.filter((i) => i.itemType === 'QA_PAIR');
  for (const item of qaPairs) {
    const data = item.data as {
      question: string;
      answer: string;
      linkedRuleCode: string | null;
    };

    // Skip degenerate QA pairs emitted by the LLM (empty question or answer)
    if (!data.question?.trim() || !data.answer?.trim()) {
      console.warn(`[COMMIT] Skipping QA pair with empty question/answer for document ${documentId}`);
      continue;
    }

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
    message: qualityWarnings.length > 0
      ? `Данные сохранены. ⚠ ${qualityWarnings.length} предупреждений качества — проверьте в разделе AI-вопросов.`
      : 'Данные успешно сохранены',
    results,
    qualityWarnings,
  };
}
