/**
 * Вердикт по одному кейсу acceptance-пакета — ворота плана §0.4, сведённые в
 * одно место (Beads translation-yz9 / PR H).
 *
 * ПОРЯДОК ПРОВЕРОК — СУТЬ, А НЕ ОФОРМЛЕНИЕ.
 *
 * Целостность trace проверяется ПЕРЕД retrieval gate: противоречивый trace
 * (selected вне reranked, reranked вне candidates, дубли) обесценивает любой
 * следующий вывод, поэтому сообщается отдельно и до содержательных проверок.
 *
 * Retrieval gate идёт следующим, потому что план прямо запрещает засчитывать
 * успех по красивому финальному ответу: если ожидаемая группа правил не
 * попала в reranked top-K, кейс провален независимо от текста.
 *
 * `answerSource === 'general_ai'` — автоматический провал (§0.3 №4), даже когда
 * текст совпал с ожидаемым: правильный ответ без найденного knowledge unit
 * означает, что сработала общая эрудиция модели, а не база знаний.
 *
 * ГРЕЙДЕР САМ ВЫЗЫВАЕТ `verifyAnswerClaims`, а не принимает готовый вердикт.
 * Раньше `ObservedCase` нёс предвычисленный `VerificationResult` — тот же
 * класс дыры, что был с числовым покрытием (raннер мог передать любой
 * результат, включая сфабрикованный). Теперь на вход идут `DraftAnswer` и
 * `EvidencePack`, а проверку грейдер делает сам.
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
 *
 * Также НЕ проверяется: достаточность СОСТАВА раздробленного булевого правила
 * (в отличие от чисел Q04, для которых есть `requiredNumerics`). Если
 * экстракция раздробит правило 9 (согласие/перчатки/остановка) на несколько
 * units и будет выбран только один фрагмент, `sourceRuleId` всё равно
 * засчитает правило целиком. Механизм для этого сознательно не построен —
 * форма фрагментации неизвестна до реальной DOCX-экстракции (Beads
 * translation-tds), а гадать её означало бы проектировать вслепую.
 */

