import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({
  default: { llmCallLog: { create: createMock } },
  prisma: { llmCallLog: { create: createMock } },
}));

import {
  DEFAULT_RETENTION_DAYS,
  LLM_CALL_LOG_MAX_CHARS,
  isLlmCallLogEnabled,
  llmCallLogRetentionDays,
  recordLlmCall,
  redactPii,
  truncateForLog,
} from '../llm-call-log';

const BASE = {
  callSite: 'test.site',
  provider: 'anthropic',
  model: 'claude-test',
  systemPrompt: 'системный промпт',
  userMessage: 'вопрос пользователя',
};

beforeEach(() => {
  createMock.mockReset();
  createMock.mockResolvedValue({ id: 'log-1' });
  vi.stubEnv('LLM_CALL_LOG_ENABLED', 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('redactPii()', () => {
  it('вычищает почту, телефон, номер паспорта и СНИЛС', () => {
    const redacted = redactPii(
      'Иванов, ivanov@example.com, +7 (912) 345-67-89, паспорт 4510 123456, СНИЛС 123-456-789 01'
    );

    expect(redacted).not.toContain('ivanov@example.com');
    expect(redacted).not.toContain('4510 123456');
    expect(redacted).not.toContain('123-456-789 01');
    expect(redacted).toContain('[email]');
    expect(redacted).toContain('[doc-number]');
    expect(redacted).toContain('[snils]');
    expect(redacted).toMatch(/\[phone\]|\[doc-number\]/);
  });

  /**
   * Пере-зачистка обесценивает журнал: цены — это ровно то, ради чего в него
   * лезут при разборе жалобы «бот назвал не ту сумму».
   */
  it('не трогает цены и годы — иначе журнал бесполезен', () => {
    const text = 'Нотариальное заверение 1500 рублей, прайс от 2026 года, страница 12';

    expect(redactPii(text)).toBe(text);
  });

  it('ФИО сознательно НЕ вычищаются — защита держится на сроке хранения', () => {
    // Тест фиксирует принятое решение, а не желаемое поведение: если кто-то
    // добавит «зачистку имён» регуляркой, он увидит здесь, что это осознанный
    // отказ, а не забытый пункт. См. шапку llm-call-log.ts.
    expect(redactPii('Иванов Иван Иванович')).toBe('Иванов Иван Иванович');
  });
});

describe('truncateForLog()', () => {
  it('обрезает с явной пометкой и не превышает лимит', () => {
    const long = 'я'.repeat(LLM_CALL_LOG_MAX_CHARS + 500);
    const result = truncateForLog(long);

    expect(result.length).toBe(LLM_CALL_LOG_MAX_CHARS);
    expect(result.endsWith('...[truncated]')).toBe(true);
  });

  it('короткий текст не трогает', () => {
    expect(truncateForLog('коротко')).toBe('коротко');
  });
});

describe('срок хранения', () => {
  it('по умолчанию 30 дней', () => {
    vi.stubEnv('LLM_CALL_LOG_RETENTION_DAYS', undefined as unknown as string);
    expect(llmCallLogRetentionDays()).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('мусор и ноль в переменной откатываются к дефолту, а не отключают чистку', () => {
    vi.stubEnv('LLM_CALL_LOG_RETENTION_DAYS', '0');
    expect(llmCallLogRetentionDays()).toBe(DEFAULT_RETENTION_DAYS);

    vi.stubEnv('LLM_CALL_LOG_RETENTION_DAYS', 'позавчера');
    expect(llmCallLogRetentionDays()).toBe(DEFAULT_RETENTION_DAYS);

    vi.stubEnv('LLM_CALL_LOG_RETENTION_DAYS', '-5');
    expect(llmCallLogRetentionDays()).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('заданное значение уважается', () => {
    vi.stubEnv('LLM_CALL_LOG_RETENTION_DAYS', '7');
    expect(llmCallLogRetentionDays()).toBe(7);
  });
});

describe('recordLlmCall()', () => {
  it('выключен по умолчанию: без переменной окружения в БД не пишет', async () => {
    vi.stubEnv('LLM_CALL_LOG_ENABLED', undefined as unknown as string);
    expect(isLlmCallLogEnabled()).toBe(false);

    await recordLlmCall(BASE);

    expect(createMock).not.toHaveBeenCalled();
  });

  it('значение, отличное от "true", тоже не включает журнал', async () => {
    vi.stubEnv('LLM_CALL_LOG_ENABLED', '1');

    await recordLlmCall(BASE);

    expect(createMock).not.toHaveBeenCalled();
  });

  it('включённый журнал пишет запись с вычищенными PII', async () => {
    await recordLlmCall({
      ...BASE,
      userMessage: 'мой паспорт 4510 123456, почта ivanov@example.com',
      question: 'позвоните на +7 (912) 345-67-89',
      rawResponse: '{"answer":"ok"}',
      latencyMs: 1234,
    });

    expect(createMock).toHaveBeenCalledTimes(1);
    const data = createMock.mock.calls[0][0].data;
    expect(data.callSite).toBe('test.site');
    expect(data.userMessage).not.toContain('4510 123456');
    expect(data.userMessage).not.toContain('ivanov@example.com');
    expect(data.question).not.toContain('345-67-89');
    expect(data.rawResponse).toBe('{"answer":"ok"}');
    expect(data.latencyMs).toBe(1234);
  });

  /**
   * Самое важное свойство модуля: диагностический журнал, уронивший боевой
   * ответ пользователю, — худший из возможных размеров этой фичи.
   */
  it('падение БД не выходит наружу: журнал не может уронить вызов модели', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    createMock.mockRejectedValue(new Error('соединение с БД потеряно'));

    await expect(recordLlmCall(BASE)).resolves.toBeUndefined();
  });

  it('отсутствие ответа пишется как null, а не как пустая строка', async () => {
    await recordLlmCall({ ...BASE, error: 'провайдер лёг' });

    const data = createMock.mock.calls[0][0].data;
    expect(data.rawResponse).toBeNull();
    expect(data.error).toBe('провайдер лёг');
  });
});
