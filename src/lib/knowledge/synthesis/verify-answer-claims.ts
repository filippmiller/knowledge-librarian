/**
 * Детерминированная проверка ответа против evidence pack (план §3 PR H).
 *
 * Ключевое свойство: проверка НЕ спрашивает модель, обоснован ли ответ. Судья,
 * сделанный из того же материала, что и подсудимый, повторяет его ошибки —
 * поэтому здесь только арифметика и сравнение множеств.
 *
 * Проверяется:
 * - каждое число ответа присутствует среди `numericConstraint` ВЫБРАННЫХ
 *   unit-ов (план: «каждое число в ответе сверяется с numericConstraint»);
 * - каждая цитата ведёт на unit из pack;
 * - `answerSource === 'knowledge_base'` — §0.3 №4: верный текст, полученный
 *   general-AI fallback'ом, засчитывается как FAIL, а не как успех.
 *
 * Сообщаются ВСЕ нарушения сразу: артефакт прогона нужен для диагноза, а
 * «первая ошибка» заставляет чинить кейс по одному кругу за прогон.
 */

import { checkClaimGrounding } from '@/lib/ai/claim-grounding';
import type { EvidencePack } from './evidence-pack';
import type { DraftAnswer } from './draft-answer';

export const VERIFICATION_VIOLATION_CODES = [
  /** Число в ответе не подтверждено ни одним выбранным unit'ом. */
  'unsupported_number',
  /** Цитата ведёт на unit, отсутствующий в evidence pack. */
  'unknown_citation',
  /** Ответ построен, но не сослался ни на что. */
  'uncited_answer',
  /** Источник ответа — не база знаний. */
  'forbidden_answer_source',
  /** Пустой текст ответа. */
  'empty_answer',
] as const;

export type VerificationViolationCode = (typeof VERIFICATION_VIOLATION_CODES)[number];

export interface VerificationViolation {
  readonly code: VerificationViolationCode;
  readonly detail: string;
}

export interface VerificationResult {
  readonly verified: boolean;
  readonly violations: readonly VerificationViolation[];
}

/**
 * Заземление чисел делегировано `claim-grounding.ts` — ЕДИНСТВЕННОМУ месту, где
 * в этом репозитории живёт политика числовых утверждений.
 *
 * Своя реализация здесь была и оказалась строго хуже. Она сверяла ГОЛОЕ
 * значение, без единицы, — ровно тот дефект, от которого `claim-grounding`
 * защищается по построению и о котором прямо предупреждает в своей шапке
 * («срок 5 дней» против «5 офисов»). Следствия, подтверждённые двумя
 * независимыми ревью:
 *
 * - «15 минут» проходило против ограничения «15 секунд»;
 * - числительные словами («не более ПЯТИ циклов») не проверялись вовсе;
 * - дата «07.08.2026», время «15:30» и номер пункта «4.2» считались
 *   неподтверждёнными утверждениями и валили верный ответ.
 *
 * Источники заземления — `statement` и цитата КАЖДОГО выбранного unit'а, то
 * есть ровно тот текст, который синтезатор видел. Сверка только со структурным
 * `numericConstraint` была бы строже, чем реальность: у unit'а одно ограничение,
 * а в его statement чисел может быть несколько, и добросовестный пересказ
 * наказывался бы за использование единственного доступного ему текста.
 */
function groundingSourcesOf(pack: EvidencePack): string[] {
  return pack.items.flatMap((item) => [item.statement, item.citation.quote]);
}

export function verifyAnswerClaims(
  draft: DraftAnswer,
  pack: EvidencePack
): VerificationResult {
  const violations: VerificationViolation[] = [];

  if (draft.text.trim().length === 0) {
    violations.push({ code: 'empty_answer', detail: 'текст ответа пуст' });
  }

  if (draft.answerSource !== 'knowledge_base') {
    violations.push({
      code: 'forbidden_answer_source',
      detail: `answerSource=${draft.answerSource} — ответ получен не из базы знаний (§0.3 №4)`,
    });
  }

  const knownUnitIds = new Set(pack.items.map((item) => item.unitId));
  if (draft.citedUnitIds.length === 0) {
    violations.push({
      code: 'uncited_answer',
      detail: 'ответ не сослался ни на один unit — обоснование непроверяемо',
    });
  }
  for (const unitId of draft.citedUnitIds) {
    if (!knownUnitIds.has(unitId)) {
      violations.push({
        code: 'unknown_citation',
        detail: `цитата на «${unitId}», которого нет в evidence pack`,
      });
    }
  }

  const grounding = checkClaimGrounding(draft.text, groundingSourcesOf(pack));
  for (const claim of grounding.ungrounded) {
    violations.push({
      code: 'unsupported_number',
      detail: `«${claim.value} ${claim.unit}» не подтверждено ни одним выбранным unit'ом (${claim.context})`,
    });
  }

  return { verified: violations.length === 0, violations };
}
