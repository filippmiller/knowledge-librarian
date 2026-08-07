/**
 * Вердикт по одному кейсу acceptance-пакета — ворота плана §0.4, сведённые в
 * одно место (Beads translation-yz9 / PR H).
 *
 * ПОРЯДОК ПРОВЕРОК — СУТЬ, А НЕ ОФОРМЛЕНИЕ.
 *
 * Retrieval gate идёт первым, потому что план прямо запрещает засчитывать успех
 * по красивому финальному ответу: если ожидаемая группа правил не попала в
 * reranked top-K, кейс провален независимо от текста.
 *
 * `answerSource === 'general_ai'` — автоматический провал (§0.3 №4), даже когда
 * текст совпал с ожидаемым: правильный ответ без найденного knowledge unit
 * означает, что сработала общая эрудиция модели, а не база знаний.
 *
 * ЧЕГО ЭТОТ ГРЕЙДЕР НЕ ДЕЛАЕТ — и это ограничение, а не недоделка.
 *
 * Он проверяет СТРУКТУРУ, а не смысл ответа: текст ответа с `expected_answer`
 * не сравнивается. Система, выбравшая правильные units и не выдумавшая чисел,
 * но пересказавшая правило НЕВЕРНО («после паузы можно повторять сколько
 * угодно»), пройдёт эти ворота. Детерминированно проверить смысл нельзя, а
 * LLM-судья на том же материале повторяет ошибки подсудимого. Поэтому «Answer
 * gate» §0.4 закрывается этим грейдером лишь частично: структурный PASS —
 * необходимое условие, но не достаточное, и финальные ответы обязан прочитать
 * человек. Продавать прогон как доказанную корректность ответов нельзя.
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
  readonly reasonCodes: readonly string[];
  /** Какие условия система назвала недостающими при уточнении. */
  readonly missingTriggerFacts?: readonly string[];
}

/** Чего ожидает oracle. Поля-опции — только там, где неприменимы. */
export interface CaseExpectation {
  readonly caseId: string;
  readonly expectedRuleIds: readonly number[];
  readonly expectedDisposition: 'DIRECT_ANSWER' | 'HOLD';
  readonly requiredCandidateRuleIds?: readonly number[];
  /** По умолчанию — `expectedRuleIds` при DIRECT_ANSWER. См. соответствующую проверку. */
  readonly requiredSelectedRuleIds?: readonly number[];
  readonly forbiddenSelectedRuleIds?: readonly number[];
  readonly requiredNumerics?: readonly NumericAssertion[];
  readonly expectedReasonCodes?: readonly string[];
  readonly expectedMissingTriggerFacts?: readonly string[];
}

export interface CaseVerdict {
  readonly caseId: string;
  readonly result: 'PASS' | 'FAIL';
  readonly reasons: readonly string[];
}

/**
 * Провенанс прогона. `numericsByUnitId` здесь, а не в `ObservedCase`, намеренно:
 * покрытие чисел ВЫЧИСЛЯЕТСЯ грейдером по выбранным units, а не принимается со
 * слов раннера. Иначе ошибка раннера (взять числа из oracle или со всех
 * фрагментов правила вместо реально выбранных) выглядела бы как пройденные
 * ворота — та же граница доверия, что и с oracle.
 */
