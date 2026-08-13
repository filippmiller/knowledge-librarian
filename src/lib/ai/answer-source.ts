/**
 * Откуда взялся ответ — метка для аудита, а не «по какой ветке кода мы вышли».
 *
 * `none` — ответа из документов нет: отказ, уточнение без цитат, пустой retrieval.
 * Без этого значения отказ («в базе нет данных») помечался как `knowledge_base`
 * и в корпоративном отчёте выглядел как ответ по инструкциям.
 */
export const ANSWER_SOURCES = [
  'knowledge_base',
  'general_ai',
  'deterministic_guardrail',
  'none',
] as const;

export type AnswerSource = (typeof ANSWER_SOURCES)[number];

/**
 * Метка основного синтез-пути. Только структурный сигнал: `insufficient`
 * значит, что retrieval не дал опоры и модели велено отказаться.
 * Текст ответа сюда не смотрим — иначе отказ подгоняется по подстроке
 * «нет данных» и зеленеет, не меняя поведения.
 */
export function resolveMainPathAnswerSource(
  confidenceLevel: 'high' | 'medium' | 'low' | 'insufficient'
): 'knowledge_base' | 'none' {
  return confidenceLevel === 'insufficient' ? 'none' : 'knowledge_base';
}
