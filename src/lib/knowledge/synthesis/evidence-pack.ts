/**
 * Evidence pack — граница видимости синтезатора (план §3 PR H, Beads
 * translation-yz9).
 *
 * Правила плана здесь ОБЯЗАТЕЛЬНЫЕ, не рекомендации:
 * «генератор получает ТОЛЬКО selected reviewed units — не сырые чанки, не
 * результаты поиска до applicability-фильтрации»; «citations строятся из source
 * anchors (PR F), не из порядкового номера кандидата».
 *
 * Поэтому pack собирается ОТ `resolution.selected`, а не от переданного списка
 * unit'ов: даже если вызывающий код передаст весь пул кандидатов, в pack попадёт
 * только выбранное. Отфильтровать лишнее — задача этой функции, а не дисциплины
 * вызывающего.
 *
 * Всякое расхождение — исключение, а не тихая деградация: ответ, построенный на
 * молча уменьшившемся наборе evidence, выглядит как обычный ответ и провалит
 * прогон необъяснимо.
 */

import type { KnowledgeUnitKind } from '../applicability/kinds';
import type { PersistedKnowledgeUnit } from '../applicability/identity-assignment';
import type { NumericConstraint, ResolutionDecision } from '../applicability/resolution';
import type { SourceSpan } from '../applicability/extraction';

export interface EvidenceItem {
  readonly unitId: string;
  readonly kind: KnowledgeUnitKind;
  readonly statement: string;
  /** Source anchor из PR F — основание цитаты. Не порядковый номер кандидата. */
  readonly citation: SourceSpan;
  readonly numericConstraint: NumericConstraint | null;
  readonly presentationConditions?: readonly string[];
  /** CONDITIONAL must retain its condition; NEGATIVE proves the condition is
   * false and may support only a denial, never a permission. */
  readonly applicabilityMode?: 'NORMAL' | 'CONDITIONAL' | 'NEGATIVE';
  /**
   * Why an earlier stage (the decision-relevance classifier) judged this
   * unit relevant to the question — e.g. "Описывает прямые действия после
   * завершения процедуры". THIS IS NOT EVIDENCE: not source text, not a
   * quote, not something `citedUnitIds` may point at. It exists purely so
   * synthesis does not have to re-derive, with less context, a bridging
   * judgement an earlier stage already made and explained. Optional and
   * absent by default — callers that do not pass a rationale map to
   * `buildEvidencePack` get the previous behavior unchanged.
   */
  readonly relevanceRationale?: string;
}

/** An overridden rule is visible only as explanatory/procedural context.  It
 * is deliberately kept outside `items`, whose members remain the operative
 * resolution selected by the deterministic resolver. */
export interface OverriddenParentContext {
  readonly role: 'OVERRIDDEN_PARENT_CONTEXT';
  readonly unitId: string;
  readonly kind: KnowledgeUnitKind;
  readonly statement: string;
  readonly citation: SourceSpan;
  readonly numericConstraint: NumericConstraint | null;
  readonly overriddenByUnitId: string;
}

export interface EvidencePack {
  /** Порядок повторяет `resolution.selected` — артефакт прогона детерминирован. */
  readonly items: readonly EvidenceItem[];
  /** Direct parents overridden by a currently-operative exception. */
  readonly supportingContext?: readonly OverriddenParentContext[];
  /** Числа, которые ответу РАЗРЕШЕНО называть. Всё прочее — невыводимое утверждение. */
  readonly numericFacts: readonly NumericConstraint[];
}

export function overriddenParentContextBehaviorProbe(): unknown {
  return {
    version: '2026-08-11-overridden-parent-context-v1',
    role: 'OVERRIDDEN_PARENT_CONTEXT',
    inclusion: 'direct parent whose overriding EXCEPTION_RULE is selected',
    precedence: 'selected child always wins; parent remains non-operative',
    numericFacts: 'operative evidence only',
  };
}

