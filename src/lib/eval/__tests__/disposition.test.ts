/**
 * Матрица §3 PR A3, закреплённая таблицей.
 *
 * Тест намеренно перечисляет ВСЕ сочетания, а не проверяет «важные»: смысл
 * матрицы в том, что у неё нет ветки по умолчанию, и доказать это может только
 * полный перебор. 4 ожидания × 3 расположения × 2 состояния проверок = 24
 * строки на здоровой safety, столько же — на нарушенной.
 */

import { describe, expect, it } from 'vitest';
import {
  computeActualDisposition,
  computeExitCode,
  dispositionOfDelivery,
  isGateBlocking,
  resolveCaseResult,
  type ActualDisposition,
  type CaseResult,
  type ExpectedDisposition,
} from '../disposition';

interface Row {
  expected: ExpectedDisposition;
  actual: ActualDisposition;
  assertionsPassed: boolean;
  result: CaseResult;
}

const MATRIX: Row[] = [
  // MUST_PASS — ждём прямой корректный ответ.
  { expected: 'MUST_PASS', actual: 'DIRECT_ANSWER', assertionsPassed: true, result: 'PASS' },
  { expected: 'MUST_PASS', actual: 'DIRECT_ANSWER', assertionsPassed: false, result: 'FAIL' },
  { expected: 'MUST_PASS', actual: 'HOLD', assertionsPassed: true, result: 'FAIL' },
  { expected: 'MUST_PASS', actual: 'HOLD', assertionsPassed: false, result: 'FAIL' },
  { expected: 'MUST_PASS', actual: 'ERROR', assertionsPassed: true, result: 'FAIL' },
  { expected: 'MUST_PASS', actual: 'ERROR', assertionsPassed: false, result: 'FAIL' },

  // MUST_HOLD — ждём удержание; проверки качества у удержания не смотрятся.
  { expected: 'MUST_HOLD', actual: 'HOLD', assertionsPassed: true, result: 'PASS' },
  { expected: 'MUST_HOLD', actual: 'HOLD', assertionsPassed: false, result: 'PASS' },
  { expected: 'MUST_HOLD', actual: 'DIRECT_ANSWER', assertionsPassed: true, result: 'FAIL' },
  { expected: 'MUST_HOLD', actual: 'DIRECT_ANSWER', assertionsPassed: false, result: 'FAIL' },
  { expected: 'MUST_HOLD', actual: 'ERROR', assertionsPassed: true, result: 'FAIL' },
  { expected: 'MUST_HOLD', actual: 'ERROR', assertionsPassed: false, result: 'FAIL' },

  // MAY_HOLD — приемлемы оба исхода, но прямой ответ обязан быть корректным.
  { expected: 'MAY_HOLD', actual: 'HOLD', assertionsPassed: true, result: 'PASS' },
  { expected: 'MAY_HOLD', actual: 'HOLD', assertionsPassed: false, result: 'PASS' },
  { expected: 'MAY_HOLD', actual: 'DIRECT_ANSWER', assertionsPassed: true, result: 'PASS' },
  { expected: 'MAY_HOLD', actual: 'DIRECT_ANSWER', assertionsPassed: false, result: 'FAIL' },
  { expected: 'MAY_HOLD', actual: 'ERROR', assertionsPassed: true, result: 'FAIL' },
  { expected: 'MAY_HOLD', actual: 'ERROR', assertionsPassed: false, result: 'FAIL' },

  // KNOWN_FAIL — базовая семантика MUST_PASS, затем XFAIL/XPASS.
  // ERROR остаётся FAIL: исключение движка никогда не «ожидаемый провал».
  { expected: 'KNOWN_FAIL', actual: 'DIRECT_ANSWER', assertionsPassed: true, result: 'XPASS' },
  { expected: 'KNOWN_FAIL', actual: 'DIRECT_ANSWER', assertionsPassed: false, result: 'XFAIL' },
  { expected: 'KNOWN_FAIL', actual: 'HOLD', assertionsPassed: true, result: 'XFAIL' },
  { expected: 'KNOWN_FAIL', actual: 'HOLD', assertionsPassed: false, result: 'XFAIL' },
  { expected: 'KNOWN_FAIL', actual: 'ERROR', assertionsPassed: true, result: 'FAIL' },
  { expected: 'KNOWN_FAIL', actual: 'ERROR', assertionsPassed: false, result: 'FAIL' },
];

