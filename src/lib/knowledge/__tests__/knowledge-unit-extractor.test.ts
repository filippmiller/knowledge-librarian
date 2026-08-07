import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openaiCreate = vi.hoisted(() => vi.fn());

vi.mock('@/lib/openai', () => ({
  openai: { chat: { completions: { create: openaiCreate } } },
  CHAT_MODEL: 'gpt-4o',
}));

import type { ExtractionRunConfig } from '@/lib/ai/extraction-run';
import {
  buildExtractionPromptMessages,
  extractKnowledgeUnits,
  type SourceBlock,
} from '../knowledge-unit-extractor';

const BLOCK_A: SourceBlock = { anchor: 'block-A', text: 'Раздражение кожи снимают в уединённом месте.' };
const BLOCK_B: SourceBlock = { anchor: 'block-B', text: 'Не более 3 дней подряд.' };

function runConfig(overrides: Partial<ExtractionRunConfig> = {}): ExtractionRunConfig {
  return {
    provider: 'anthropic',
    model: 'claude-test-primary',
    promptVersion: 'test-prompt-v1',
    fallbackPolicy: 'NONE',
    extractionSchemaVersion: 'test-schema-v1',
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

describe('buildExtractionPromptMessages — чистая функция, без сети', () => {
  it('содержит анкер и текст каждого блока', () => {
    const messages = buildExtractionPromptMessages([BLOCK_A, BLOCK_B]);
    const user = messages.find((m) => m.role === 'user')!;
    expect(user.content).toContain('block-A');
    expect(user.content).toContain('Раздражение кожи');
    expect(user.content).toContain('block-B');
    expect(user.content).toContain('Не более 3 дней подряд');
  });

  it('системный промпт перечисляет реальные kind из KNOWLEDGE_UNIT_KINDS', () => {
    const messages = buildExtractionPromptMessages([BLOCK_A]);
    const system = messages.find((m) => m.role === 'system')!;
    expect(system.content).toContain('PROCEDURE_STEP');
    expect(system.content).toContain('EXCEPTION_RULE');
    expect(system.content).toContain('PRICE_RULE');
  });

  it('промпт называет применимые facets ДЛЯ КАЖДОГО kind — не единый список для всех', () => {
    // Схема (extraction.ts) теперь отвергает неприменимую фасету — промпт
    // обязан не приглашать модель её туда положить (находка ревью этого PR).
    const messages = buildExtractionPromptMessages([BLOCK_A]);
    const system = messages.find((m) => m.role === 'system')!;
    expect(system.content).toMatch(/PRICE_RULE:.*\n\s*Применимые facets: scenario, service/);
    expect(system.content).toMatch(
      /TERM_DEFINITION:.*\n\s*Применимые facets: \(нет — этот kind вообще не несёт facets\)/
    );
  });

  it('helperPresent в промпте — JSON boolean без кавычек, не строка (triggerConditionSchema требует z.boolean())', () => {
    const messages = buildExtractionPromptMessages([BLOCK_A]);
    const system = messages.find((m) => m.role === 'system')!;
    expect(system.content).not.toContain('"true" или "false"');
  });

  it('промпт показывает точную JSON-форму triggerCondition — {"all": [...]}', () => {
    const messages = buildExtractionPromptMessages([BLOCK_A]);
    const system = messages.find((m) => m.role === 'system')!;
    expect(system.content).toContain('{"all":');
  });

  it('evidenceByField описан как ОБЯЗАТЕЛЬНЫЙ для непустых полей, а не опциональный', () => {
    const messages = buildExtractionPromptMessages([BLOCK_A]);
    const system = messages.find((m) => m.role === 'system')!;
    expect(system.content).toContain('ОБЯЗАТЕЛЬНО подтверждение');
    expect(system.content).not.toContain('можно опустить поле, если оно и так null');
  });

  it('пустой список блоков — ошибка', () => {
    expect(() => buildExtractionPromptMessages([])).toThrow();
  });
});

describe('extractKnowledgeUnits — интеграция со structured()', () => {
  it('валидный ответ провайдера возвращает массив units, parentRuleRef разрешается на реальный анкер', () => {
    return anthropicRoundTrip();
  });

  it('parentRuleRef на несуществующий анкер (эфемерная метка вроде "R-17") получает DANGLING_PARENT_REF, не теряется молча', async () => {
    fetchMock.mockResolvedValue(
      anthropicOk(
        JSON.stringify({
          units: [
            {
              kind: 'PROCEDURE_STEP',
              statement: 'Не более 3 дней подряд.',
              facets: {},
              triggerCondition: null,
              numericConstraint: { factKey: 'максимум суток подряд', value: 3, unit: 'сутки' },
              parentRuleRef: 'R-17',
              sourceSpan: { anchor: 'block-B', quote: 'не более 3 дней подряд' },
              evidenceByField: {
                statement: { anchor: 'block-B', quote: 'не более 3 дней подряд' },
                numericConstraint: { anchor: 'block-B', quote: 'не более 3 дней подряд' },
              },
              uncertainties: [],
            },
          ],
        })
      )
    );

    const result = await extractKnowledgeUnits({ blocks: [BLOCK_A, BLOCK_B], runConfig: runConfig() });

    expect(result.units[0].parentRuleRef).toBe('R-17');
    expect(result.units[0].uncertainties).toEqual([
      expect.objectContaining({ kind: 'DANGLING_PARENT_REF' }),
    ]);
  });
});

async function anthropicRoundTrip() {
  fetchMock.mockResolvedValue(
    anthropicOk(
      JSON.stringify({
        units: [
          {
            kind: 'PROCEDURE_STEP',
            statement: 'Раздражение кожи снимают в уединённом месте.',
            facets: {},
            triggerCondition: null,
            numericConstraint: null,
            parentRuleRef: null,
            sourceSpan: { anchor: 'block-A', quote: 'в уединённом месте' },
            evidenceByField: { statement: { anchor: 'block-A', quote: 'в уединённом месте' } },
            uncertainties: [],
          },
          {
            kind: 'PROCEDURE_STEP',
            statement: 'Не более 3 дней подряд.',
            facets: {},
            triggerCondition: null,
            numericConstraint: { factKey: 'максимум суток подряд', value: 3, unit: 'сутки' },
            parentRuleRef: 'block-A',
            sourceSpan: { anchor: 'block-B', quote: 'не более 3 дней подряд' },
            evidenceByField: {
              statement: { anchor: 'block-B', quote: 'не более 3 дней подряд' },
              numericConstraint: { anchor: 'block-B', quote: 'не более 3 дней подряд' },
            },
            uncertainties: [],
          },
        ],
      })
    )
  );

  const result = await extractKnowledgeUnits({
    blocks: [BLOCK_A, BLOCK_B],
    runConfig: runConfig(),
  });

  expect(result.units).toHaveLength(2);
  expect(result.units[1].parentRuleRef).toBe('block-A');
  // Регрессия translation-2n9: если бы parentRuleRef не разрешался, здесь
  // появилась бы DANGLING_PARENT_REF uncertainty — её нет, ссылка валидна.
  expect(result.units[1].uncertainties).toEqual([]);
}
