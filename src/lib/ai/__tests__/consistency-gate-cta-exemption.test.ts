import { describe, expect, it } from 'vitest';
import { VERIFIER_SYSTEM_PROMPT } from '../consistency-gate';

/**
 * translation-nof, механизм 2. `verifyAnswer()` — сплошной вызов модели: сам
 * разбор «это факт или нет» происходит ВНУТРИ verifier-модели по
 * VERIFIER_SYSTEM_PROMPT, локальной детерминированной логики для этого нет.
 * Соответствие модели инструкции здесь не проверить юнит-тестом — это
 * подтверждено замером на живом проде (withheld-audit.json, 2026-08-14):
 * P5/R3/R4 получали unsupported_claims на фразах вида «пришлите скан
 * документа, и мы уточним все детали, включая стоимость и сроки выполнения»
 * — то есть на стандартном следующем шаге обращения, который сам
 * CLIENT_ANSWERING_PROMPT требует в конце ответа (см. «ФОРМА ОТВЕТА»), а не
 * на факте из базы знаний.
 *
 * Этот тест — regression guard: ловит, если кто-то уберёт формулировку
 * исключения при рефакторинге, а не то, следует ли ей модель.
 */
describe('VERIFIER_SYSTEM_PROMPT: исключение для следующего шага обращения', () => {
  it('явно исключает стандартный CTA — «пришлите скан», «свяжитесь с нами»', () => {
    expect(VERIFIER_SYSTEM_PROMPT).toMatch(/пришлите скан/i);
    expect(VERIFIER_SYSTEM_PROMPT).toMatch(/свяжитесь с нами/i);
  });

  it('явно НЕ исключает обещание о возможностях компании — граница не размыта', () => {
    // Без этого предложение выше легко прочитать как «не проверяй обещания
    // вообще» — а из двух утверждений, снятых с R3, ровно одно («мы подаём
    // документы в Минюст») остаётся кандидатом в факты и обязано проверяться.
    expect(VERIFIER_SYSTEM_PROMPT).toMatch(/возможностях компании/i);
    expect(VERIFIER_SYSTEM_PROMPT).toMatch(/проверяется как обычно/i);
  });

  it('раздел «что не проверять» физически предшествует правилу разбора claims', () => {
    // Порядок в промпте — не оформление: инструкция должна попасть в модель
    // раньше, чем модель начнёт извлекать факты-кандидаты.
    const exemptionIndex = VERIFIER_SYSTEM_PROMPT.indexOf('пришлите скан');
    const algorithmIndex = VERIFIER_SYSTEM_PROMPT.indexOf('АЛГОРИТМ');
    expect(exemptionIndex).toBeGreaterThan(0);
    expect(algorithmIndex).toBeGreaterThan(exemptionIndex);
  });
});
