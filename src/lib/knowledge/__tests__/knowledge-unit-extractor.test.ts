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

/**
 * `callAnthropic` теперь читает SSE (translation-gy3), а не плоский JSON —
 * этот хелпер эмитит настоящую последовательность фреймов
 * (message_start → content_block_delta → message_delta → message_stop),
 * ОДНИМ content_block_delta на весь текст. Сигнатура не изменилась.
 */
function anthropicOk(text: string): Response {
  const frames: Record<string, unknown>[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: 'message_stop' },
  ];
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n`).join('');
  return new Response(body, { status: 200 });
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


  it('recognized precondition структурируется на PROCEDURE_STEP; EXCEPTION_RULE требует distinct base parent', () => {
    const system = buildExtractionPromptMessages([BLOCK_A]).find((message) => message.role === 'system')!.content;
    expect(system).toContain('правила ЛЮБОГО kind, включая PROCEDURE_STEP');
    expect(system).toContain('triggerCondition ОБЯЗАТЕЛЕН');
    expect(system).toContain('EXCEPTION_RULE используй только когда оговорка изменяет отдельное базовое правило');
    expect(system).toContain('parentExtractionRef обязан ссылаться на extractionRef этого base-unit');
    expect(system).toContain('privacyContext');
    expect(system).toContain('consentStatus');
    expect(system).toContain('reachability');
    expect(system).toContain('helperPresent');
  });

  it('не учит модель превращать самостоятельную условную инструкцию в EXCEPTION_RULE без родителя', () => {
    const messages = buildExtractionPromptMessages([BLOCK_A]);
    const system = messages.find((m) => m.role === 'system')!;
    expect(system.content).toContain('самостоятельная инструкция');
    expect(system.content).toContain('является PROCEDURE_STEP, а не EXCEPTION_RULE');
    expect(system.content).toContain('не отменяет отдельный родительский шаг');
  });

  it('не учит модель связывать co-required клаузы ложными parent-ссылками', () => {
    const messages = buildExtractionPromptMessages([BLOCK_A]);
    const system = messages.find((m) => m.role === 'system')!;
    expect(system.content).toContain('СО-ОБЯЗАТЕЛЬНЫМИ соседями');
    expect(system.content).toContain('а не родителями друг друга');
  });

  // Real live-fixture bug (2026-08-12, block b5): the model kept classifying
  // "regular scratching through fabric is not a proper method" as an
  // EXCEPTION_RULE parented to the neighboring seclusion rule with an
  // inherited privacyContext=PRIVATE condition, purely because both sentences
  // sit in the same block. Coverage-audit flagged this correctly three repair
  // rounds in a row and the model never internalized the fix, exhausting
  // FOCUSED_REPAIR_MAX_ROUNDS and killing the whole extraction run. Same
  // disease as the resourceAvailability over-application fixed twice earlier
  // the same day (952beb7, e714ef4): abstract rule wording alone did not stop
  // it, a concrete counter-example did.
  it('не учит модель приписывать правилу о способе действия условие места соседнего правила', () => {
    const messages = buildExtractionPromptMessages([BLOCK_A]);
    const system = messages.find((m) => m.role === 'system')!.content.toLowerCase();
    expect(system).toContain('правило о способе/технике действия');
    expect(system).toContain('условии места/контекста');
    expect(system).toContain('текстовая близость двух правил в одном блоке сама по себе не создаёт');
  });

  // Real live-fixture bug (2026-08-12, block b8, targeted taint resample):
  // resolveTaintedCandidates (run-aurora-fixture.ts) calls the BASE extractor
  // directly, with no focused-repair loop and no fallback on an audit gap —
  // one bad field fails the whole run outright. The base prompt was missing
  // the cycles-vs-times canonicalization guidance that only existed in
  // FOCUSED_REPAIR_SYSTEM_PROMPT (audited-extraction.ts), so a fresh resample
  // of a block that explicitly counts cycles picked unit="times", coverage
  // audit correctly flagged it, and there was no repair path to recover.
  // Same policy, now in both places it's exercised live.
  it('не учит модель путать unit="times" и unit="cycles" — то же правило, что в focused-repair', () => {
    const messages = buildExtractionPromptMessages([BLOCK_A]);
    const system = messages.find((m) => m.role === 'system')!.content.toLowerCase();
    expect(system).toContain('используй только когда исходный текст прямо считает циклы');
    expect(system).toContain('«прижать один раз») имеет unit="times", не "cycles"'.toLowerCase());
  });

  // Real cost bug (2026-08-09): 43 of 43 SCHEMA_MISMATCH extraction failures
  // across every benchmark run this session were the SAME error — the model
  // puts trigger-fact names (privacyContext, consentStatus, reachability,
  // helperPresent) directly on the unit object as top-level keys, instead of
  // nested inside triggerCondition.all[].fact. Root cause: triggerFactCatalog()
  // and facetCatalog() render in the IDENTICAL visual format
  // ("- key: description\n  Допустимые значения: ...") right next to each
  // other in this prompt, and facets genuinely ARE flat top-level keys —
  // nothing distinguishes the two catalogs' very different correct usage.
  // This burned ~80+ wasted paid retries in one day. Fix: an explicit
  // WRONG-vs-RIGHT example pair right after the trigger-fact catalog,
  // naming a real trigger fact so the warning can't be mistaken for
  // referring to facets instead.
  it('промпт явно предупреждает: имена trigger facts НЕ являются top-level полями unit — только значения "fact" внутри triggerCondition', () => {
    const messages = buildExtractionPromptMessages([BLOCK_A]);
    const system = messages.find((m) => m.role === 'system')!;
    expect(system.content).toContain('НЕ отдельные top-level поля unit');
    // Конкретный пример неправильной формы, с реальным именем факта — общее
    // предупреждение без примера уже не помогало (тот же класс ошибки,
    // что humanReviewed=false formatting: описание без конкретного примера
    // не считается). Пример должен явно называть privacyContext, а не
    // абстрактное "имя факта", иначе не факт, что модель свяжет
    // предупреждение именно с trigger-fact каталогом, а не facets.
    expect(system.content).toContain('"privacyContext": "PUBLIC"');
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
  it('валидный ответ провайдера возвращает массив units, parentExtractionRef разрешается на extractionRef другого unit\'а этого же ответа', () => {
    return anthropicRoundTrip();
  });

  it('parentExtractionRef, не резолвящийся ни в один extractionRef этого ответа (эфемерная метка вроде "R-17"), получает DANGLING_PARENT_REF; поле обнуляется, сырое значение видно в description (P0-фикс translation-rbj)', async () => {
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
              extractionRef: 'u1',
              parentExtractionRef: 'R-17',
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

    expect(result.units[0].parentExtractionRef).toBeNull();
    expect(result.units[0].uncertainties).toEqual([
      expect.objectContaining({ kind: 'DANGLING_PARENT_REF', description: expect.stringContaining('R-17') }),
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
            extractionRef: 'u1',
            parentExtractionRef: null,
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
            extractionRef: 'u2',
            parentExtractionRef: 'u1',
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
  expect(result.units[1].parentExtractionRef).toBe('u1');
  // Регрессия translation-2n9: если бы parentExtractionRef не разрешался,
  // здесь появилась бы DANGLING_PARENT_REF uncertainty — её нет, ссылка валидна.
  expect(result.units[1].uncertainties).toEqual([]);
}
