import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { requireAdminAuth } from '@/lib/auth';
import { generateEmbeddings } from '@/lib/openai';

// POST - сохранить верифицированные элементы в финальные таблицы
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  const { id: documentId } = await params;

  try {
    // Get the document
    const document = await prisma.document.findUnique({
      where: { id: documentId },
    });

    if (!document) {
      return NextResponse.json(
        { error: 'Документ не найден' },
        { status: 404 }
      );
    }

    // Get all verified staged items
    const verifiedItems = await prisma.stagedExtraction.findMany({
      where: {
        documentId,
        isVerified: true,
      },
    });

    if (verifiedItems.length === 0) {
      console.log('[COMMIT] No verified items found - likely already saved');
      return NextResponse.json(
        {
          success: true,
          message: 'Все элементы уже сохранены',
          results: {
            domainsLinked: 0,
            domainSuggestionsCreated: 0,
            rulesCreated: 0,
            qaPairsCreated: 0,
            aiQuestionsCreated: 0,
            chunksCreated: 0,
          }
        },
        { status: 200 }
      );
    }

    const results = {
      domainsLinked: 0,
      domainSuggestionsCreated: 0,
      rulesCreated: 0,
      qaPairsCreated: 0,
      aiQuestionsCreated: 0,
      chunksCreated: 0,
    };

    // Collect domain IDs for linking rules and QAs
    const domainIds: string[] = [];

    console.log(`[COMMIT] Processing ${verifiedItems.length} verified items`);

    // Process domain assignments
    const domainAssignments = verifiedItems.filter(
      (i) => i.itemType === 'DOMAIN_ASSIGNMENT'
    );
    console.log(`[COMMIT] Found ${domainAssignments.length} domain assignments`);
    for (const item of domainAssignments) {
      const data = item.data as {
        primaryDomainSlug: string;
        secondaryDomainSlugs: string[];
        confidence: number;
      };

      // Link primary domain
      const primaryDomain = await prisma.domain.findUnique({
        where: { slug: data.primaryDomainSlug },
      });

      if (primaryDomain) {
        await prisma.documentDomain.upsert({
          where: {
            documentId_domainId: {
              documentId,
              domainId: primaryDomain.id,
            },
          },
          update: {
            isPrimary: true,
            confidence: data.confidence,
          },
          create: {
            documentId,
            domainId: primaryDomain.id,
            isPrimary: true,
            confidence: data.confidence,
          },
        });
        domainIds.push(primaryDomain.id);
        results.domainsLinked++;
      }

      // Link secondary domains
      for (const secondarySlug of data.secondaryDomainSlugs) {
        const secondaryDomain = await prisma.domain.findUnique({
          where: { slug: secondarySlug },
        });

        if (secondaryDomain) {
          await prisma.documentDomain.upsert({
            where: {
              documentId_domainId: {
                documentId,
                domainId: secondaryDomain.id,
              },
            },
            update: {
              isPrimary: false,
              confidence: data.confidence * 0.8,
            },
            create: {
              documentId,
              domainId: secondaryDomain.id,
              isPrimary: false,
              confidence: data.confidence * 0.8,
            },
          });
          domainIds.push(secondaryDomain.id);
          results.domainsLinked++;
        }
      }
    }

    // Process domain suggestions
    const domainSuggestions = verifiedItems.filter(
      (i) => i.itemType === 'DOMAIN_SUGGESTION'
    );
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

    // Deduplicate domain IDs to prevent unique constraint violations
    const uniqueDomainIds = [...new Set(domainIds)];
    console.log(`[COMMIT] Deduplicated domains: ${domainIds.length} -> ${uniqueDomainIds.length} unique`);

    // Track rule codes for QA linking
    const ruleCodeToId = new Map<string, string>();

    // Process rules
    const rules = verifiedItems.filter((i) => i.itemType === 'RULE');
    console.log(`[COMMIT] Found ${rules.length} rules to process`);
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

      // Link rule to domains (using deduplicated list)
      for (const domainId of uniqueDomainIds) {
        await prisma.ruleDomain.upsert({
          where: {
            ruleId_domainId: {
              ruleId: created.id,
              domainId,
            },
          },
          update: {
            confidence: data.confidence,
          },
          create: {
            ruleId: created.id,
            domainId,
            confidence: data.confidence,
          },
        });
      }

      results.rulesCreated++;
    }

    console.log(`[COMMIT] Completed rules: ${results.rulesCreated}`);

    // Process QA pairs
    const qaPairs = verifiedItems.filter((i) => i.itemType === 'QA_PAIR');
    console.log(`[COMMIT] Found ${qaPairs.length} QA pairs to process`);
    for (const item of qaPairs) {
      const data = item.data as {
        question: string;
        answer: string;
        linkedRuleCode: string | null;
      };

      const ruleId = data.linkedRuleCode
        ? ruleCodeToId.get(data.linkedRuleCode)
        : null;

      const created = await prisma.qAPair.create({
        data: {
          documentId,
          ruleId: ruleId || null,
          question: data.question,
          answer: data.answer,
        },
      });

      // Link QA to domains (using deduplicated list)
      for (const domainId of uniqueDomainIds) {
        await prisma.qADomain.upsert({
          where: {
            qaId_domainId: {
              qaId: created.id,
              domainId,
            },
          },
          update: {},
          create: {
            qaId: created.id,
            domainId,
          },
        });
      }

      results.qaPairsCreated++;
    }

    console.log(`[COMMIT] Completed QA pairs: ${results.qaPairsCreated}`);

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

    console.log(`[COMMIT] Completed AI questions: ${results.aiQuestionsCreated}`);

    // Process chunks in batches to avoid memory issues
    const chunks = verifiedItems.filter((i) => i.itemType === 'CHUNK');
    console.log(`[COMMIT] Found ${chunks.length} chunks to process`);
    const CHUNK_BATCH_SIZE = 5;

    for (let batchStart = 0; batchStart < chunks.length; batchStart += CHUNK_BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + CHUNK_BATCH_SIZE, chunks.length);
      const batchChunks = chunks.slice(batchStart, batchEnd);

      console.log(`[COMMIT] Processing chunk batch ${Math.floor(batchStart / CHUNK_BATCH_SIZE) + 1}/${Math.ceil(chunks.length / CHUNK_BATCH_SIZE)}`);

      // Generate embeddings for this batch only
      const batchContents = batchChunks.map(
        (c) => (c.data as { content: string }).content
      );
      console.log(`[COMMIT] Generating embeddings for ${batchContents.length} chunks...`);
      const batchEmbeddings = await generateEmbeddings(batchContents);
      console.log(`[COMMIT] Generated ${batchEmbeddings.length} embeddings`);

      // Save batch to database immediately
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

        // Link chunk to domains (using deduplicated list)
        for (const domainId of uniqueDomainIds) {
          await prisma.chunkDomain.upsert({
            where: {
              chunkId_domainId: {
                chunkId: created.id,
                domainId,
              },
            },
            update: {},
            create: {
              chunkId: created.id,
              domainId,
            },
          });
        }

        results.chunksCreated++;
      }
    }

    // Update document status
    await prisma.document.update({
      where: { id: documentId },
      data: { parseStatus: 'COMPLETED' },
    });

    // Delete committed staged items
    await prisma.stagedExtraction.deleteMany({
      where: {
        documentId,
        isVerified: true,
      },
    });

    return NextResponse.json({
      success: true,
      message: 'Данные успешно сохранены',
      results,
    });
  } catch (error) {
    console.error('[COMMIT ERROR] Full error details:', error);
    console.error('[COMMIT ERROR] Error name:', error instanceof Error ? error.name : 'Unknown');
    console.error('[COMMIT ERROR] Error message:', error instanceof Error ? error.message : String(error));
    console.error('[COMMIT ERROR] Error stack:', error instanceof Error ? error.stack : 'No stack');

    const errorMessage = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        error: 'Не удалось сохранить данные',
        details: errorMessage,
        phase: 'commit'
      },
      { status: 500 }
    );
  }
}
