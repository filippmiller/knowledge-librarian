/**
 * Vector Search Module with pgvector support
 *
 * Provides efficient vector similarity search using PostgreSQL's pgvector extension.
 * Falls back to in-memory cosine similarity if pgvector is not available.
 */

import prisma from '@/lib/db';
import { generateEmbeddings, EMBEDDING_DIMENSIONS } from '@/lib/openai';
import { Prisma } from '@prisma/client';

export interface SearchResult {
  id: string;
  content: string;
  documentId: string;
  similarity: number;
  metadata?: Record<string, unknown>;
}

export interface HybridSearchResult extends SearchResult {
  semanticScore: number;
  keywordScore: number;
  combinedScore: number;
}

/**
 * Check if pgvector extension AND embeddingVector column are available
 */
let pgvectorAvailable: boolean | null = null;

async function checkPgvectorAvailable(): Promise<boolean> {
  if (pgvectorAvailable !== null) return pgvectorAvailable;

  try {
    // Check both: extension exists AND column exists
    const extCheck = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS(SELECT 1 FROM pg_extension WHERE extname = 'vector') as exists
    `;
    
    if (!extCheck[0]?.exists) {
      console.log('[vector-search] pgvector extension not found, using in-memory search');
      pgvectorAvailable = false;
      return false;
    }

    // Check if embeddingVector column exists in DocChunk table
    const colCheck = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS(
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'DocChunk' AND column_name = 'embeddingVector'
      ) as exists
    `;
    
    if (!colCheck[0]?.exists) {
      console.log('[vector-search] embeddingVector column not found, using in-memory search');
      pgvectorAvailable = false;
      return false;
    }

    console.log('[vector-search] pgvector is fully available');
    pgvectorAvailable = true;
  } catch (error) {
    console.error('[vector-search] Error checking pgvector availability:', error);
    pgvectorAvailable = false;
  }

  return pgvectorAvailable;
}

/**
 * Reset pgvector availability check (useful after migrations)
 */
export function resetPgvectorCheck(): void {
  pgvectorAvailable = null;
}

/**
 * Search for similar chunks using pgvector's native cosine similarity
 */
export async function searchSimilarChunksPgvector(
  queryEmbedding: number[],
  domainSlugs: string[] = [],
  limit: number = 5,
  minSimilarity: number = 0.3
): Promise<SearchResult[]> {
  try {
    const embeddingStr = `[${queryEmbedding.join(',')}]`;

    // Build domain filter
    let domainFilter = '';
    if (domainSlugs.length > 0) {
      const slugList = domainSlugs.map(s => `'${s}'`).join(',');
      domainFilter = `
        AND c.id IN (
          SELECT cd."chunkId"
          FROM "ChunkDomain" cd
          JOIN "Domain" d ON d.id = cd."domainId"
          WHERE d.slug IN (${slugList})
        )
      `;
    }

    // Use cosine distance operator <=> (returns 1 - similarity)
    const results = await prisma.$queryRaw<Array<{
      id: string;
      content: string;
      documentId: string;
      similarity: number;
      metadata: Prisma.JsonValue;
    }>>`
      SELECT
        c.id,
        c.content,
        c."documentId",
        1 - (c."embeddingVector" <=> ${embeddingStr}::vector) as similarity,
        c.metadata
      FROM "DocChunk" c
      WHERE c."embeddingVector" IS NOT NULL
      ${Prisma.raw(domainFilter)}
      AND 1 - (c."embeddingVector" <=> ${embeddingStr}::vector) >= ${minSimilarity}
      ORDER BY c."embeddingVector" <=> ${embeddingStr}::vector
      LIMIT ${limit}
    `;

    return results.map(r => ({
      id: r.id,
      content: r.content,
      documentId: r.documentId,
      similarity: Number(r.similarity),
      metadata: r.metadata as Record<string, unknown> | undefined,
    }));
  } catch (error) {
    // If pgvector query fails, reset availability flag so we use in-memory next time
    console.error('[vector-search] pgvector search failed, will fall back to in-memory:', error);
    pgvectorAvailable = false;
    throw error; // Re-throw so caller can handle fallback
  }
}

