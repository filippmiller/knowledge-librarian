import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  default: { llmCallLog: { create: createMock } },
  prisma: { llmCallLog: { create: createMock } },
}));

vi.mock('@/lib/openai', () => ({
  openai: { chat: { completions: { create: vi.fn() } } },
  CHAT_MODEL: 'gpt-4o',
}));

import { createChatCompletionDetailed } from '../chat-provider';

let fetchMock: ReturnType<typeof vi.fn>;

function anthropicOk(text: string): Response {
  const frames: Record<string, unknown>[] = [
    {
      type: 'message_start',
      message: { usage: { input_tokens: 10, output_tokens: 0 } },
    },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: 'message_stop' },
  ];
  return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n`).join(''), {
    status: 200,
  });
}

const MESSAGES = [
  { role: 'system' as const, content: 'ты консультант бюро переводов' },
  { role: 'user' as const, content: 'сколько стоит апостиль?' },
];

beforeEach(() => {
  createMock.mockReset();
  createMock.mockResolvedValue({ id: 'log-1' });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
  vi.stubEnv('AI_PROVIDER', 'anthropic');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('журнал вызовов в chat-provider', () => {
  it('вызов с callLog при включённом журнале доезжает до таблицы', async () => {
    vi.stubEnv('LLM_CALL_LOG_ENABLED', 'true');
    fetchMock.mockResolvedValue(anthropicOk('{"ok":true}'));

    await createChatCompletionDetailed({
      messages: MESSAGES,
      callLog: { callSite: 'test.synthesis', question: 'сколько стоит апостиль?' },
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const data = createMock.mock.calls[0][0].data;
    expect(data.callSite).toBe('test.synthesis');
    // system-части и остальное разведены по колонкам, а не свалены в одну.
    expect(data.systemPrompt).toBe('ты консультант бюро переводов');
    expect(data.userMessage).toBe('сколько стоит апостиль?');
    expect(data.rawResponse).toBe('{"ok":true}');
    expect(data.provider).toBe('anthropic');
  });

  it('без callLog не пишет ничего, даже когда журнал включён', async () => {
    vi.stubEnv('LLM_CALL_LOG_ENABLED', 'true');
    fetchMock.mockResolvedValue(anthropicOk('{"ok":true}'));

    await createChatCompletionDetailed({ messages: MESSAGES });

    expect(createMock).not.toHaveBeenCalled();
  });

  it('отказ провайдера тоже журналируется — с текстом ошибки и без ответа', async () => {
    vi.stubEnv('LLM_CALL_LOG_ENABLED', 'true');
    fetchMock.mockResolvedValue(new Response('anthropic is down', { status: 500 }));

    await expect(
      createChatCompletionDetailed({
        messages: MESSAGES,
        callLog: { callSite: 'test.synthesis' },
      })
    ).rejects.toThrow();

    expect(createMock).toHaveBeenCalledTimes(1);
    const data = createMock.mock.calls[0][0].data;
    expect(data.rawResponse).toBeNull();
    expect(data.error).toContain('anthropic');
  });
});
