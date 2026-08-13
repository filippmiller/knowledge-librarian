/**
 * `telemetryMode: 'disabled'` обязан писать РОВНО НОЛЬ строк.
 *
 * Проверка на моке Prisma: утверждение «не создаёт строк в HallucinationLog»
 * бессмысленно доказывать чем-то, кроме отсутствия самого вызова записи.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const hallucinationCreate = vi.fn(() => Promise.resolve({}));
const heldAnswerCreate = vi.fn(() => Promise.resolve({}));

vi.mock('@/lib/db', () => ({
  default: {
    hallucinationLog: { create: hallucinationCreate },
    heldAnswer: { create: heldAnswerCreate },
  },
}));

const { isTelemetryEnabled, recordHallucinationLog } = await import('../answer-telemetry');

const ENTRY = {
  sessionId: null,
  question: 'вопрос',
  scenarioKey: null,
  initialAnswer: 'черновик',
  regeneratedAnswer: null,
  unsupportedClaims: {},
  unsupportedCount: 1,
  regenerated: false,
};

describe('recordHallucinationLog', () => {
  beforeEach(() => {
    hallucinationCreate.mockClear();
    heldAnswerCreate.mockClear();
  });

  it("режим 'disabled' не пишет ни одной строки телеметрии", () => {
    recordHallucinationLog('disabled', ENTRY);
    expect(hallucinationCreate).not.toHaveBeenCalled();
    expect(heldAnswerCreate).not.toHaveBeenCalled();
  });

  it('прогон целого корпуса в disabled оставляет ноль записей', () => {
    for (let i = 0; i < 15; i++) {
      recordHallucinationLog('disabled', { ...ENTRY, question: `вопрос ${i}` });
    }
    expect(hallucinationCreate).toHaveBeenCalledTimes(0);
  });

  it("режим 'enabled' пишет как раньше", () => {
    recordHallucinationLog('enabled', ENTRY);
    expect(hallucinationCreate).toHaveBeenCalledTimes(1);
    expect(hallucinationCreate).toHaveBeenCalledWith({ data: ENTRY });
  });

  it('неуказанный режим = поведение реального пользователя, запись идёт', () => {
    recordHallucinationLog(undefined, ENTRY);
    expect(hallucinationCreate).toHaveBeenCalledTimes(1);
  });

  it('сбой записи не выбрасывается наружу', async () => {
    hallucinationCreate.mockImplementationOnce(() => Promise.reject(new Error('db down')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => recordHallucinationLog('enabled', ENTRY)).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('isTelemetryEnabled', () => {
  it.each([
    ['enabled', true],
    ['disabled', false],
    [undefined, true],
  ] as const)('%s → %s', (mode, enabled) => {
    expect(isTelemetryEnabled(mode)).toBe(enabled);
  });
});
