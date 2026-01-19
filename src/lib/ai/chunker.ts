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

  // Store chunks with embeddings
  const createdChunks = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const embedding = embeddings[i];

    // Create chunk record
    const created = await prisma.docChunk.create({
      data: {
        documentId,
        chunkIndex: chunk.index,
        content: chunk.content,
        metadata: chunk.metadata,
      },
    });

    // Store embedding using raw SQL (pgvector)
    await prisma.$executeRaw`
      UPDATE "DocChunk"
      SET embedding = ${embedding}::vector
      WHERE id = ${created.id}
    `;

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
  const queryEmbedding = await generateEmbeddings([query]);
  const embedding = queryEmbedding[0];

  let results;

  if (domainSlugs.length > 0) {
    // Domain-filtered search
    results = await prisma.$queryRaw<
      { id: string; content: string; similarity: number; documentId: string }[]
    >`
      SELECT DISTINCT c.id, c.content, c."documentId",
        1 - (c.embedding <=> ${embedding}::vector) as similarity
      FROM "DocChunk" c
      JOIN "ChunkDomain" cd ON cd."chunkId" = c.id
      JOIN "Domain" d ON d.id = cd."domainId"
      WHERE d.slug = ANY(${domainSlugs})
        AND c.embedding IS NOT NULL
      ORDER BY similarity DESC
      LIMIT ${limit}
    `;
  } else {
    // Global search
    results = await prisma.$queryRaw<
      { id: string; content: string; similarity: number; documentId: string }[]
    >`
      SELECT c.id, c.content, c."documentId",
        1 - (c.embedding <=> ${embedding}::vector) as similarity
      FROM "DocChunk" c
      WHERE c.embedding IS NOT NULL
      ORDER BY similarity DESC
      LIMIT ${limit}
    `;
  }

  return results;
}
