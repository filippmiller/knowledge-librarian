/**
 * Типизированный доменный контракт применимости (PR B1) и evaluator'ы над ним
 * (PR B2).
 *
 * Источник истины по смыслу — `docs/plans/2026-08-05-applicability-truth-table.md`;
 * расхождение кода с ним считается ошибкой кода. Модуль чисто декларативный и
 * чисто вычислительный: ни Prisma, ни LLM, ни ввода-вывода, ни чтения часов —
 * только типы, реестры, Zod-схемы и четыре чистые функции решения.
 *
 * Четыре, а не одна: truth table сама различает независимые проверки — годен ли
 * unit вообще (§2, §3.2, §5), совпадает ли его scope с вопросом (§3), активно
 * ли условие исключения (§4.1 п.2) и что делать с набором подошедших unit'ов
 * (§4.1 п.1/п.3, §4.2). У каждой — свой владелец решения и своя suite тестов.
 */
export * from './text';
export * from './review';
export * from './concepts';
export * from './concept-registry';
export * from './facets';
export * from './kinds';
export * from './trigger-facts';
export * from './profile';
export * from './query-frame';
export * from './query-frame-builder';
export * from './extraction';
export * from './extraction-parent-refs';
export * from './identity';
export * from './identity-assignment';
export * from './review-decision';
export * from './jsonl';
export * from './persisted-unit';
export * from './reasons';
export * from './eligibility';
export * from './scope';
export * from './trigger';
export * from './resolution';
