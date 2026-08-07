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
}

export interface EvidencePack {
  /** Порядок повторяет `resolution.selected` — артефакт прогона детерминирован. */
  readonly items: readonly EvidenceItem[];
  /** Числа, которые ответу РАЗРЕШЕНО называть. Всё прочее — невыводимое утверждение. */
  readonly numericFacts: readonly NumericConstraint[];
}

export function buildEvidencePack(
  units: readonly PersistedKnowledgeUnit[],
  resolution: ResolutionDecision
): EvidencePack {
  if (resolution.disposition !== 'ANSWER') {
    throw new Error(
      `buildEvidencePack: disposition=${resolution.disposition} — синтез возможен только при ANSWER. ` +
        'CLARIFY означает «спросить», HOLD — «отдать человеку»; ни то, ни другое не отвечается набором evidence.'
    );
  }

  if (resolution.selected.length === 0) {
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

  const items: EvidenceItem[] = [];
  for (const unitId of resolution.selected) {
    const unit = byUnitId.get(unitId);
    if (unit === undefined) {
      throw new Error(
        `buildEvidencePack: выбранный unit «${unitId}» отсутствует среди переданных — ` +
          'синтез на молча уменьшившемся наборе evidence недопустим'
      );
    }
    items.push({
      unitId: unit.unitId,
      kind: unit.kind,
      statement: unit.statement,
      citation: unit.sourceSpan,
      numericConstraint: unit.numericConstraint,
    });
  }

  const numericFacts = items
    .map((item) => item.numericConstraint)
    .filter((constraint): constraint is NumericConstraint => constraint !== null);

  return { items, numericFacts };
}
