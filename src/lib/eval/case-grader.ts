/**
 * Вердикт по одному кейсу acceptance-пакета — ворота плана §0.4, сведённые в
 * одно место (Beads translation-yz9 / PR H).
 *
 * ПОРЯДОК ПРОВЕРОК — СУТЬ, А НЕ ОФОРМЛЕНИЕ.
 *
 * Retrieval gate идёт первым, потому что план прямо запрещает засчитывать успех
 * по красивому финальному ответу: если ожидаемая группа правил не попала в
 * reranked top-K, кейс провален независимо от текста. Иначе система, которая
 * ничего не нашла, но складно написала, выглядела бы работающей.
 *
 * `answerSource === 'general_ai'` — автоматический провал (§0.3 №4), даже когда
 * текст совпал с ожидаемым: правильный ответ без найденного knowledge unit
 * означает, что сработала общая эрудиция модели, а не база знаний.
 *
 * Сообщаются ВСЕ причины провала, а не первая: артефакт прогона нужен для
 * диагноза, и чинить по одной причине за прогон слишком дорого.
 */

import type { ActualDisposition } from './disposition';
import type { AnswerSource } from '@/lib/knowledge/synthesis/draft-answer';
import type { VerificationResult } from '@/lib/knowledge/synthesis/verify-answer-claims';
import type { NumericAssertion } from './negative-case-oracle';

/** Что прогон реально показал по кейсу. Всё, на чём строится вердикт. */
export interface ObservedCase {
  readonly caseId: string;
  /** Пул до applicability-фильтрации. */
  readonly candidateUnitIds: readonly string[];
  /** Финальный порядок после reranker'а. */
  readonly rerankedUnitIds: readonly string[];
  readonly selectedUnitIds: readonly string[];
  readonly disposition: ActualDisposition;
  readonly answerSource: AnswerSource;
  readonly verification: VerificationResult;
  /** Числа, покрытые ВЫБРАННЫМИ units совместно. */
  readonly coveredNumerics: readonly NumericAssertion[];
  readonly reasonCodes: readonly string[];
}

/** Чего ожидает oracle. Поля-опции — только там, где неприменимы. */
export interface CaseExpectation {
  readonly caseId: string;
  readonly expectedRuleIds: readonly number[];
  readonly expectedDisposition: 'DIRECT_ANSWER' | 'HOLD';
  readonly requiredCandidateRuleIds?: readonly number[];
  readonly requiredSelectedRuleIds?: readonly number[];
  readonly forbiddenSelectedRuleIds?: readonly number[];
  readonly requiredNumerics?: readonly NumericAssertion[];
  readonly expectedReasonCodes?: readonly string[];
}

export interface CaseVerdict {
  readonly caseId: string;
  readonly result: 'PASS' | 'FAIL';
  readonly reasons: readonly string[];
}

export interface GradeOptions {
  /** Ворота retrieval: план фиксирует top-5. */
  readonly topK: number;
}

function rulesOf(
  unitIds: readonly string[],
  sourceRuleByUnitId: ReadonlyMap<string, number>
): Set<number> {
  const rules = new Set<number>();
  for (const unitId of unitIds) {
    const ruleId = sourceRuleByUnitId.get(unitId);
    if (ruleId !== undefined) rules.add(ruleId);
  }
  return rules;
}

/**
 * Ключ — ПАРА (значение, единица). «3 цикла» не закрывается «3 секундами»:
 * Q04 требует совместного покрытия 15 сек / 30 сек / 3 цикла, и сверка по
 * голому числу засчитала бы неверную единицу как выполненное требование.
 */
const numericKey = (assertion: NumericAssertion) => `${assertion.value}::${assertion.unit}`;

export function gradeCase(
  expectation: CaseExpectation,
  observed: ObservedCase,
  sourceRuleByUnitId: ReadonlyMap<string, number>,
  options: GradeOptions
): CaseVerdict {
  const reasons: string[] = [];

  // 1. Retrieval gate — до всего остального.
  const topK = rulesOf(observed.rerankedUnitIds.slice(0, options.topK), sourceRuleByUnitId);
  const missing = expectation.expectedRuleIds.filter((ruleId) => !topK.has(ruleId));
  if (missing.length > 0) {
    reasons.push(
      `retrieval gate: правил ${missing.join(', ')} нет в reranked top-${options.topK} — ` +
        'кейс провален независимо от текста ответа'
    );
  }

  // 2. Кандидаты: конкурирующее правило обязано БЫТЬ найдено, даже если потом
  //    отброшено. Иначе «не применил» неотличимо от «не нашёл».
  if (expectation.requiredCandidateRuleIds !== undefined) {
    const candidates = rulesOf(observed.candidateUnitIds, sourceRuleByUnitId);
    const absent = expectation.requiredCandidateRuleIds.filter((id) => !candidates.has(id));
    if (absent.length > 0) {
      reasons.push(
        `правил ${absent.join(', ')} нет среди кандидатов — система промолчала, а не рассудила`
      );
    }
  }

  const selected = rulesOf(observed.selectedUnitIds, sourceRuleByUnitId);

  if (expectation.requiredSelectedRuleIds !== undefined) {
    const notSelected = expectation.requiredSelectedRuleIds.filter((id) => !selected.has(id));
    if (notSelected.length > 0) {
      reasons.push(`обязательные правила ${notSelected.join(', ')} не выбраны`);
    }
  }

  if (expectation.forbiddenSelectedRuleIds !== undefined) {
    const wronglySelected = expectation.forbiddenSelectedRuleIds.filter((id) => selected.has(id));
    if (wronglySelected.length > 0) {
      reasons.push(
        `запрещённые правила ${wronglySelected.join(', ')} выбраны — узкое исключение применено не там`
      );
    }
  }

  if (observed.disposition !== expectation.expectedDisposition) {
    reasons.push(
      `disposition=${observed.disposition}, ожидался ${expectation.expectedDisposition}`
    );
  }

  if (expectation.expectedReasonCodes !== undefined) {
    const actual = new Set(observed.reasonCodes);
    const absent = expectation.expectedReasonCodes.filter((code) => !actual.has(code));
    if (absent.length > 0) {
      reasons.push(`нет ожидаемых reason-кодов: ${absent.join(', ')}`);
    }
  }

  // Проверки, осмысленные ТОЛЬКО когда система действительно отвечала.
  // При ожидаемом HOLD отвечать нечем: требовать цитаты и заземление чисел от
  // уточняющего вопроса — значит проваливать кейс за правильное поведение.
  if (expectation.expectedDisposition === 'DIRECT_ANSWER') {
    if (observed.answerSource !== 'knowledge_base') {
      reasons.push(
        `answerSource=${observed.answerSource} — ответ не из базы знаний, автоматический FAIL (§0.3 №4)`
      );
    }

    if (!observed.verification.verified) {
      for (const violation of observed.verification.violations) {
        reasons.push(`непроверенное утверждение [${violation.code}]: ${violation.detail}`);
      }
    }

    if (expectation.requiredNumerics !== undefined) {
      const covered = new Set(observed.coveredNumerics.map(numericKey));
      const uncovered = expectation.requiredNumerics.filter(
        (required) => !covered.has(numericKey(required))
      );
      if (uncovered.length > 0) {
        reasons.push(
          'выбранные units не покрывают совместно: ' +
            uncovered.map((n) => `${n.value} ${n.unit}`).join(', ')
        );
      }
    }
  }

  return {
    caseId: expectation.caseId,
    result: reasons.length === 0 ? 'PASS' : 'FAIL',
    reasons,
  };
}
