import { openai, CHAT_MODEL as OPENAI_DEFAULT_MODEL } from '@/lib/openai';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export interface ChatCompletionOptions {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json_object';
}

type Provider = 'anthropic' | 'openai';

const DEFAULT_ANTHROPIC_MODEL =
  process.env.ANTHROPIC_MODEL || 'claude-3-opus-20240229';
const DEFAULT_OPENAI_MODEL =
  process.env.OPENAI_CHAT_MODEL || OPENAI_DEFAULT_MODEL;
const DEFAULT_TEMPERATURE = Number(process.env.AI_TEMPERATURE || 0.3);
const DEFAULT_ANTHROPIC_MAX_TOKENS = Number(
  process.env.ANTHROPIC_MAX_TOKENS || 2048
);

function getProvider(): Provider {
  const provider = (process.env.AI_PROVIDER || '').toLowerCase();
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'openai') return 'openai';
  return process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai';
}

function buildAnthropicPayload(options: ChatCompletionOptions) {
  const systemParts = options.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content.trim())
    .filter(Boolean);
  const userMessages = options.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  const responseFormatInstruction =
    options.responseFormat === 'json_object'
      ? 'Respond with valid JSON only. Do not wrap in markdown or add commentary.'
      : null;

  const system = [...systemParts, responseFormatInstruction]
    .filter(Boolean)
    .join('\n\n');

  return {
    system: system || undefined,
    messages: userMessages,
  };
}

function chunkText(text: string, size: number) {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    chunks.push(text.slice(i, i + size));
  }
  return chunks;
}

function normalizeJsonResponse(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    return fenced[1].trim();
  }

  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1).trim();
  }

  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    return trimmed.slice(firstBracket, lastBracket + 1).trim();
  }

  return trimmed;
}

export async function createChatCompletion(
  options: ChatCompletionOptions
): Promise<string> {
  const provider = getProvider();
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;

  if (provider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is not set');
    }

    const { system, messages } = buildAnthropicPayload(options);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: options.model || DEFAULT_ANTHROPIC_MODEL,
        system,
        messages,
        temperature,
        max_tokens: options.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Anthropic API error (${response.status}): ${errorBody || 'Unknown error'}`
      );
    }

    const data = (await response.json()) as {
      content?: { type: string; text?: string }[];
      error?: { message?: string };
    };

    if (data.error?.message) {
      throw new Error(`Anthropic API error: ${data.error.message}`);
    }

    const content = Array.isArray(data.content)
      ? data.content.map((part) => part.text || '').join('')
      : '';

    const trimmed = content.trim();
    return options.responseFormat === 'json_object'
      ? normalizeJsonResponse(trimmed)
      : trimmed;
  }

  const response = await openai.chat.completions.create({
    model: options.model || DEFAULT_OPENAI_MODEL,
    messages: options.messages,
    temperature,
    ...(options.maxTokens && { max_tokens: options.maxTokens }),
    ...(options.responseFormat && {
      response_format: { type: options.responseFormat },
    }),
  });

  const content = response.choices[0]?.message?.content?.trim() || '';
  return options.responseFormat === 'json_object'
    ? normalizeJsonResponse(content)
    : content;
}

export async function* streamChatCompletionTokens(
  options: ChatCompletionOptions,
  chunkSize = 120
): AsyncGenerator<string> {
  const content = await createChatCompletion(options);

  for (const chunk of chunkText(content, chunkSize)) {
    if (chunk) {
      yield chunk;
    }
  }
}