/**
 * Fallback: In-memory cosine similarity search (for when pgvector is unavailable)
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

async function searchSimilarChunksInMemory(
  queryEmbedding: number[],
  domainSlugs: string[] = [],
  limit: number = 5
): Promise<SearchResult[]> {
  const whereClause: Prisma.DocChunkWhereInput = domainSlugs.length > 0
    ? { domains: { some: { domain: { slug: { in: domainSlugs } } } } }
    : {};

  const chunks = await prisma.docChunk.findMany({
    where: whereClause,
    select: {
      id: true,
      content: true,
      documentId: true,
      embedding: true,
      metadata: true,
    },
  });

  const results: SearchResult[] = [];

  for (const chunk of chunks) {
    const chunkEmbedding = chunk.embedding as number[] | null;
    if (!chunkEmbedding) continue;

    const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding);
    if (similarity <= 0.3) continue;

    results.push({
      id: chunk.id,
      content: chunk.content,
      documentId: chunk.documentId,
      similarity,
      metadata: chunk.metadata as Record<string, unknown> | undefined,
    });
  }

  return results
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

/**
 * Main search function - automatically selects best available method
 */
export async function searchSimilarChunks(
  query: string,
  domainSlugs: string[] = [],
  limit: number = 5
): Promise<SearchResult[]> {
  // Generate query embedding
  const [queryEmbedding] = await generateEmbeddings([query]);

  const usePgvector = await checkPgvectorAvailable();

  if (usePgvector) {
    try {
      return await searchSimilarChunksPgvector(queryEmbedding, domainSlugs, limit);
    } catch (error) {
      // Fallback to in-memory if pgvector fails unexpectedly
      console.warn('[vector-search] Falling back to in-memory search due to pgvector error');
      return searchSimilarChunksInMemory(queryEmbedding, domainSlugs, limit);
    }
  } else {
    return searchSimilarChunksInMemory(queryEmbedding, domainSlugs, limit);
  }
}

/**
 * Keyword-based search using PostgreSQL full-text search
 * This complements semantic search for exact terminology matching
 */
export async function searchByKeywords(
  query: string,
  domainSlugs: string[] = [],
  limit: number = 10
): Promise<SearchResult[]> {
  // Normalize query for Russian text search
  const normalizedQuery = query
    .toLowerCase()
    .replace(/[^\wа-яё\s]/gi, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2)
    .join(' & ');

  if (!normalizedQuery) return [];

  let domainFilter = '';
  if (domainSlugs.length > 0) {
    const slugList = domainSlugs.map(s => `'${s}'`).join(',');
    domainFilter = `
      AND c.id IN (
        SELECT cd."chunkId"
        FROM "ChunkDomain" cd
        JOIN "Domain" d ON d.id = cd."domainId"
        WHERE d.slug IN (${slugList})
      )
    `;
  }

  try {
    // Use PostgreSQL full-text search with Russian configuration
    const results = await prisma.$queryRaw<Array<{
      id: string;
      content: string;
      documentId: string;
      rank: number;
    }>>`
      SELECT
        c.id,
        c.content,
        c."documentId",
        ts_rank(to_tsvector('russian', c.content), plainto_tsquery('russian', ${query})) as rank
      FROM "DocChunk" c
      WHERE to_tsvector('russian', c.content) @@ plainto_tsquery('russian', ${query})
      ${Prisma.raw(domainFilter)}
      ORDER BY rank DESC
      LIMIT ${limit}
    `;

    return results.map(r => ({
      id: r.id,
      content: r.content,
      documentId: r.documentId,
      similarity: Math.min(Number(r.rank) / 0.5, 1), // Normalize rank to 0-1
    }));
  } catch {
    // Fallback to simple ILIKE search if full-text fails
    const searchTerms = query.split(/\s+/).filter(t => t.length > 2);
    if (searchTerms.length === 0) return [];

    const whereClause: Prisma.DocChunkWhereInput = {
      AND: [
        {
          OR: searchTerms.map(term => ({
            content: { contains: term, mode: 'insensitive' as const },
          })),
        },
        domainSlugs.length > 0
          ? { domains: { some: { domain: { slug: { in: domainSlugs } } } } }
          : {},
      ],
    };

    const chunks = await prisma.docChunk.findMany({
      where: whereClause,
      take: limit,
      select: {
        id: true,
        content: true,
        documentId: true,
      },
    });

    return chunks.map((c, i) => ({
      id: c.id,
      content: c.content,
      documentId: c.documentId,
      similarity: 0.5 - (i * 0.05), // Decreasing scores
    }));
  }
}

/**
 * Hybrid search combining semantic and keyword search
 * Uses Reciprocal Rank Fusion (RRF) to merge results
 */
