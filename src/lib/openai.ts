import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { Stream } from 'openai/streaming';

if (!process.env.OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set');
}

export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || '',
});

export const EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
export const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-4o';
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

// Streaming chat completion
export interface StreamChatOptions {
  model?: string;
  messages: ChatCompletionMessageParam[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json_object';
}

export async function streamChatCompletion(
  options: StreamChatOptions
): Promise<Stream<ChatCompletionChunk>> {
  const {
    model = CHAT_MODEL,
    messages,
    temperature = 0.3,
    maxTokens,
    responseFormat,
  } = options;

  const stream = await openai.chat.completions.create({
    model,
    messages,
    temperature,
    ...(maxTokens && { max_tokens: maxTokens }),
    ...(responseFormat && { response_format: { type: responseFormat } }),
    stream: true,
  });

  return stream;
}

// Helper to collect full response from stream
export async function collectStreamResponse(
  stream: Stream<ChatCompletionChunk>
): Promise<string> {
  let fullContent = '';

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || '';
    fullContent += content;
  }

  return fullContent;
}

// Create OpenAI client with custom API key (for stored keys)
export function createOpenAIClient(apiKey: string): OpenAI {
  return new OpenAI({ apiKey });
}

export async function streamChatCompletionWithKey(
  apiKey: string,
  options: StreamChatOptions
): Promise<Stream<ChatCompletionChunk>> {
  const client = createOpenAIClient(apiKey);

  const {
    model = CHAT_MODEL,
    messages,
    temperature = 0.3,
    maxTokens,
    responseFormat,
  } = options;

  const stream = await client.chat.completions.create({
    model,
    messages,
    temperature,
    ...(maxTokens && { max_tokens: maxTokens }),
    ...(responseFormat && { response_format: { type: responseFormat } }),
    stream: true,
  });

  return stream;
}
