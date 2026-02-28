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
      ? 'Respond with valid JSON only. Use double quotes for all keys and string values. Do not wrap in markdown or add commentary.'
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

/**
 * Robustly normalize and parse JSON from AI responses, even if truncated or wrapped in markdown.
 */
export function normalizeJsonResponse(raw: string): string {
  let trimmed = raw.trim();
  if (!trimmed) return '{}';

  // Strip code fences.  Use a position-based approach that is immune to ** inside JSON bodies.
  if (trimmed.startsWith('`')) {
    // Remove the opening fence line (e.g. ```json or ```)
    const firstNewline = trimmed.indexOf('\n');
    if (firstNewline !== -1) {
      trimmed = trimmed.slice(firstNewline + 1).trim();
    } else {
      trimmed = trimmed.replace(/^`+(?:json)?\s*/i, '').trim();
    }
    // Remove a closing fence (``` at start of a line, or at end of string)
    const closingFence = trimmed.lastIndexOf('\n```');
    if (closingFence !== -1) {
      trimmed = trimmed.slice(0, closingFence).trim();
    } else if (trimmed.endsWith('`')) {
      trimmed = trimmed.replace(/`+\s*$/, '').trim();
    }
  }

  // Find the first JSON-like start
  const startIndex = trimmed.search(/[{[]/);
  if (startIndex === -1) return '{}';
  trimmed = trimmed.slice(startIndex);

  // Escape literal newlines/carriage-returns inside JSON string values.
  // The AI sometimes puts real \n in long body fields, which makes JSON.parse fail.
  trimmed = escapeControlCharsInStrings(trimmed);

  // Attempt to fix truncated JSON by closing open brackets/braces
  const balanced = balanceJson(trimmed);

  const sanitized = coerceJsonSyntax(balanced);
  return sanitized;
}

/** Escape literal newlines/CRs that appear inside JSON string values. */
function escapeControlCharsInStrings(json: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        result += char;
      } else if (char === '\\') {
        escaped = true;
        result += char;
      } else if (char === '"') {
        inString = false;
        result += char;
      } else if (char === '\n') {
        result += '\\n';
      } else if (char === '\r') {
        result += '\\r';
      } else {
        result += char;
      }
    } else {
      if (char === '"') inString = true;
      result += char;
    }
  }

  return result;
}

function balanceJson(json: string): string {
  const stack: ('{' | '[')[] = [];
  let inString = false;
  let escaped = false;
  let lastValidIndex = 0;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
        lastValidIndex = i + 1;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{' || char === '[') {
      stack.push(char);
      lastValidIndex = i + 1;
      continue;
    }

    if (char === '}' || char === ']') {
      const last = stack[stack.length - 1];
      if ((char === '}' && last === '{') || (char === ']' && last === '[')) {
        stack.pop();
        lastValidIndex = i + 1;
      }
      continue;
    }

    if (/\s/.test(char) || char === ',' || char === ':' || /[0-9.-]/.test(char) || char === 't' || char === 'f' || char === 'n') {
      // Potentially valid middle characters, though basic check
    }
  }

  let result = json.slice(0, lastValidIndex);

  // If we are still in a string, close it
  if (inString) {
    result += '"';
  }

  // Close remaining open structures in reverse order
  for (let i = stack.length - 1; i >= 0; i--) {
    result += stack[i] === '{' ? '}' : ']';
  }

  return result;
}

function coerceJsonSyntax(candidate: string): string {
  try {
    // Try to parse as-is first
    JSON.parse(candidate);
    return candidate;
  } catch {
    // Basic cleanup and try again
    const sanitized = candidate
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([,{]\s*)'([^']+?)'\s*:/g, '$1"$2":')
      .replace(/:\s*'([^']*?)'/g, ': "$1"')
      .replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":');

    try {
      JSON.parse(sanitized);
      return sanitized;
    } catch {
      return '{}';
    }
  }
}

const RETRYABLE_STATUS_CODES = [429, 529, 503, 502];
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message;
    return RETRYABLE_STATUS_CODES.some(code => msg.includes(`(${code})`)) ||
      msg.includes('overloaded') ||
      msg.includes('rate_limit') ||
      msg.includes('ECONNRESET') ||
      msg.includes('ETIMEDOUT');
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callAnthropic(options: ChatCompletionOptions, temperature: number): Promise<string> {
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

  return content.trim();
}

async function callOpenAI(options: ChatCompletionOptions, temperature: number): Promise<string> {
  const response = await openai.chat.completions.create({
    model: options.model || DEFAULT_OPENAI_MODEL,
    messages: options.messages,
    temperature,
    ...(options.maxTokens && { max_tokens: options.maxTokens }),
    ...(options.responseFormat && {
      response_format: { type: options.responseFormat },
    }),
  });

  return response.choices[0]?.message?.content?.trim() || '';
}

export async function createChatCompletion(
  options: ChatCompletionOptions
): Promise<string> {
  const provider = getProvider();
  const temperature = options.temperature ?? DEFAULT_TEMPERATURE;

  // Try primary provider with retries
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const raw = provider === 'anthropic'
        ? await callAnthropic(options, temperature)
        : await callOpenAI(options, temperature);

      return options.responseFormat === 'json_object'
        ? normalizeJsonResponse(raw)
        : raw;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES && isRetryableError(error)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[chat-provider] ${provider} attempt ${attempt + 1} failed (retryable), waiting ${delay}ms...`);
        await sleep(delay);
        continue;
      }
      break;
    }
  }

  // Fallback to the other provider if primary exhausted retries
  const fallbackProvider = provider === 'anthropic' ? 'openai' : 'anthropic';
  const hasFallbackKey = fallbackProvider === 'openai'
    ? !!process.env.OPENAI_API_KEY
    : !!process.env.ANTHROPIC_API_KEY;

  if (hasFallbackKey) {
    console.warn(`[chat-provider] ${provider} failed after retries, falling back to ${fallbackProvider}`);
    try {
      const raw = fallbackProvider === 'openai'
        ? await callOpenAI(options, temperature)
        : await callAnthropic(options, temperature);

      return options.responseFormat === 'json_object'
        ? normalizeJsonResponse(raw)
        : raw;
    } catch (fallbackError) {
      console.error(`[chat-provider] Fallback ${fallbackProvider} also failed:`, fallbackError);
    }
  }

  // Both providers failed
  throw lastError;
}

export async function* streamChatCompletionTokens(
  options: ChatCompletionOptions,
  chunkSize = 120
): AsyncGenerator<string> {
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
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Anthropic API error (${response.status}): ${errorBody || 'Unknown error'}`
      );
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Failed to get response body reader');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const content = line.slice(6).trim();
          if (content === '[DONE]') break;
          try {
            const data = JSON.parse(content);
            if (data.type === 'content_block_delta' && data.delta?.text) {
              yield data.delta.text;
            }
          } catch (e) {
            // Ignore parse errors for non-json lines
          }
        }
      }
    }
    return;
  }

  // OpenAI streaming
  const stream = await openai.chat.completions.create({
    model: options.model || DEFAULT_OPENAI_MODEL,
    messages: options.messages,
    temperature,
    ...(options.maxTokens && { max_tokens: options.maxTokens }),
    ...(options.responseFormat && {
      response_format: { type: options.responseFormat },
    }),
    stream: true,
  });

  for await (const chunk of stream) {
    const content = chunk.choices[0]?.delta?.content || '';
    if (content) {
      yield content;
    }
  }
}