describe('resolveCaseResult — матрица ожидание × расположение', () => {
  it.each(MATRIX)(
    '$expected + $actual (проверки $assertionsPassed) → $result',
    ({ expected, actual, assertionsPassed, result }) => {
      expect(resolveCaseResult({ expected, actual, assertionsPassed, safetyPassed: true })).toBe(
        result
      );
    }
  );

  it('покрывает все 4 ожидания × 3 расположения × 2 состояния проверок', () => {
    expect(MATRIX).toHaveLength(24);
    expect(new Set(MATRIX.map((r) => `${r.expected}|${r.actual}|${r.assertionsPassed}`)).size).toBe(
      24
    );
  });

  it.each(MATRIX)(
    'нарушение safety перебивает всё: $expected + $actual → FAIL',
    ({ expected, actual, assertionsPassed }) => {
      expect(resolveCaseResult({ expected, actual, assertionsPassed, safetyPassed: false })).toBe(
        'FAIL'
      );
    }
  );
});

describe('исключение движка', () => {
  const EXPECTATIONS: ExpectedDisposition[] = ['MUST_PASS', 'MUST_HOLD', 'MAY_HOLD', 'KNOWN_FAIL'];

  it.each(EXPECTATIONS)('ERROR при ожидании %s даёт FAIL, а не XFAIL', (expected) => {
    for (const assertionsPassed of [true, false]) {
      for (const safetyPassed of [true, false]) {
        const result = resolveCaseResult({
          expected,
          actual: 'ERROR',
          assertionsPassed,
          safetyPassed,
        });
        expect(result).toBe('FAIL');
        expect(result).not.toBe('XFAIL');
      }
    }
  });

  it('computeActualDisposition отдаёт ERROR для брошенного исключения', () => {
    expect(computeActualDisposition({ kind: 'threw', error: new Error('boom') })).toBe('ERROR');
  });
});

describe('расположение выводится из решения продовой политики доставки', () => {
  it.each([
    ['answer', 'DIRECT_ANSWER'],
    ['clarify', 'HOLD'],
    ['escalate', 'HOLD'],
  ] as const)('%s → %s', (decision, disposition) => {
    expect(dispositionOfDelivery(decision)).toBe(disposition);
    expect(computeActualDisposition({ kind: 'delivered', decision })).toBe(disposition);
  });
});

describe('gate blocking', () => {
  it.each([
    ['PASS', false],
    ['XFAIL', false],
    ['FAIL', true],
    ['XPASS', true],
  ] as const)('%s роняет gate: %s', (result, blocking) => {
    expect(isGateBlocking(result)).toBe(blocking);
  });
});

describe('computeExitCode', () => {
  const ALL: CaseResult[] = ['PASS', 'FAIL', 'XFAIL', 'XPASS'];

  it('baseline не падает никогда — даже на FAIL и XPASS', () => {
    expect(computeExitCode('baseline', ALL)).toBe(0);
    expect(computeExitCode('baseline', ['FAIL'])).toBe(0);
    expect(computeExitCode('baseline', ['XPASS'])).toBe(0);
    expect(computeExitCode('baseline', [])).toBe(0);
  });

  it('gate падает на FAIL и на XPASS', () => {
    expect(computeExitCode('gate', ['FAIL'])).toBe(1);
    expect(computeExitCode('gate', ['XPASS'])).toBe(1);
    expect(computeExitCode('gate', ['PASS', 'XFAIL', 'FAIL'])).toBe(1);
  });

  it('gate НЕ падает на PASS и XFAIL — и ни при каких других условиях', () => {
    expect(computeExitCode('gate', ['PASS'])).toBe(0);
    expect(computeExitCode('gate', ['XFAIL'])).toBe(0);
    expect(computeExitCode('gate', ['PASS', 'XFAIL', 'PASS'])).toBe(0);
    expect(computeExitCode('gate', [])).toBe(0);
  });
});
