import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/openai', () => ({
  openai: { chat: { completions: { create: vi.fn() } } },
  CHAT_MODEL: 'gpt-4o',
}));

import { ChatCompletionError, type Provider } from '../chat-provider';
import {
  assessGraderIndependence,
  computeModelRelationship,
  computeRunModelConsistency,
  describeGraderIndependence,
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SCHEMA_VERSION,
  GraderConfigError,
  hashSource,
  recordFailedCall,
  recordSuccessfulCall,
  relateIdentities,
  resolveExtractionRunConfig,
  resolveGraderProvider,
  resolveGraderRunConfig,
  servedIdentities,
  type LlmCallContext,
  type LlmCallRecord,
  type ModelRelationship,
} from '../extraction-run';

const ALL_RELATIONSHIPS: ModelRelationship[] = [
  'SAME_MODEL',
  'SAME_PROVIDER_DIFFERENT_MODEL',
  'DIFFERENT_PROVIDER',
  'MIXED',
  'UNKNOWN',
];

const GRADER_PROMPT_VERSION = '2026-08-05-usability+fidelity-v1';

/** Успешный вызов с ЗАДАННЫМ фактическим исполнителем. */
function served(
  provider: Provider,
  model: string,
  overrides: Partial<LlmCallRecord> = {}
): LlmCallRecord {
  return {
    role: 'EXTRACTION_PRIMARY',
    batchIndex: 1,
    label: 'batch-1',
    requestedProvider: provider,
    requestedModel: model,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    fallbackPolicy: 'NONE',
    sourceHash: hashSource('текст'),
    startedAt: '2026-08-06T00:00:00.000Z',
    outcome: 'SUCCESS',
    servedByProvider: provider,
    servedByModel: model,
    fallbackUsed: false,
    attempts: [
      { provider, model, startedAt: '2026-08-06T00:00:00.000Z', latencyMs: 1, outcome: 'SUCCESS' },
    ],
    ...overrides,
  };
}

/** Упавший вызов: исполнителя нет, метаданных для отношения он не даёт. */
function failed(provider: Provider, model: string): LlmCallRecord {
  return {
    ...served(provider, model),
    outcome: 'FAILED',
    servedByProvider: null,
    servedByModel: null,
    error: 'boom',
  };
}

beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'test-anthropic-key');
  vi.stubEnv('OPENAI_API_KEY', 'test-openai-key');
  vi.stubEnv('AI_PROVIDER', 'anthropic');
  vi.stubEnv('ANTHROPIC_MODEL', 'claude-env-default');
  vi.stubEnv('OPENAI_CHAT_MODEL', 'gpt-env-default');
  vi.stubEnv('EXTRACTION_MODEL', '');
  vi.stubEnv('GRADER_MODEL', '');
  vi.stubEnv('GRADER_PROVIDER', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('resolveExtractionRunConfig', () => {
  it('закрепляет EXTRACTION_MODEL и расширяет CompletionRunConfig, не дублируя его поля', () => {
    vi.stubEnv('EXTRACTION_MODEL', 'claude-pinned-extractor');

    const config = resolveExtractionRunConfig();

    expect(config).toMatchObject({
      provider: 'anthropic',
      model: 'claude-pinned-extractor',
      promptVersion: EXTRACTION_PROMPT_VERSION,
      fallbackPolicy: 'NONE',
      extractionSchemaVersion: EXTRACTION_SCHEMA_VERSION,
    });
  });

  it('без EXTRACTION_MODEL резолвит КОНКРЕТНУЮ модель провайдера, а не оставляет «дефолт»', () => {
    // Именно из-за незарезолвленного `null` старая проверка независимости
    // сравнивала «ничего» со строкой и всегда получала «разные».
    expect(resolveExtractionRunConfig().model).toBe('claude-env-default');
  });

  it('пустая строка в env — это «не задано», а не модель с пустым именем', () => {
    vi.stubEnv('EXTRACTION_MODEL', '');
    expect(resolveExtractionRunConfig().model).toBe('claude-env-default');
  });

  it('фоллбэк по умолчанию запрещён: половинчатый резерв только на retry и есть источник MIXED', () => {
    expect(resolveExtractionRunConfig().fallbackPolicy).toBe('NONE');
  });
});

describe('resolveGraderRunConfig', () => {
  it('резолвит модель судьи до конкретной строки', () => {
    vi.stubEnv('GRADER_MODEL', 'claude-grader');
    expect(resolveGraderRunConfig(GRADER_PROMPT_VERSION)).toMatchObject({
      provider: 'anthropic',
      model: 'claude-grader',
      promptVersion: GRADER_PROMPT_VERSION,
      fallbackPolicy: 'NONE',
    });
  });

  it('без GRADER_MODEL судья наследует дефолтную модель провайдера', () => {
    expect(resolveGraderRunConfig(GRADER_PROMPT_VERSION).model).toBe('claude-env-default');
  });

  it('GRADER_PROVIDER=openai уводит судью к другому вендору', () => {
    vi.stubEnv('GRADER_PROVIDER', 'openai');
    expect(resolveGraderRunConfig(GRADER_PROMPT_VERSION)).toMatchObject({
      provider: 'openai',
      model: 'gpt-env-default',
    });
  });

  it('мусор в GRADER_PROVIDER — ошибка, а не молчаливый откат на провайдера экстрактора', () => {
    vi.stubEnv('GRADER_PROVIDER', 'gemini');
    expect(() => resolveGraderProvider()).toThrow(GraderConfigError);
  });
});

describe('servedIdentities / computeRunModelConsistency', () => {
  it('однородный прогон — CONSISTENT', () => {
    const calls = [served('anthropic', 'claude-a'), served('anthropic', 'claude-a')];
    expect(servedIdentities(calls)).toEqual([{ provider: 'anthropic', model: 'claude-a' }]);
    expect(computeRunModelConsistency(calls)).toBe('CONSISTENT');
  });

  it('retry, ушедший на другую модель, делает прогон MIXED', () => {
    const calls = [
      served('anthropic', 'claude-a'),
      served('openai', 'gpt-4o', { role: 'EXTRACTION_RETRY', fallbackUsed: true }),
    ];
    expect(computeRunModelConsistency(calls)).toBe('MIXED');
  });

  it('упавшие вызовы не дают исполнителя и не изображают однородность', () => {
    expect(servedIdentities([failed('anthropic', 'claude-a')])).toEqual([]);
    expect(computeRunModelConsistency([failed('anthropic', 'claude-a')])).toBe('UNKNOWN');
  });
});

describe('computeModelRelationship — по фактическим исполнителям', () => {
  const grader = (provider: Provider, model: string) =>
    served(provider, model, { role: 'GRADER', batchIndex: null, label: 'Q01/usability_all' });

  it('SAME_MODEL: тот же провайдер и та же модель', () => {
    expect(
      computeModelRelationship([served('anthropic', 'claude-a')], [grader('anthropic', 'claude-a')])
    ).toBe('SAME_MODEL');
  });

  it('SAME_PROVIDER_DIFFERENT_MODEL: Haiku против Sonnet — не «полная независимость»', () => {
    const relationship = computeModelRelationship(
      [served('anthropic', 'claude-haiku')],
      [grader('anthropic', 'claude-sonnet')]
    );
    expect(relationship).toBe('SAME_PROVIDER_DIFFERENT_MODEL');
    expect(assessGraderIndependence(relationship)).toBe('PARTIALLY_INDEPENDENT');
  });

  it('DIFFERENT_PROVIDER: разные вендоры', () => {
    expect(
      computeModelRelationship([served('anthropic', 'claude-a')], [grader('openai', 'gpt-4o')])
    ).toBe('DIFFERENT_PROVIDER');
  });

  it('MIXED: батчи одного прогона обслужены разными моделями', () => {
    expect(
      computeModelRelationship(
        [
          served('anthropic', 'claude-a'),
          served('openai', 'gpt-4o', { role: 'EXTRACTION_RETRY', fallbackUsed: true }),
        ],
        [grader('openai', 'gpt-4o')]
      )
    ).toBe('MIXED');
  });

  it('MIXED: неоднородность на стороне судьи считается так же', () => {
    expect(
      computeModelRelationship(
        [served('anthropic', 'claude-a')],
        [grader('openai', 'gpt-4o'), grader('anthropic', 'claude-a')]
      )
    ).toBe('MIXED');
  });

  it('UNKNOWN: нет attempt-метаданных (прогоны до A1 / полностью упавшая сторона)', () => {
    expect(computeModelRelationship([], [])).toBe('UNKNOWN');
    expect(computeModelRelationship([served('anthropic', 'claude-a')], [])).toBe('UNKNOWN');
    expect(
      computeModelRelationship([failed('anthropic', 'claude-a')], [grader('openai', 'gpt-4o')])
    ).toBe('UNKNOWN');
  });

  it('UNKNOWN не выдаётся за «всё в порядке»', () => {
    expect(assessGraderIndependence('UNKNOWN')).toBe('UNDETERMINED');
    expect(describeGraderIndependence('UNKNOWN')).toContain('не установлена');
    expect(describeGraderIndependence('UNKNOWN')).not.toMatch(/^судья независим/);
  });
});

describe('ложноположительная независимость (находка 3)', () => {
  it('ANTHROPIC_MODEL=X + GRADER_MODEL=X + EXTRACTION_MODEL не задан → SAME_MODEL', () => {
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-shared-x');
    vi.stubEnv('GRADER_MODEL', 'claude-shared-x');
    vi.stubEnv('EXTRACTION_MODEL', '');

    const extraction = resolveExtractionRunConfig();
    const grader = resolveGraderRunConfig(GRADER_PROMPT_VERSION);

    // Старая формула сравнивала СЫРЫЕ env: null !== 'claude-shared-x' → «независим».
    const legacyExtractionModel = process.env.EXTRACTION_MODEL || null;
    const legacyGraderModel = process.env.GRADER_MODEL || null;
    const legacyVerdict =
      grader.provider !== extraction.provider || legacyGraderModel !== legacyExtractionModel;
    expect(legacyVerdict).toBe(true);

    // Факт: обе стороны едут на одной и той же модели.
    expect(extraction.model).toBe('claude-shared-x');
    expect(grader.model).toBe('claude-shared-x');
    expect(
      relateIdentities(
        { provider: extraction.provider, model: extraction.model },
        { provider: grader.provider, model: grader.model }
      )
    ).toBe('SAME_MODEL');
  });

  it('то же самое по ФАКТИЧЕСКИ ответившим моделям, не по env', () => {
    const relationship = computeModelRelationship(
      [served('anthropic', 'claude-shared-x')],
      [served('anthropic', 'claude-shared-x', { role: 'GRADER', batchIndex: null, label: 'Q01' })]
    );
    expect(relationship).toBe('SAME_MODEL');
    expect(assessGraderIndependence(relationship)).toBe('NOT_INDEPENDENT');
    expect(describeGraderIndependence(relationship)).toContain('судья НЕ независим');
  });
});

describe('describeGraderIndependence', () => {
  it('никогда не говорит про независимость без указания ModelRelationship', () => {
    for (const relationship of ALL_RELATIONSHIPS) {
      const text = describeGraderIndependence(relationship);
      expect(text).toContain(`ModelRelationship=${relationship}`);
    }
  });

  it('слово «независим» встречается только рядом с отношением, на котором стоит', () => {
    for (const relationship of ALL_RELATIONSHIPS) {
      const text = describeGraderIndependence(relationship);
      if (/независим/i.test(text)) {
        expect(text).toContain(`ModelRelationship=${relationship}`);
      }
    }
  });

  it('одно семейство моделей одного вендора не называется полной независимостью', () => {
    const text = describeGraderIndependence('SAME_PROVIDER_DIFFERENT_MODEL');
    expect(text).toContain('ЧАСТИЧНО');
    expect(text).not.toMatch(/полн/i);
  });
});

describe('журнальные записи', () => {
  const context: LlmCallContext = {
    role: 'EXTRACTION_RETRY',
    batchIndex: 2,
    label: 'batch-2',
    config: {
      provider: 'anthropic',
      model: 'claude-pinned',
      promptVersion: EXTRACTION_PROMPT_VERSION,
      fallbackPolicy: 'NONE',
    },
    sourceText: 'фрагмент документа',
  };

  it('успешный вызов пишет ФАКТИЧЕСКОГО исполнителя, а не запрошенного', () => {
    const record = recordSuccessfulCall(context, {
      text: '{}',
      servedByProvider: 'openai',
      servedByModel: 'gpt-4o',
      fallbackUsed: true,
      attempts: [
        {
          provider: 'anthropic',
          model: 'claude-pinned',
          startedAt: '2026-08-06T00:00:00.000Z',
          latencyMs: 5,
          outcome: 'ERROR',
        },
        {
          provider: 'openai',
          model: 'gpt-4o',
          startedAt: '2026-08-06T00:00:01.000Z',
          latencyMs: 7,
          outcome: 'SUCCESS',
        },
      ],
    });

    expect(record.requestedProvider).toBe('anthropic');
    expect(record.requestedModel).toBe('claude-pinned');
    expect(record.servedByProvider).toBe('openai');
    expect(record.servedByModel).toBe('gpt-4o');
    expect(record.fallbackUsed).toBe(true);
    expect(record.attempts).toHaveLength(2);
    expect(record.sourceHash).toBe(hashSource('фрагмент документа'));
    expect(record.promptVersion).toBe(EXTRACTION_PROMPT_VERSION);
  });

  it('упавший вызов сохраняет все попытки из ChatCompletionError', () => {
    const attempts = [
      {
        provider: 'anthropic' as const,
        model: 'claude-pinned',
        startedAt: '2026-08-06T00:00:00.000Z',
        latencyMs: 3,
        outcome: 'ERROR' as const,
        statusCode: 500,
      },
    ];
    const record = recordFailedCall(context, new ChatCompletionError('down', attempts));

    expect(record.outcome).toBe('FAILED');
    expect(record.servedByProvider).toBeNull();
    expect(record.servedByModel).toBeNull();
    expect(record.attempts).toEqual(attempts);
    expect(record.error).toContain('down');
  });
});
