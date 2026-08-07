import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openaiCreate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/openai', () => ({
  openai: { chat: { completions: { create: openaiCreate } } },
  CHAT_MODEL: 'gpt-4o',
}));

import type { StructuredRunConfig } from '@/lib/ai/structured-output';
import type { ConversationMessage } from '../applicability/query-frame-builder';
import { buildExtractionMessages, extractQueryFrame } from '../query-frame-extractor';

const HISTORY: ConversationMessage = { id: 'm1', role: 'user', text: 'нужен апостиль на диплом' };
const CURRENT: ConversationMessage = { id: 'm2', role: 'user', text: 'сколько стоит?' };

function runConfig(overrides: Partial<StructuredRunConfig> = {}): StructuredRunConfig {
  return {
    provider: 'anthropic',
    model: 'claude-test-primary',
    promptVersion: 'test-prompt-v1',
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

describe('buildExtractionMessages — чистая функция, без сети', () => {
  it('содержит id каждого сообщения и его текст', () => {
    const messages = buildExtractionMessages([HISTORY, CURRENT]);
    const userMessage = messages.find((m) => m.role === 'user')!;
    expect(userMessage.content).toContain('[m1]');
    expect(userMessage.content).toContain('нужен апостиль на диплом');
    expect(userMessage.content).toContain('[m2]');
    expect(userMessage.content).toContain('сколько стоит?');
  });

  it('системный промпт перечисляет реальные id из SERVICE_CONCEPTS, а не выдуманные', () => {
    const messages = buildExtractionMessages([CURRENT]);
    const systemMessage = messages.find((m) => m.role === 'system')!;
    expect(systemMessage.content).toContain('apostille_spb');
    expect(systemMessage.content).toContain('translation');
    expect(systemMessage.content).toContain('nostrification');
  });

  it('пустой массив сообщений — ошибка, не пустой промпт', () => {
    expect(() => buildExtractionMessages([])).toThrow();
  });

  it('scenario-каталог перечисляет реальные узлы SCENARIOS, а не один пример-заглушку', () => {
    // Промпт требует "только значения из списков выше" — список обязан
    // покрывать НЕлистовые узлы тоже (apostille, apostille.min_justice), не
    // только "apostille.zags.spb", иначе модель не могла бы легально вернуть
    // их, хотя scenarioKeySchema их принимает (facets.ts).
    const messages = buildExtractionMessages([CURRENT]);
    const systemMessage = messages.find((m) => m.role === 'system')!;
    expect(systemMessage.content).toContain('apostille.min_justice');
    expect(systemMessage.content).toContain('apostille.zags.spb');
    expect(systemMessage.content).toContain('apostille.zags.lo');
  });
});

describe('extractQueryFrame — интеграция со structured()', () => {
  it('валидный ответ провайдера превращается в QueryFrame через buildQueryFrame', async () => {
    fetchMock.mockResolvedValue(
      anthropicOk(
        JSON.stringify({
          facetMentions: [
            {
              facet: 'service',
              polarity: 'INCLUDE',
              rawValue: 'apostille_spb',
              messageId: CURRENT.id,
              quote: 'апостиль',
            },
          ],
          triggerFactMentions: [],
          questionAspects: ['PRICE'],
        })
      )
    );

    const result = await extractQueryFrame({
      messages: [HISTORY, CURRENT],
      runConfig: runConfig(),
    });

    expect(result.queryFrame.facets.service).toMatchObject({
      state: 'KNOWN',
      include: ['apostille_spb'],
    });
    expect(result.queryFrame.questionAspects).toEqual(['PRICE']);
    expect(result.structuredResult.servedByProvider).toBe('anthropic');
  });

  it('ответ провайдера с несуществующим facet-ключом — StructuredOutputError, не тихий проход', async () => {
    fetchMock.mockResolvedValue(
      anthropicOk(
        JSON.stringify({
          facetMentions: [
            {
              facet: 'not_a_real_facet',
              polarity: 'INCLUDE',
              rawValue: 'x',
              messageId: CURRENT.id,
              quote: 'x',
            },
          ],
          triggerFactMentions: [],
          questionAspects: [],
        })
      )
    );

    await expect(
      extractQueryFrame({ messages: [CURRENT], runConfig: runConfig() })
    ).rejects.toThrow();
  });
});
