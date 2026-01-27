import prisma from '@/lib/db';
import { generateEmbeddings } from '@/lib/openai';

const CHUNK_SIZE = 1000; // characters
const CHUNK_OVERLAP = 200; // characters

export interface TextChunk {
  content: string;
  index: number;
  metadata: {
    startChar: number;
    endChar: number;
  };
}

// Cosine similarity calculation
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

export function splitTextIntoChunks(text: string): TextChunk[] {
  console.log(`[Chunker] splitTextIntoChunks called with ${text.length} chars`);
  const chunks: TextChunk[] = [];
  let startChar = 0;
  let index = 0;

  console.log(`[Chunker] Starting while loop...`);
  // Process text in streaming fashion to reduce memory pressure
  while (startChar < text.length) {
    let endChar = startChar + CHUNK_SIZE;

    // Try to break at a sentence or paragraph boundary
    if (endChar < text.length) {
      const searchStart = Math.max(0, endChar - 100);
      const searchEnd = Math.min(text.length, endChar + 100);
      const searchWindow = text.slice(searchStart, searchEnd);
      const breakPoints = ['\n\n', '.\n', '. ', '\n'];

      for (const breakPoint of breakPoints) {
        const breakIndex = searchWindow.lastIndexOf(breakPoint);
        if (breakIndex !== -1) {
          endChar = searchStart + breakIndex + breakPoint.length;
          break;
        }
      }
    } else {
      endChar = text.length;
    }

    const content = text.slice(startChar, endChar).trim();

    if (content.length > 50) {
      chunks.push({
        content,
        index,
        metadata: {
          startChar,
          endChar,
        },
      });
      index++;
    }

    // If we reached the end of text, break to avoid infinite loop
    if (endChar >= text.length) {
      console.log(`[Chunker] Reached end of text, breaking loop`);
      break;
    }
    
    startChar = endChar - CHUNK_OVERLAP;
    if (startChar >= text.length - 50) break;
    
    // Yield to event loop periodically to prevent blocking
    // (helps in serverless environments like Railway)
    if (index % 10 === 0 && global.gc) {
      global.gc();
    }
  }

  console.log(`[Chunker] While loop complete. Created ${chunks.length} chunks from ${text.length} characters`);
  console.log(`[Chunker] Returning chunks array...`);
  return chunks;
}

// Process embeddings in small batches to avoid memory issues
// EXTREME: Process 1 at a time for Railway free tier
const EMBEDDING_BATCH_SIZE = 1;

export async function createDocumentChunks(
  documentId: string,
  text: string,
  domainIds: string[]
) {
  const chunks = splitTextIntoChunks(text);

  if (chunks.length === 0) {
    return [];
  }

  const createdChunkIds: string[] = [];

  // Process chunks in batches to reduce memory usage
  for (let batchStart = 0; batchStart < chunks.length; batchStart += EMBEDDING_BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + EMBEDDING_BATCH_SIZE, chunks.length);
    const batchChunks = chunks.slice(batchStart, batchEnd);

    // Generate embeddings for this batch only
    const batchEmbeddings = await generateEmbeddings(batchChunks.map((c) => c.content));

    // Save batch to database immediately
    for (let i = 0; i < batchChunks.length; i++) {
      const chunk = batchChunks[i];
      const embedding = batchEmbeddings[i];

      // Create chunk record with embedding as JSON
      const created = await prisma.docChunk.create({
        data: {
          documentId,
          chunkIndex: chunk.index,
          content: chunk.content,
          embedding: embedding,
          metadata: chunk.metadata,
        },
      });

      // Link chunk to domains
      for (const domainId of domainIds) {
        await prisma.chunkDomain.create({
          data: {
            chunkId: created.id,
            domainId,
          },
        });
      }

      createdChunkIds.push(created.id);
    }

    // Allow garbage collection between batches
    if (global.gc) {
      global.gc();
    }
  }

  return createdChunkIds;
}

export async function searchSimilarChunks(
  query: string,
  domainSlugs: string[] = [],
  limit: number = 5
): Promise<{ id: string; content: string; similarity: number; documentId: string }[]> {
  // Generate query embedding
  const queryEmbeddings = await generateEmbeddings([query]);
  const queryEmbedding = queryEmbeddings[0];

  // Fetch chunks with their embeddings
  let chunks;

  if (domainSlugs.length > 0) {
    chunks = await prisma.docChunk.findMany({
      where: {
        domains: {
          some: {
            domain: {
              slug: { in: domainSlugs },
            },
          },
        },
      },
      select: {
        id: true,
        content: true,
        documentId: true,
        embedding: true,
      },
    });
  } else {
    chunks = await prisma.docChunk.findMany({
      select: {
        id: true,
        content: true,
        documentId: true,
        embedding: true,
      },
    });
  }

  // Calculate similarities
  const results = chunks
    .map((chunk) => {
      const chunkEmbedding = chunk.embedding as number[] | null;
      if (!chunkEmbedding) return null;

      const similarity = cosineSimilarity(queryEmbedding, chunkEmbedding);
      return {
        id: chunk.id,
        content: chunk.content,
        documentId: chunk.documentId,
        similarity,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return results;
}
