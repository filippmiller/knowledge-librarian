import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openaiCreate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/openai', () => ({
  openai: { chat: { completions: { create: openaiCreate } } },
  CHAT_MODEL: 'gpt-4o',
}));

import type { StructuredRunConfig } from '../structured-output';
import { LlmRerankerProvider } from '../reranker-provider';

function runConfig(overrides: Partial<StructuredRunConfig> = {}): StructuredRunConfig {
  return {
    provider: 'anthropic',
    model: 'claude-test-primary',
    promptVersion: 'test-reranker-v1',
    fallbackPolicy: 'NONE',
    ...overrides,
  };
}

function anthropicOk(
  text: string,
  usage: { input_tokens: number; output_tokens: number } = { input_tokens: 10, output_tokens: 5 }
): Response {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }], usage }), { status: 200 });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
  vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
  vi.stubEnv('AI_PROVIDER', 'anthropic');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  openaiCreate.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LlmRerankerProvider', () => {
  it('возвращает кандидатов, отсортированных по убыванию score из ответа модели', async () => {
    fetchMock.mockResolvedValue(
      anthropicOk(
        JSON.stringify({
          scores: [
            { id: 'b', score: 0.9 },
            { id: 'a', score: 0.3 },
          ],
        })
      )
    );

    const reranker = new LlmRerankerProvider(runConfig());
    const result = await reranker.rerank('вопрос', [
      { id: 'a', text: 'кандидат A' },
      { id: 'b', text: 'кандидат B' },
    ]);

    expect(result).toEqual([
      { id: 'b', score: 0.9 },
      { id: 'a', score: 0.3 },
    ]);
  });

  it('кандидат, отсутствующий в ответе модели, получает score 0 — не выпадает молча', async () => {
    fetchMock.mockResolvedValue(
      anthropicOk(JSON.stringify({ scores: [{ id: 'a', score: 0.5 }] }))
    );

    const reranker = new LlmRerankerProvider(runConfig());
    const result = await reranker.rerank('вопрос', [
      { id: 'a', text: 'кандидат A' },
      { id: 'b', text: 'кандидат B' },
    ]);

    expect(result).toHaveLength(2);
    expect(result.find((r) => r.id === 'b')?.score).toBe(0);
  });

  it('пустой список кандидатов — не зовёт LLM, пустой результат', async () => {
    const reranker = new LlmRerankerProvider(runConfig());
    const result = await reranker.rerank('вопрос', []);
    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('modelInfo() отдаёт provider/model из runConfig — для воспроизводимости артефакта', () => {
    const reranker = new LlmRerankerProvider(runConfig({ model: 'claude-specific' }));
    expect(reranker.modelInfo()).toEqual({ provider: 'anthropic', model: 'claude-specific' });
  });

  describe('drainAttempts() — источник для cost ledger (Task 37)', () => {
    it('после rerank() несёт attempts с реальным usage, и очищается после чтения', async () => {
      fetchMock.mockResolvedValue(
        anthropicOk(JSON.stringify({ scores: [{ id: 'a', score: 0.5 }] }), {
          input_tokens: 77,
          output_tokens: 33,
        })
      );

      const reranker = new LlmRerankerProvider(runConfig());
      await reranker.rerank('вопрос', [{ id: 'a', text: 'кандидат A' }]);

      const attempts = reranker.drainAttempts();
      expect(attempts).toHaveLength(1);
      expect(attempts[0].usage).toEqual({ inputTokens: 77, outputTokens: 33 });

      expect(reranker.drainAttempts()).toEqual([]);
    });

    it('пустой список кандидатов -> drainAttempts() пуст, LLM не звался', async () => {
      const reranker = new LlmRerankerProvider(runConfig());
      await reranker.rerank('вопрос', []);
      expect(reranker.drainAttempts()).toEqual([]);
    });
  });

  describe('drainTrace() — источник для call-trace log (2026-08-10)', () => {
    it('после rerank() несёт requestMessages/responseText, и очищается после чтения', async () => {
      const rawResponse = JSON.stringify({ scores: [{ id: 'a', score: 0.5 }] });
      fetchMock.mockResolvedValue(anthropicOk(rawResponse));

      const reranker = new LlmRerankerProvider(runConfig());
      await reranker.rerank('вопрос про апостиль', [{ id: 'a', text: 'кандидат A' }]);

      const trace = reranker.drainTrace();
      expect(trace.requestMessages.some((m) => m.content.includes('вопрос про апостиль'))).toBe(true);
      expect(trace.responseText).toBe(rawResponse);

      const drainedAgain = reranker.drainTrace();
      expect(drainedAgain.requestMessages).toEqual([]);
      expect(drainedAgain.responseText).toBeNull();
    });

    it('пустой список кандидатов -> drainTrace() пуст, LLM не звался', async () => {
      const reranker = new LlmRerankerProvider(runConfig());
      await reranker.rerank('вопрос', []);
      const trace = reranker.drainTrace();
      expect(trace.requestMessages).toEqual([]);
      expect(trace.responseText).toBeNull();
    });

    it('не мешает drainAttempts() — оба side-channel читаются независимо', async () => {
      fetchMock.mockResolvedValue(
        anthropicOk(JSON.stringify({ scores: [{ id: 'a', score: 0.5 }] }), {
          input_tokens: 10,
          output_tokens: 5,
        })
      );

      const reranker = new LlmRerankerProvider(runConfig());
      await reranker.rerank('вопрос', [{ id: 'a', text: 'кандидат A' }]);

      const attempts = reranker.drainAttempts();
      const trace = reranker.drainTrace();
      expect(attempts).toHaveLength(1);
      expect(trace.requestMessages.length).toBeGreaterThan(0);
    });
  });
});
