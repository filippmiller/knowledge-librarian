/**
 * Черновик ответа нового orchestration-пути (план §3 PR H).
 *
 * `answerSource` выставляется ОСОЗНАННО этим путём, а не наследуется от старого
 * движка: план прямо предупреждает, что иначе ворота «не `general_ai`» проверяют
 * не то, что мы думаем. Union повторяет значения
 * `EnhancedAnswerResult.answerSource`, чтобы артефакт прогона говорил на том же
 * языке, что и существующая телеметрия.
 */

import type { AnswerSource } from '@/lib/ai/answer-source';

export type { AnswerSource };

export interface DraftAnswer {
  readonly text: string;
  /** Идентификаторы unit-ов, на которых построен ответ. Основание цитат. */
  readonly citedUnitIds: readonly string[];
  readonly answerSource: AnswerSource;
}
