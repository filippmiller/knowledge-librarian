/**
 * Типизированный доменный контракт применимости (PR B1).
 *
 * Источник истины по смыслу — `docs/plans/2026-08-05-applicability-truth-table.md`;
 * расхождение кода с ним считается ошибкой кода. Модуль чисто декларативный:
 * ни Prisma, ни LLM, ни ввода-вывода — только типы, реестры и Zod-схемы.
 * Evaluator'ы, которые ими пользуются, приходят в PR B2.
 */
export * from './review';
export * from './facets';
export * from './kinds';
export * from './trigger-facts';
export * from './profile';
export * from './query-frame';