export function buildEvidencePack(
  units: readonly PersistedKnowledgeUnit[],
  resolution: ResolutionDecision,
  /**
   * Optional unitId -> upstream decision-relevance rationale. When present,
   * each matching evidence item carries it as `relevanceRationale` (see that
   * field's docstring for what it is and is not). Absent unitIds simply get
   * no rationale — this is additive, not a new requirement.
   */
  relevanceRationaleByUnitId?: ReadonlyMap<string, string>
): EvidencePack {
  if (resolution.disposition !== 'ANSWER') {
    throw new Error(
      `buildEvidencePack: disposition=${resolution.disposition} — синтез возможен только при ANSWER. ` +
        'CLARIFY означает «спросить», HOLD — «отдать человеку»; ни то, ни другое не отвечается набором evidence.'
    );
  }

  if (resolution.selected.length === 0 && (resolution.negativeEvidence?.length ?? 0) === 0) {
    throw new Error(
      'buildEvidencePack: набор выбранных unit-ов пуст — ответ без evidence запрещён (план §3 PR H)'
    );
  }

  const byUnitId = new Map<string, PersistedKnowledgeUnit>();
  for (const unit of units) {
    if (byUnitId.has(unit.unitId)) {
      throw new Error(
        `buildEvidencePack: unitId «${unit.unitId}» встречается дважды — неоднозначно, чью цитату брать`
      );
    }
    byUnitId.set(unit.unitId, unit);
  }


  const selectedIds = new Set(resolution.selected);
  const negativeIds = new Set(resolution.negativeEvidence ?? []);
  const seenOverriddenParents = new Set<string>();
  const seenEdges = new Set<string>();
  const supportingContext: OverriddenParentContext[] = [];
  for (const edge of resolution.overridden) {
    const edgeKey = `${edge.unitId}\u0000${edge.byUnitId}`;
    if (seenEdges.has(edgeKey)) {
      throw new Error(`buildEvidencePack: duplicate overridden edge ${edge.unitId} -> ${edge.byUnitId}`);
    }
    seenEdges.add(edgeKey);
    const parent = byUnitId.get(edge.unitId);
    const child = byUnitId.get(edge.byUnitId);
    if (parent === undefined || child === undefined) {
      throw new Error(
        `buildEvidencePack: overridden edge ${edge.unitId} -> ${edge.byUnitId} references a missing unit`
      );
    }
    if (child.kind !== 'EXCEPTION_RULE' || child.parentRuleRef !== parent.unitId) {
      throw new Error(
        `buildEvidencePack: fabricated overridden edge ${edge.unitId} -> ${edge.byUnitId}; ` +
          'the child must be an EXCEPTION_RULE whose direct parentRuleRef is the parent'
      );
    }
    if (selectedIds.has(parent.unitId) || negativeIds.has(parent.unitId)) {
      throw new Error(
        `buildEvidencePack: overridden parent ${parent.unitId} is also operative evidence`
      );
    }
    // Only a parent overridden by a child that survived resolution is useful
    // context.  This intentionally excludes a grandparent whose overrider was
    // itself overridden by a later exception.
    if (!selectedIds.has(child.unitId)) continue;
    if (seenOverriddenParents.has(parent.unitId)) {
      throw new Error(`buildEvidencePack: overridden parent ${parent.unitId} has multiple operative overriders`);
    }
    if (
      parent.numericConstraint !== null &&
      child.numericConstraint !== null &&
      parent.numericConstraint.factKey === child.numericConstraint.factKey &&
      (parent.numericConstraint.value !== child.numericConstraint.value ||
        parent.numericConstraint.unit !== child.numericConstraint.unit)
    ) {
      throw new Error(
        `buildEvidencePack: overridden parent ${parent.unitId} conflicts with operative child ${child.unitId} ` +
          `for numeric fact ${child.numericConstraint.factKey}; selected-child precedence forbids exposing both values`
      );
    }
    seenOverriddenParents.add(parent.unitId);
    supportingContext.push({
      role: 'OVERRIDDEN_PARENT_CONTEXT',
      unitId: parent.unitId,
      kind: parent.kind,
      statement: parent.statement,
      citation: parent.sourceSpan,
      numericConstraint: parent.numericConstraint,
      overriddenByUnitId: child.unitId,
    });
  }

  const items: EvidenceItem[] = [];
  const applicabilityByUnitId = new Map(
    (resolution.selectedApplicability ?? []).map((entry) => [entry.unitId, entry])
  );
  for (const unitId of [...resolution.selected, ...(resolution.negativeEvidence ?? [])]) {
    const unit = byUnitId.get(unitId);
    if (unit === undefined) {
      throw new Error(
        `buildEvidencePack: выбранный unit «${unitId}» отсутствует среди переданных — ` +
          'синтез на молча уменьшившемся наборе evidence недопустим'
      );
    }
    const applicability = applicabilityByUnitId.get(unitId);
    const uncertaintyConditions = unit.uncertainties
      .filter((uncertainty) => uncertainty.kind === 'UNRECOGNIZED_TRIGGER_CONDITION')
      .map((uncertainty) => uncertainty.quote);
    items.push({
      unitId: unit.unitId,
      kind: unit.kind,
      statement: unit.statement,
      citation: unit.sourceSpan,
      numericConstraint: unit.numericConstraint,
      presentationConditions: [...new Set([
        ...uncertaintyConditions,
        ...(applicability?.presentationConditions ?? []),
      ])],
      applicabilityMode: applicability?.mode ?? 'NORMAL',
      relevanceRationale: relevanceRationaleByUnitId?.get(unitId),
    });
  }

  const numericFacts = items
    .filter((item) => item.applicabilityMode !== 'NEGATIVE')
    .map((item) => item.numericConstraint)
    .filter((constraint): constraint is NumericConstraint => constraint !== null);

  return { items, supportingContext, numericFacts };
}
