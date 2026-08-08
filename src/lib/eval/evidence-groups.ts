/**
 * Multi-clause coverage для раздробленных булевых правил (pre-retrieval
 * hardening, Step 8; gap named in case-grader.ts's own header comment).
 *
 * `case-grader.ts` уже проверяет совместное покрытие ЧИСЕЛ (`requiredNumerics`
 * / `numericKey`) — несколько units должны СОВМЕСТНО дать 15 сек + 30 сек +
 * 3 цикла для правила 4. Для булевых/составных правил (правило 9: согласие +
 * перчатки + остановка) эквивалентного механизма не было: если экстракция
 * раздробит правило на несколько units и выбран только ОДИН фрагмент,
 * `sourceRuleId` засчитывал правило целиком.
 *
 * Клаузы описаны ПРЕДИКАТАМИ над содержанием unit'а (formulation/trigger
 * facts), а не списками unitId — `.claude/audits/2026-08-08-extraction-
 * stability-fragmentation-report.md` §4 документирует, что unitId стабилен
 * МЕЖДУ прогонами только когда evidence span не меняется (что не
 * гарантировано), тогда как формулировка требуемого компонента (например
 * "текст unit'а упоминает согласие") — куда более устойчивый сигнал.
 * Ключевые слова взяты из САМОГО источника (DOCX), не из формулировок oracle.
 */

import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';

export interface EvidenceClauseRequirement {
  readonly description: string;
  readonly matches: (unit: PersistedKnowledgeUnit) => boolean;
}

export interface RequiredEvidenceGroup {
  readonly ruleId: number;
  readonly description: string;
  /** Конъюнкция: ВСЕ клаузы обязаны быть покрыты. Одна клауза покрыта, если
   *  ХОТЯ БЫ ОДИН selected unit ей соответствует — так альтернативная
   *  фрагментация одной и той же клаузы на несколько units не наказывается. */
  readonly requiredClauses: readonly EvidenceClauseRequirement[];
}

export interface EvidenceGroupCoverageResult {
  readonly covered: boolean;
  readonly uncoveredClauseDescriptions: readonly string[];
}

export function evaluateEvidenceGroupCoverage(
  group: RequiredEvidenceGroup,
  selectedUnits: readonly PersistedKnowledgeUnit[]
): EvidenceGroupCoverageResult {
  const uncoveredClauseDescriptions = group.requiredClauses
    .filter((clause) => !selectedUnits.some((unit) => clause.matches(unit)))
    .map((clause) => clause.description);
  return { covered: uncoveredClauseDescriptions.length === 0, uncoveredClauseDescriptions };
}

function statementIncludes(pattern: RegExp): (unit: PersistedKnowledgeUnit) => boolean {
  return (unit) => pattern.test(unit.statement) || pattern.test(unit.sourceSpan.quote);
}

/**
 * Правило 9 (Помощь другого человека) — три компонента, названные в шапке
 * `case-grader.ts`: согласие / перчатки / остановка. Подтверждено живым
 * `--stage=extraction` прогоном (`scratchpad/extraction-runs/run{1,2}`,
 * anchor `fdea0ad3cb1caf58`, стабилен между прогонами) — реальные unitId
 * `4997d91d73b11aa3`/`c6db93b341eb1e60`/`4bef4675d1f027d2` существуют, но
 * клаузы описаны по содержанию, а не по этим id (см. шапку файла).
 *
 * Намеренно НЕ включены доп. units того же anchor (ограничение по силе/
 * времени, "согласие не бессрочно") — они реальны, но не входят в три
 * названных case-grader.ts компонента; расширять требование без явного
 * решения означало бы гадать за план.
 */
export const RULE_9_EVIDENCE_GROUP: RequiredEvidenceGroup = {
  ruleId: 9,
  description: 'Помощь другого человека: согласие + перчатки + немедленная остановка по просьбе',
  requiredClauses: [
    { description: 'явное согласие того, кому помогают', matches: statementIncludes(/соглас/i) },
    { description: 'чистые одноразовые перчатки', matches: statementIncludes(/перчат/i) },
    {
      description: 'немедленная остановка по первой просьбе',
      matches: statementIncludes(/останов/i),
    },
  ],
};

/**
 * Правило 10 (Ограниченная подвижность) — два компонента: допустимая
 * альтернатива (не может дотянуться) и её собственное ограничение (запрет
 * твёрдого/острого приспособления). Подтверждено тем же прогоном, anchor
 * `aa2975a920553245`. Третий unit на этом anchor ("для ребёнка... взрослый")
 * НЕ входит — он не о подвижности, а делит блок по структуре документа, не
 * по смыслу (живой пример предупреждения задачи: "не считать одинаковый
 * sourceBlockAnchor доказательством одного логического правила").
 */
export const RULE_10_EVIDENCE_GROUP: RequiredEvidenceGroup = {
  ruleId: 10,
  description: 'Ограниченная подвижность: альтернативный способ + запрет твёрдого/острого приспособления',
  requiredClauses: [
    {
      description: 'альтернативный способ при невозможности дотянуться',
      matches: statementIncludes(/дотян/i),
    },
    {
      description: 'запрет твёрдого/острого приспособления даже при ограниченной подвижности',
      matches: statementIncludes(/твёрд.{0,20}остр|остр.{0,20}твёрд|твёрдым или острым/i),
    },
  ],
};