import type { ActualDisposition } from './disposition';
import type { DraftAnswer } from '@/lib/knowledge/synthesis/draft-answer';
import type { EvidencePack } from '@/lib/knowledge/synthesis/evidence-pack';
import { verifyAnswerClaims } from '@/lib/knowledge/synthesis/verify-answer-claims';
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
  readonly reasonCodes: readonly string[];
  /** Какие условия система назвала недостающими при уточнении. */
  readonly missingTriggerFacts?: readonly string[];
  /**
   * Присутствует, только когда система реально синтезировала ответ.
   * `buildEvidencePack` сам отказывается работать при disposition, отличном
   * от `ANSWER` — в этой архитектуре у HOLD нет черновика ответа в принципе,
   * не только «его не проверяют».
   */
  readonly answer?: {
    readonly draft: DraftAnswer;
    readonly evidencePack: EvidencePack;
  };
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
 * ворота — та же граница доверия, что и с oracle. Карту всё равно строит
 * вызывающий код: полностью закрыть границу можно только передав сюда реальные
 * persisted units вместо готовой карты — это отдельная, более крупная правка
 * раннера, а не этого модуля.
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
 *
 * ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ (ревью ChatGPT): суффиксное правило схлопывает `ms` и
 * `m` в одно значение. В этом acceptance-пакете единицы — только `seconds` и
 * `cycles`, коллизии `ms`/`m` физически не возникает, поэтому проблема не
 * блокирует H. Закрытый словарь единиц вместо суффиксного правила стоит
 * ставить, когда набор единиц расширится за пределы этого пакета.
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

  if (observed.caseId !== expectation.caseId) {
    reasons.push(
      `caseId не совпадает: expectation="${expectation.caseId}", observed="${observed.caseId}" — ` +
        'вердикт относился бы не к тому кейсу'
    );
    // Дальнейшие проверки бессмысленны для заведомо перепутанной пары.
    return { caseId: expectation.caseId, result: 'FAIL', reasons };
  }

  // Целостность trace — раньше любых содержательных проверок. Дубли и unit,
  // всплывший в selected/reranked без прохождения через предыдущий этап,
  // обесценивают вывод retrieval gate: неясно, что вообще произошло.
  const hasDuplicates = (ids: readonly string[]) => new Set(ids).size !== ids.length;
  if (
    hasDuplicates(observed.candidateUnitIds) ||
    hasDuplicates(observed.rerankedUnitIds) ||
    hasDuplicates(observed.selectedUnitIds)
  ) {
    reasons.push('целостность trace: обнаружен дубль unitId внутри одного этапа');
  }
  const candidateSet = new Set(observed.candidateUnitIds);
  const rerankedSet = new Set(observed.rerankedUnitIds);
  const rerankedOutsideCandidates = observed.rerankedUnitIds.filter((id) => !candidateSet.has(id));
  if (rerankedOutsideCandidates.length > 0) {
    reasons.push(
      `целостность trace: units в reranked, но не в candidates: ${rerankedOutsideCandidates.join(', ')}`
    );
  }
  const selectedOutsideReranked = observed.selectedUnitIds.filter((id) => !rerankedSet.has(id));
  if (selectedOutsideReranked.length > 0) {
    reasons.push(
      `целостность trace: units в selected, но не в reranked: ${selectedOutsideReranked.join(', ')}`
    );
  }

  // Units без записи в карте провенанса сообщаются ОТДЕЛЬНО. Молча их
  // отбрасывая, грейдер превращал бы устаревшую или пустую карту в
  // «правило не найдено» — диагностическую чёрную дыру, где сбой инструментовки
  // неотличим от сбоя поиска. Скан включает candidateUnitIds: неотображённый
  // unit, который так и не прошёл дальше пула кандидатов, — тот же симптом.
  const unmapped = [
    ...new Set([
      ...observed.candidateUnitIds,
      ...observed.rerankedUnitIds,
      ...observed.selectedUnitIds,
    ]),
  ].filter((unitId) => !sourceRuleByUnitId.has(unitId));
  if (unmapped.length > 0) {
    reasons.push(
      `units вне карты провенанса (не отображены на правило): ${unmapped.join(', ')} — ` +
        'карта пуста или устарела; это сбой инструментовки, а не поиска'
    );
  }

  // Retrieval gate.
  const inTopK = rulesOf(observed.rerankedUnitIds.slice(0, topK), sourceRuleByUnitId);
  const missing = expectation.expectedRuleIds.filter((ruleId) => !inTopK.has(ruleId));
  if (missing.length > 0) {
    reasons.push(
      `retrieval gate: правил ${missing.join(', ')} нет в reranked top-${topK} — ` +
        'кейс провален независимо от текста ответа'
    );
  }

  // Кандидаты: конкурирующее правило обязано БЫТЬ найдено, даже если потом
  // отброшено. Иначе «не применил» неотличимо от «не нашёл».
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
   * Умолчание — ключевая правка после первого ревью. Без него кейс проходил,
   * когда система нашла нужное правило в top-5, но ОТВЕТИЛА по другому:
   * retrieval проверяет присутствие, а выбор не проверялся ничем.
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

  if (expectation.expectedDisposition === 'DIRECT_ANSWER') {
    if (observed.answer === undefined) {
      reasons.push(
        'ожидался прямой ответ, но синтезированного ответа нет — нечего верифицировать'
      );
    } else {
      const { draft, evidencePack } = observed.answer;

      if (draft.answerSource !== 'knowledge_base') {
        reasons.push(
          `answerSource=${draft.answerSource} — прямой ответ обязан быть из базы знаний (§0.3 №4)`
        );
      }

      // Вызывается напрямую, а не принимается готовым результатом: раннер
      // не может подложить сфабрикованный VerificationResult.
      const verification = verifyAnswerClaims(draft, evidencePack);
      for (const violation of verification.violations) {
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
     * must_clarify. Проверка через ПЕРЕСЕЧЕНИЕ с ожидаемыми конкурентами, а
     * не через общий размер `selected`: посторонний выбранный unit не должен
     * маскировать факт, что один из ВЗАИМОИСКЛЮЧАЮЩИХ вариантов уже выбран.
     * Удержать ответ, разрешив при этом конфликт в пользу одного из
     * конкурентов, — это и есть «выбор наугад», который план запрещает.
     */
    if (expectation.expectedRuleIds.length > 1) {
      const selectedCompetitors = expectation.expectedRuleIds.filter((id) => selected.has(id));
      if (selectedCompetitors.length === 1) {
        reasons.push(
          `выбрано ровно одно из взаимоисключающих правил (${selectedCompetitors[0]}) при ` +
            'ожидаемом уточнении — это выбор наугад, а не вопрос'
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
