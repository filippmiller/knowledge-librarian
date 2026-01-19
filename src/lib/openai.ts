import OpenAI from 'openai';

if (!process.env.OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set');
}

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
});

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const CHAT_MODEL = 'gpt-4o';
export const EMBEDDING_DIMENSIONS = 1536;

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data[0].embedding;
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data.map((d) => d.embedding);
}
