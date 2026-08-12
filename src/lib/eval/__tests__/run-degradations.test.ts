import { describe, expect, it } from 'vitest';

import {
  RunDegradationLedger,
  resolveDegradationGate,
  type RunDegradation,
} from '../run-degradations';

/**
 * Контракт «замер проходит всегда, приёмка — только на чистом прогоне».
 * Ключевое, что здесь проверяется, — НЕ то, что деградации собираются
 * (это тривиально), а то, что деградированный прогон невозможно молча
 * назвать приёмочным: гейт обязан отказать без явного флага. Именно эта
 * половина отличает «сделали замеримым» от «ослабили гарантии».
 */

const degradation = (overrides: Partial<RunDegradation> = {}): RunDegradation => ({
  stage: 'TAINT_RESAMPLE',
  blockAnchor: 'b8',
  unitIds: ['u1'],
  detail: 'replacement did not pass coverage audit',
  ...overrides,
});

describe('RunDegradationLedger', () => {
  it('чистый прогон не деградирован и даёт пустой снимок', () => {
    const ledger = new RunDegradationLedger();
    expect(ledger.degraded).toBe(false);
    expect(ledger.snapshot()).toEqual([]);
    expect(ledger.stages()).toEqual([]);
  });

  it('собирает записи и схлопывает стадии для краткой сводки', () => {
    const ledger = new RunDegradationLedger();
    ledger.record(degradation());
    ledger.record(degradation({ blockAnchor: 'b14', stage: 'MALFORMED_EXCEPTION_REPAIR' }));
    ledger.record(degradation({ blockAnchor: 'b6', stage: 'MALFORMED_EXCEPTION_REPAIR' }));

    expect(ledger.degraded).toBe(true);
    expect(ledger.snapshot()).toHaveLength(3);
    expect(ledger.stages()).toEqual(['TAINT_RESAMPLE', 'MALFORMED_EXCEPTION_REPAIR']);
  });

  it('снимок — копия: последующая запись не меняет уже выданный массив', () => {
    const ledger = new RunDegradationLedger();
    ledger.record(degradation());
    const first = ledger.snapshot();
    ledger.record(degradation({ blockAnchor: 'b9' }));
    expect(first).toHaveLength(1);
  });
});

describe('resolveDegradationGate', () => {
  it('чистый прогон проходит без флага', () => {
    expect(resolveDegradationGate({ degradations: [] }, false)).toEqual({
      degraded: false,
      degradations: [],
    });
  });

  // Артефакты, снятые ДО появления реестра, не имеют поля вовсе. Они обязаны
  // оцениваться ровно как раньше — та же дисциплина, что у графового гейта:
  // отсутствие поля НИКОГДА не означает деградацию.
  it('отсутствие поля трактуется как чистый прогон, а не как деградация', () => {
    expect(resolveDegradationGate({}, false).degraded).toBe(false);
  });

  it('ОТКАЗЫВАЕТ деградированному прогону без явного флага', () => {
    expect(() =>
      resolveDegradationGate({ degradations: [degradation()] }, false)
    ).toThrow('--accept-degraded-run');
  });

  it('называет количество и стадии в отказе — чтобы причина была видна сразу', () => {
    expect(() =>
      resolveDegradationGate(
        { degradations: [degradation(), degradation({ stage: 'DEPENDENCY_GRAPH' })] },
        false
      )
    ).toThrow(/2 recorded degradation\(s\) \[TAINT_RESAMPLE, DEPENDENCY_GRAPH\]/);
  });

  it('с явным флагом пропускает, но помечает прогон деградированным', () => {
    const result = resolveDegradationGate({ degradations: [degradation()] }, true);
    expect(result.degraded).toBe(true);
    expect(result.degradations).toHaveLength(1);
  });
});
