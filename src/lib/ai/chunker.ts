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
  const chunks: TextChunk[] = [];
  let startChar = 0;
  let index = 0;

  while (startChar < text.length) {
    let endChar = startChar + CHUNK_SIZE;

    // Try to break at a sentence or paragraph boundary
    if (endChar < text.length) {
      const searchWindow = text.slice(endChar - 100, endChar + 100);
      const breakPoints = ['\n\n', '.\n', '. ', '\n'];

      for (const breakPoint of breakPoints) {
        const breakIndex = searchWindow.lastIndexOf(breakPoint);
        if (breakIndex !== -1) {
          endChar = endChar - 100 + breakIndex + breakPoint.length;
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

    startChar = endChar - CHUNK_OVERLAP;
    if (startChar >= text.length - 50) break;
  }

  return chunks;
}

export async function createDocumentChunks(
  documentId: string,
  text: string,
  domainIds: string[]
) {
  const chunks = splitTextIntoChunks(text);

  if (chunks.length === 0) {
    return [];
  }

  // Generate embeddings for all chunks
  const embeddings = await generateEmbeddings(chunks.map((c) => c.content));

  // Store chunks with embeddings as JSON
  const createdChunks = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embedding = embeddings[i];

    // Create chunk record with embedding as JSON
    const created = await prisma.docChunk.create({
      data: {
        documentId,
        chunkIndex: chunk.index,
        content: chunk.content,
        embedding: embedding, // Store as JSON array
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

    createdChunks.push(created);
  }

  return createdChunks;
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