export interface GradeContext {
  readonly topK: number;
  readonly sourceRuleByUnitId: ReadonlyMap<string, number>;
  readonly numericsByUnitId: ReadonlyMap<string, readonly NumericAssertion[]>;
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
 * Единица нормализуется до нижнего регистра без хвостовой «s»: oracle пишет
 * `seconds`, а производитель значений может отдать `second` — расхождение
 * написания не должно проваливать реально покрытое требование. При этом
 * `cycles` и `seconds` остаются разными, то есть «3 цикла» по-прежнему не
 * закрывается «3 секундами».
 */
const normalizeUnit = (unit: string) => unit.trim().toLowerCase().replace(/s$/, '');

const numericKey = (assertion: NumericAssertion) =>
  `${assertion.value}::${normalizeUnit(assertion.unit)}`;

export function gradeCase(
  expectation: CaseExpectation,
  observed: ObservedCase,
  context: GradeContext
): CaseVerdict {
  const reasons: string[] = [];
  const { sourceRuleByUnitId, numericsByUnitId, topK } = context;

  // Units без записи в карте провенанса сообщаются ОТДЕЛЬНО. Молча их
  // отбрасывая, грейдер превращал бы устаревшую или пустую карту в
  // «правило не найдено» — диагностическую чёрную дыру, где сбой инструментовки
  // неотличим от сбоя поиска.
  const unmapped = [...new Set([...observed.rerankedUnitIds, ...observed.selectedUnitIds])].filter(
    (unitId) => !sourceRuleByUnitId.has(unitId)
  );
  if (unmapped.length > 0) {
    reasons.push(
      `units вне карты провенанса (не отображены на правило): ${unmapped.join(', ')} — ` +
        'карта пуста или устарела; это сбой инструментовки, а не поиска'
    );
  }

  // 1. Retrieval gate — до всего остального.
  const inTopK = rulesOf(observed.rerankedUnitIds.slice(0, topK), sourceRuleByUnitId);
  const missing = expectation.expectedRuleIds.filter((ruleId) => !inTopK.has(ruleId));
  if (missing.length > 0) {
    reasons.push(
      `retrieval gate: правил ${missing.join(', ')} нет в reranked top-${topK} — ` +
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

  /**
   * Умолчание — ключевая правка после ревью. Без него кейс проходил, когда
   * система нашла нужное правило в top-5, но ОТВЕТИЛА по другому: retrieval
   * проверяет присутствие, а выбор не проверялся ничем. Для прямого ответа
   * ожидаемые правила обязаны быть среди выбранных.
   */
  const requiredSelected =
    expectation.requiredSelectedRuleIds ??
    (expectation.expectedDisposition === 'DIRECT_ANSWER' ? expectation.expectedRuleIds : []);
  const notSelected = requiredSelected.filter((id) => !selected.has(id));
  if (notSelected.length > 0) {
    reasons.push(`обязательные правила ${notSelected.join(', ')} не выбраны`);
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

  // `general_ai` запрещён на ОБОИХ путях: уточняющий вопрос, сочинённый общей
  // моделью, — тоже не работа базы знаний (§0.3 №4).
  if (observed.answerSource === 'general_ai') {
    reasons.push(
      'answerSource=general_ai — результат получен общей эрудицией модели, автоматический FAIL (§0.3 №4)'
    );
  }

  if (expectation.expectedDisposition === 'DIRECT_ANSWER') {
    if (observed.answerSource !== 'knowledge_base') {
      reasons.push(`answerSource=${observed.answerSource} — прямой ответ обязан быть из базы знаний`);
    }

    // Провал проверки — причина сам по себе. Пустой список нарушений при
    // `verified: false` раньше давал бесплатный PASS: цикл не выполнялся ни
    // разу, и ни одной причины не записывалось.
    if (!observed.verification.verified) {
      if (observed.verification.violations.length === 0) {
        reasons.push('verifyAnswerClaims не подтвердил ответ, не назвав нарушений');
      }
      for (const violation of observed.verification.violations) {
        reasons.push(`непроверенное утверждение [${violation.code}]: ${violation.detail}`);
      }
    }

    if (expectation.requiredNumerics !== undefined) {
      const covered = new Set(
        observed.selectedUnitIds.flatMap((unitId) =>
          (numericsByUnitId.get(unitId) ?? []).map(numericKey)
        )
      );
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
  } else {
    /**
     * must_clarify. Удержать ответ, ВЫБРАВ при этом ровно одно из
     * взаимоисключающих правил, — это и есть «выбор наугад», который план
     * запрещает: несогласие потом всё равно разрешится в пользу выбранного.
     * Ожидание HOLD с несколькими конкурентами означает, что система обязана
     * не разрешать конфликт до уточнения.
     */
    if (expectation.expectedRuleIds.length > 1 && selected.size === 1) {
      const [only] = [...selected];
      if (expectation.expectedRuleIds.includes(only)) {
        reasons.push(
          `выбрано ровно одно из взаимоисключающих правил (${only}) при ожидаемом уточнении — ` +
            'это выбор наугад, а не вопрос'
        );
      }
    }

    if (expectation.expectedMissingTriggerFacts !== undefined) {
      const named = new Set(observed.missingTriggerFacts ?? []);
      const unnamed = expectation.expectedMissingTriggerFacts.filter((fact) => !named.has(fact));
      if (unnamed.length > 0) {
        reasons.push(
          `система не назвала недостающие условия: ${unnamed.join(', ')} — ` +
            'уточнение обязано указывать, ЧЕГО не хватает'
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
