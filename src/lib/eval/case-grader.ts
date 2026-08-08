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
 * ЕДИНЫЙ ИСТОЧНИК ИСТИНЫ НА unitId — `GradeContext.units`. Раньше правило
 * (`sourceRuleByUnitId`), числа (`numericsByUnitId`) и содержание ответа
 * (caller-supplied `EvidencePack`) были ТРЕМЯ независимыми картами, которые
 * runner мог рассинхронизировать между собой — например, оставить верные
 * unitId в `selectedUnitIds`, но подложить под них чужой или сфабрикованный
 * `EvidencePack`. Теперь на unitId есть ровно ОДНА запись — реальный
 * `PersistedKnowledgeUnit` плюс его `sourceRuleId` — и evidence pack грейдер
 * строит из неё САМ, из `selectedUnitIds`. Runner передаёт только `DraftAnswer`
 * (сам текст ответа — то, что реально проверяется) и трассировку id.
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
 * translation-rw3), а гадать её означало бы проектировать вслепую.
 */

import type { ActualDisposition } from './disposition';
import type { DraftAnswer } from '@/lib/knowledge/synthesis/draft-answer';
import { buildEvidencePack } from '@/lib/knowledge/synthesis/evidence-pack';
import { verifyAnswerClaims } from '@/lib/knowledge/synthesis/verify-answer-claims';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';
import type { ResolutionDecision } from '@/lib/knowledge/applicability/resolution';
import type { NumericAssertion } from './negative-case-oracle';

interface ObservedCaseCommon {
  readonly caseId: string;
  /** Пул до applicability-фильтрации. */
  readonly candidateUnitIds: readonly string[];
  /** Финальный порядок после reranker'а. */
  readonly rerankedUnitIds: readonly string[];
  readonly selectedUnitIds: readonly string[];
  readonly reasonCodes: readonly string[];
  /** Какие условия система назвала недостающими при уточнении. */
  readonly missingTriggerFacts?: readonly string[];
}

/**
 * Дискриминированное объединение по `disposition`: у HOLD/ERROR в принципе НЕТ
 * поля `draft` — состояние «HOLD, но с синтезированным ответом» невозможно
 * сконструировать типобезопасно, а не просто «не проверяется». Раньше `answer`
 * было опциональным полем на любой disposition, и runner мог по ошибке
 * приложить черновик к HOLD-кейсу — грейдер это молча игнорировал.
 */
export type ObservedCase =
  | (ObservedCaseCommon & { readonly disposition: 'DIRECT_ANSWER'; readonly draft: DraftAnswer })
  | (ObservedCaseCommon & { readonly disposition: Exclude<ActualDisposition, 'DIRECT_ANSWER'> });

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

/** Единственный trusted факт про unitId: реальный unit плюс его исходное правило. */
export interface UnitProvenance {
  readonly unit: PersistedKnowledgeUnit;
  /** Evaluation-only provenance (план §0.3) — не поле unit'а, не попадает в retrievalText. */
  readonly sourceRuleId: number;
}

export interface GradeContext {
  /** Ворота retrieval: план фиксирует top-5. Обязано быть положительным целым. */
  readonly topK: number;
  readonly units: ReadonlyMap<string, UnitProvenance>;
}

function rulesOf(unitIds: readonly string[], units: ReadonlyMap<string, UnitProvenance>): Set<number> {
  const rules = new Set<number>();
  for (const unitId of unitIds) {
    const entry = units.get(unitId);
    if (entry !== undefined) rules.add(entry.sourceRuleId);
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
  const { units, topK } = context;

  if (!Number.isInteger(topK) || topK <= 0) {
    reasons.push(`topK обязан быть положительным целым, получено: ${topK}`);
    return { caseId: expectation.caseId, result: 'FAIL', reasons };
  }

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

  // Units без записи в trusted-карте сообщаются ОТДЕЛЬНО. Молча их отбрасывая,
  // грейдер превращал бы устаревшую или пустую карту в «правило не найдено» —
  // диагностическую чёрную дыру, где сбой инструментовки неотличим от сбоя
  // поиска. Скан включает candidateUnitIds: неотображённый unit, застрявший в
  // пуле кандидатов и не прошедший дальше, — тот же симптом.
  const unmapped = [
    ...new Set([
      ...observed.candidateUnitIds,
      ...observed.rerankedUnitIds,
      ...observed.selectedUnitIds,
    ]),
  ].filter((unitId) => !units.has(unitId));
  if (unmapped.length > 0) {
    reasons.push(
      `units вне trusted-карты (нет записи UnitProvenance): ${unmapped.join(', ')} — ` +
        'карта пуста или устарела; это сбой инструментовки, а не поиска'
    );
  }

  // Retrieval gate.
  const inTopK = rulesOf(observed.rerankedUnitIds.slice(0, topK), units);
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
    const candidates = rulesOf(observed.candidateUnitIds, units);
    const absent = expectation.requiredCandidateRuleIds.filter((id) => !candidates.has(id));
    if (absent.length > 0) {
      reasons.push(
        `правил ${absent.join(', ')} нет среди кандидатов — система промолчала, а не рассудила`
      );
    }
  }

  const selected = rulesOf(observed.selectedUnitIds, units);

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
    if (observed.disposition !== 'DIRECT_ANSWER') {
      reasons.push(
        'ожидался прямой ответ, но синтезированного ответа нет — нечего верифицировать'
      );
    } else if (unmapped.length === 0) {
      // Evidence pack строится ГРЕЙДЕРОМ из trusted units по selectedUnitIds —
      // тем же `buildEvidencePack`, которым пользуется сам движок (единый
      // источник политики). Runner не может подложить чужой pack: он передаёт
      // только текст ответа (`draft`), а не то, против чего этот текст
      // проверяется. Пропускается, только если unmapped уже нашёл нерешаемую
      // проблему с провенансом selected — buildEvidencePack иначе просто
      // упадёт исключением на том же самом отсутствующем unit'е.
      const selectedUnits = observed.selectedUnitIds
        .map((id) => units.get(id)?.unit)
        .filter((u): u is PersistedKnowledgeUnit => u !== undefined);
      const resolution: ResolutionDecision = {
        disposition: 'ANSWER',
        selected: observed.selectedUnitIds,
        undetermined: [],
        excluded: [],
        overridden: [],
        numericConflicts: [],
        requiresHumanReview: false,
        clarificationNeeds: { facets: [], triggerFacts: [], ambiguities: [] },
        reasons: [],
      };
      const evidencePack = buildEvidencePack(selectedUnits, resolution);

      if (observed.draft.answerSource !== 'knowledge_base') {
        reasons.push(
          `answerSource=${observed.draft.answerSource} — прямой ответ обязан быть из базы знаний (§0.3 №4)`
        );
      }

      const verification = verifyAnswerClaims(observed.draft, evidencePack);
      for (const violation of verification.violations) {
        reasons.push(`непроверенное утверждение [${violation.code}]: ${violation.detail}`);
      }
    }

    if (expectation.requiredNumerics !== undefined) {
      const covered = new Set(
        observed.selectedUnitIds.flatMap((unitId) => {
          const constraint = units.get(unitId)?.unit.numericConstraint;
          return constraint !== null && constraint !== undefined ? [numericKey(constraint)] : [];
        })
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
