import type { ExtractedKnowledgeUnit, ExtractionUncertainty } from './extraction';

/**
 * Проверяет `extractionRef`/`parentExtractionRef` каждого unit'а ОДНОГО ответа
 * модели (preflight C, translation-djc, независимое ревью).
 *
 * ЗАМЕНЯЕТ модель на `sourceSpan.anchor`. Anchor называет МЕСТО в документе,
 * не unit — при фрагментации ОДНОГО абзаца на несколько units (реальный
 * случай правила 4 фикстуры: родитель "Давление должно оставаться слабым" +
 * fragments "15 секунд"/"30 секунд"/"3 цикла") у ВСЕХ units один и тот же
 * anchor. Старая реализация либо считала это самоссылкой (`parentRuleRef ===
 * sourceSpan.anchor` истинно и для легального "родитель на этом же блоке", и
 * для настоящей ошибки "unit ссылается сам на себя"), либо (уровнем ниже, в
 * `identity-assignment.ts`) не могла разрешить >1 кандидата на анкоре и
 * оставляла ссылку неразрешённой. Anchor физически не говорит, КАКОЙ из
 * нескольких units на нём — родитель; специальное условие "если на блоке
 * несколько units, то не self-reference" не чинит это — оно всё равно не
 * знает, какой из нескольких кандидатов имелся в виду.
 *
 * `extractionRef` уникален по построению (проверяется здесь же, а не
 * понадеявшись на LLM) — ссылка на него однозначна независимо от того,
 * сколько units делят один `sourceSpan.anchor`.
 *
 * Ничего не теряется молча: сломанная ссылка (не существует / самоссылка /
 * цикл) или задвоенный `extractionRef` не отбрасывает unit — он остаётся на
 * месте (для ручного ревью F), к нему добавляется явная uncertainty.
 */
export function validateParentRefs(
  units: readonly ExtractedKnowledgeUnit[]
): ExtractedKnowledgeUnit[] {
  const withDuplicateFlag = flagDuplicateExtractionRefs(units);
  const knownRefs = new Set(units.map((u) => u.extractionRef));

  return withDuplicateFlag.map((u) => {
    if (u.parentExtractionRef === null) return u;

    if (u.parentExtractionRef === u.extractionRef) {
      return withDanglingParentUncertainty(
        u,
        `parentExtractionRef "${u.parentExtractionRef}" совпадает с собственным extractionRef unit'а — правило не может быть родителем самого себя`
      );
    }

    if (!knownRefs.has(u.parentExtractionRef)) {
      return withDanglingParentUncertainty(
        u,
        `parentExtractionRef "${u.parentExtractionRef}" не разрешился ни в один extractionRef этого же ответа модели`
      );
    }

    if (participatesInCycle(u.extractionRef, withDuplicateFlag)) {
      return withDanglingParentUncertainty(
        u,
        `цепочка parentExtractionRef, начатая unit'ом "${u.extractionRef}", возвращается сама к себе — цикл среди родительских ссылок`
      );
    }

    return u;
  });
}

function flagDuplicateExtractionRefs(
  units: readonly ExtractedKnowledgeUnit[]
): ExtractedKnowledgeUnit[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const u of units) {
    if (seen.has(u.extractionRef)) duplicated.add(u.extractionRef);
    seen.add(u.extractionRef);
  }

  if (duplicated.size === 0) return units.slice();

  return units.map((u) => {
    if (!duplicated.has(u.extractionRef)) return u;
    const uncertainty: ExtractionUncertainty = {
      kind: 'DUPLICATE_EXTRACTION_REF',
      description: `extractionRef "${u.extractionRef}" встречается у нескольких unit'ов этого ответа модели — идентификатор обязан быть уникальным`,
      quote: u.sourceSpan.quote,
    };
    return { ...u, uncertainties: [...u.uncertainties, uncertainty] };
  });
}

function withDanglingParentUncertainty(
  unit: ExtractedKnowledgeUnit,
  description: string
): ExtractedKnowledgeUnit {
  const uncertainty: ExtractionUncertainty = {
    kind: 'DANGLING_PARENT_REF',
    description,
    quote: unit.sourceSpan.quote,
  };
  return { ...unit, uncertainties: [...unit.uncertainties, uncertainty] };
}

/**
 * Идёт вверх по `parentExtractionRef`, начиная с `startRef`, пока не упрётся
 * в `null` (нормальный конец цепочки) или в ссылку, не резолвящуюся ни в один
 * известный unit (другая ветка уже об этом сообщает отдельно) — либо не
 * встретит `extractionRef`, который уже посетил в ЭТОМ же обходе: это и есть
 * цикл.
 */
function participatesInCycle(
  startRef: string,
  units: readonly ExtractedKnowledgeUnit[]
): boolean {
  const byExtractionRef = new Map(units.map((u) => [u.extractionRef, u] as const));
  const visited = new Set<string>();
  let current: string | null = startRef;

  while (current !== null) {
    if (visited.has(current)) return true;
    visited.add(current);
    const unit = byExtractionRef.get(current);
    if (unit === undefined) return false;
    current = unit.parentExtractionRef;
  }
  return false;
}
