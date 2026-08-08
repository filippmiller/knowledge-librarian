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

function anthropicOk(text: string): Response {
  return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200 });
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
});
