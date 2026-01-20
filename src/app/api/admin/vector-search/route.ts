import { NextRequest, NextResponse } from 'next/server';
import { requireAdminAuth } from '@/lib/auth';
import {
  migrateEmbeddingsToPgvector,
  createVectorIndex,
} from '@/lib/ai/vector-search';
import prisma from '@/lib/db';

/**
 * GET /api/admin/vector-search
 * Get status of vector search capabilities
 */
export async function GET(request: NextRequest) {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  try {
    // Check pgvector availability
    let pgvectorEnabled = false;
    try {
      await prisma.$queryRaw`SELECT 1 FROM pg_extension WHERE extname = 'vector'`;
      pgvectorEnabled = true;
    } catch {
      pgvectorEnabled = false;
    }

    // Count chunks with various embedding states
    const totalChunks = await prisma.docChunk.count();

    // Count chunks with JSON embedding using raw query (Prisma Json filtering is complex)
    const embeddingCountResult = await prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count FROM "DocChunk" WHERE "embedding" IS NOT NULL
    `;
    const chunksWithJsonEmbedding = Number(embeddingCountResult[0].count);

    let chunksWithVectorEmbedding = 0;
    if (pgvectorEnabled) {
      const result = await prisma.$queryRaw<[{ count: bigint }]>`
        SELECT COUNT(*) as count FROM "DocChunk" WHERE "embeddingVector" IS NOT NULL
      `;
      chunksWithVectorEmbedding = Number(result[0].count);
    }

    // Check for HNSW index
    let hnswIndexExists = false;
    if (pgvectorEnabled) {
      try {
        const indexCheck = await prisma.$queryRaw<Array<{ indexname: string }>>`
          SELECT indexname FROM pg_indexes
          WHERE tablename = 'DocChunk' AND indexname LIKE '%embedding%hnsw%'
        `;
        hnswIndexExists = indexCheck.length > 0;
      } catch {
        hnswIndexExists = false;
      }
    }

    return NextResponse.json({
      pgvector: {
        enabled: pgvectorEnabled,
        indexCreated: hnswIndexExists,
      },
      embeddings: {
        total: totalChunks,
        withJsonEmbedding: chunksWithJsonEmbedding,
        withVectorEmbedding: chunksWithVectorEmbedding,
        migrationNeeded: chunksWithJsonEmbedding > chunksWithVectorEmbedding,
        migrationProgress: totalChunks > 0
          ? Math.round((chunksWithVectorEmbedding / totalChunks) * 100)
          : 100,
      },
    });
  } catch (error) {
    console.error('Vector search status error:', error);
    return NextResponse.json(
      { error: 'Failed to get vector search status' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/admin/vector-search
 * Run vector search operations (migrate, create index)
 */
export async function POST(request: NextRequest) {
  const authError = await requireAdminAuth(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { action } = body;

    switch (action) {
      case 'enable_pgvector': {
        // Enable pgvector extension
        await prisma.$executeRaw`CREATE EXTENSION IF NOT EXISTS vector`;
        return NextResponse.json({ success: true, message: 'pgvector extension enabled' });
      }

      case 'migrate_embeddings': {
        const batchSize = body.batchSize || 100;
        const result = await migrateEmbeddingsToPgvector(batchSize);
        return NextResponse.json({
          success: true,
          migrated: result.migrated,
          errors: result.errors,
          message: `Migrated ${result.migrated} embeddings with ${result.errors} errors`,
        });
      }

      case 'create_index': {
        await createVectorIndex();
        return NextResponse.json({
          success: true,
          message: 'HNSW index created for vector search',
        });
      }

      case 'full_setup': {
        // Run all setup steps
        const steps: { step: string; success: boolean; message: string }[] = [];

        // Step 1: Enable pgvector
        try {
          await prisma.$executeRaw`CREATE EXTENSION IF NOT EXISTS vector`;
          steps.push({ step: 'enable_pgvector', success: true, message: 'Extension enabled' });
        } catch (e) {
          steps.push({ step: 'enable_pgvector', success: false, message: String(e) });
        }

        // Step 2: Migrate embeddings
        try {
          const result = await migrateEmbeddingsToPgvector(100);
          steps.push({
            step: 'migrate_embeddings',
            success: true,
            message: `Migrated ${result.migrated} embeddings`,
          });
        } catch (e) {
          steps.push({ step: 'migrate_embeddings', success: false, message: String(e) });
        }

        // Step 3: Create index
        try {
          await createVectorIndex();
          steps.push({ step: 'create_index', success: true, message: 'Index created' });
        } catch (e) {
          steps.push({ step: 'create_index', success: false, message: String(e) });
        }

        const allSuccess = steps.every(s => s.success);
        return NextResponse.json({
          success: allSuccess,
          steps,
          message: allSuccess ? 'Full setup completed' : 'Setup completed with errors',
        });
      }

      default:
        return NextResponse.json(
          { error: 'Unknown action. Valid actions: enable_pgvector, migrate_embeddings, create_index, full_setup' },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('Vector search operation error:', error);
    return NextResponse.json(
      { error: 'Operation failed', details: String(error) },
      { status: 500 }
    );
  }
}