export async function hybridSearch(
  query: string,
  domainSlugs: string[] = [],
  limit: number = 5,
  semanticWeight: number = 0.7
): Promise<HybridSearchResult[]> {
  // Run both searches in parallel
  const [semanticResults, keywordResults] = await Promise.all([
    searchSimilarChunks(query, domainSlugs, limit * 2),
    searchByKeywords(query, domainSlugs, limit * 2),
  ]);

  // Build combined results using RRF
  const k = 60; // RRF constant
  const combinedScores = new Map<string, {
    result: SearchResult;
    semanticScore: number;
    keywordScore: number;
    semanticRank: number;
    keywordRank: number;
  }>();

  // Process semantic results
  semanticResults.forEach((result, index) => {
    combinedScores.set(result.id, {
      result,
      semanticScore: result.similarity,
      keywordScore: 0,
      semanticRank: index + 1,
      keywordRank: Infinity,
    });
  });

  // Process keyword results
  keywordResults.forEach((result, index) => {
    const existing = combinedScores.get(result.id);
    if (existing) {
      existing.keywordScore = result.similarity;
      existing.keywordRank = index + 1;
    } else {
      combinedScores.set(result.id, {
        result,
        semanticScore: 0,
        keywordScore: result.similarity,
        semanticRank: Infinity,
        keywordRank: index + 1,
      });
    }
  });

  // Calculate RRF scores
  const results: HybridSearchResult[] = Array.from(combinedScores.values()).map(entry => {
    const semanticRRF = entry.semanticRank !== Infinity ? 1 / (k + entry.semanticRank) : 0;
    const keywordRRF = entry.keywordRank !== Infinity ? 1 / (k + entry.keywordRank) : 0;
    const combinedScore = semanticWeight * semanticRRF + (1 - semanticWeight) * keywordRRF;

    return {
      ...entry.result,
      semanticScore: entry.semanticScore,
      keywordScore: entry.keywordScore,
      combinedScore,
    };
  });

  // Sort by combined score and return top results
  return results
    .sort((a, b) => b.combinedScore - a.combinedScore)
    .slice(0, limit);
}

/**
 * Store embedding in pgvector format (for new chunks)
 */
export async function storeEmbeddingVector(
  chunkId: string,
  embedding: number[]
): Promise<void> {
  const usePgvector = await checkPgvectorAvailable();
  if (!usePgvector) return;

  const embeddingStr = `[${embedding.join(',')}]`;

  await prisma.$executeRaw`
    UPDATE "DocChunk"
    SET "embeddingVector" = ${embeddingStr}::vector
    WHERE id = ${chunkId}
  `;
}

/**
 * Migrate existing JSON embeddings to pgvector format
 */
export async function migrateEmbeddingsToPgvector(
  batchSize: number = 100
): Promise<{ migrated: number; errors: number }> {
  const usePgvector = await checkPgvectorAvailable();
  if (!usePgvector) {
    throw new Error('pgvector extension is not available');
  }

  let migrated = 0;
  let errors = 0;
  let hasMore = true;

  while (hasMore) {
    // Find chunks with JSON embedding but no vector embedding
    const chunks = await prisma.$queryRaw<Array<{
      id: string;
      embedding: number[];
    }>>`
      SELECT id, embedding
      FROM "DocChunk"
      WHERE embedding IS NOT NULL
        AND "embeddingVector" IS NULL
      LIMIT ${batchSize}
    `;

    if (chunks.length === 0) {
      hasMore = false;
      continue;
    }

    for (const chunk of chunks) {
      try {
        if (Array.isArray(chunk.embedding) && chunk.embedding.length === EMBEDDING_DIMENSIONS) {
          await storeEmbeddingVector(chunk.id, chunk.embedding);
          migrated++;
        }
      } catch (e) {
        console.error(`Failed to migrate chunk ${chunk.id}:`, e);
        errors++;
      }
    }
  }

  return { migrated, errors };
}

/**
 * Create HNSW index for fast approximate nearest neighbor search
 */
export async function createVectorIndex(): Promise<void> {
  const usePgvector = await checkPgvectorAvailable();
  if (!usePgvector) {
    throw new Error('pgvector extension is not available');
  }

  // HNSW index provides good balance of speed and accuracy
  await prisma.$executeRaw`
    CREATE INDEX IF NOT EXISTS idx_docchunk_embedding_hnsw
    ON "DocChunk"
    USING hnsw ("embeddingVector" vector_cosine_ops)
    WITH (m = 16, ef_construction = 64)
  `;
}
