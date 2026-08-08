import type { ExtractedKnowledgeUnit, ExtractionUncertainty } from './extraction';

/**
 * Проверяет `extractionRef`/`parentExtractionRef` каждого unit'а ОДНОГО ответа
 * модели (preflight C, translation-djc; P0-фикс независимого ревью PR #76,
 * translation-rbj).
 *
 * ЗАМЕНЯЕТ модель на `sourceSpan.anchor`. Anchor называет МЕСТО в документе,
 * не unit — при фрагментации ОДНОГО абзаца на несколько units (реальный
 * случай правила 4 фикстуры: родитель "Давление должно оставаться слабым" +
 * fragments "15 секунд"/"30 секунд"/"3 цикла") у ВСЕХ units один и тот же
 * anchor. Старая реализация либо считала это самоссылкой, либо не могла
 * разрешить >1 кандидата на анкоре. `extractionRef` уникален по построению
 * (проверяется здесь же) — ссылка на него однозначна независимо от того,
 * сколько units делят один `sourceSpan.anchor`.
 *
 * КОНТРАКТ (translation-rbj): невалидная ссылка — self-reference, цикл,
 * несуществующий extractionRef, ИЛИ ссылка на ЗАДВОЕННЫЙ extractionRef —
 * `parentExtractionRef` этого unit'а ОБНУЛЯЕТСЯ, сырое значение остаётся
 * видимым ТОЛЬКО в `description` добавленной uncertainty. Раньше поле
 * сохраняло сырое значение "для ручного ревью", но это позволяло
 * downstream-коду (`assignIdentity`) прочитать невалидную ссылку как
 * настоящую БЕЗ повторной проверки: `identity-assignment.ts` строил
 * `Map(extractionRef -> unitId)`, где задвоенный `extractionRef`
 * схлопывался last-write-wins, и child получал ПРОИЗВОЛЬНОГО
 * (порядко-зависимого) родителя; self/cycle-ссылки резолвились в
 * persisted `parentRuleRef`, указывающий сам на себя или образующий цикл,
 * хотя эта функция уже объявила связь недействительной. Обнуление здесь —
 * ЕДИНСТВЕННОЕ место, где решается валидность связи; downstream-код читает
 * `parentExtractionRef` типа `string | null` и не обязан заново знать про
 * uncertainties, чтобы не унаследовать сломанную связь.
 *
 * Ничего не теряется молча: обнулённое значение не значит потерянное —
 * unit остаётся на месте (для ручного ревью F) с явной uncertainty,
 * несущей сырую ссылку в тексте.
 */
export function validateParentRefs(
  units: readonly ExtractedKnowledgeUnit[]
): ExtractedKnowledgeUnit[] {
  const duplicated = findDuplicateExtractionRefs(units);
  const withDuplicateFlag = flagDuplicateExtractionRefs(units, duplicated);
  const knownRefs = new Set(units.map((u) => u.extractionRef));

  return withDuplicateFlag.map((u) => {
    if (u.parentExtractionRef === null) return u;

    if (u.parentExtractionRef === u.extractionRef) {
      return withDanglingParentUncertainty(
        u,
        `parentExtractionRef "${u.parentExtractionRef}" совпадает с собственным extractionRef unit'а — правило не может быть родителем самого себя`
      );
    }

    if (duplicated.has(u.parentExtractionRef)) {
      return withDanglingParentUncertainty(
        u,
        `parentExtractionRef "${u.parentExtractionRef}" указывает на extractionRef, задвоенный у нескольких unit'ов этого ответа — неоднозначно, какой из них имелся в виду`
      );
    }

    if (!knownRefs.has(u.parentExtractionRef)) {
      return withDanglingParentUncertainty(
        u,
        `parentExtractionRef "${u.parentExtractionRef}" не разрешился ни в один extractionRef этого же ответа модели`
      );
    }

    if (participatesInCycle(u.extractionRef, withDuplicateFlag, duplicated)) {
      return withDanglingParentUncertainty(
        u,
        `цепочка parentExtractionRef, начатая unit'ом "${u.extractionRef}", возвращается сама к себе — цикл среди родительских ссылок`
      );
    }

    return u;
  });
}

function findDuplicateExtractionRefs(units: readonly ExtractedKnowledgeUnit[]): ReadonlySet<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const u of units) {
    if (seen.has(u.extractionRef)) duplicated.add(u.extractionRef);
    seen.add(u.extractionRef);
  }
  return duplicated;
}

function flagDuplicateExtractionRefs(
  units: readonly ExtractedKnowledgeUnit[],
  duplicated: ReadonlySet<string>
): ExtractedKnowledgeUnit[] {
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

/**
 * Обнуляет `parentExtractionRef` (не только добавляет uncertainty) — см.
 * контракт в докстринге модуля: поле типа `string | null` обязано быть
 * ПРАВДОЙ для любого потребителя, не требовать параллельной проверки
 * uncertainties, чтобы не унаследовать невалидную связь.
 */
function withDanglingParentUncertainty(
  unit: ExtractedKnowledgeUnit,
  description: string
): ExtractedKnowledgeUnit {
  const uncertainty: ExtractionUncertainty = {
    kind: 'DANGLING_PARENT_REF',
    description,
    quote: unit.sourceSpan.quote,
  };
  return { ...unit, parentExtractionRef: null, uncertainties: [...unit.uncertainties, uncertainty] };
}

/**
 * Идёт вверх по `parentExtractionRef`, начиная с `startRef`, пока не упрётся
 * в `null` (нормальный конец цепочки) или в ссылку, не резолвящуюся ни в один
 * известный unit (другая ветка уже об этом сообщает отдельно) — либо не
 * встретит `extractionRef`, который уже посетил в ЭТОМ же обходе: это и есть
 * цикл.
 *
 * Останавливается (не цикл), если по пути встречает ЗАДВОЕННЫЙ `extractionRef`
 * — не только на СТАРТЕ (это уже отфильтровано отдельной веткой в
 * `validateParentRefs`), но и НА ЛЮБОМ шаге цепочки: `units` здесь — ещё не
 * обнулённый снимок ЭТОГО же прохода (`validateParentRefs` строит все решения
 * за один `.map()` по одному и тому же исходному массиву), поэтому промежуточный
 * задвоенный узел без этой проверки резолвился бы в ПРОИЗВОЛЬНОГО (порядко-
 * зависимого) кандидата — тот же класс бага, что и прямая duplicate-ссылка,
 * просто на один-два шага дальше по цепочке.
 */
function participatesInCycle(
  startRef: string,
  units: readonly ExtractedKnowledgeUnit[],
  duplicated: ReadonlySet<string>
): boolean {
  const byExtractionRef = new Map(units.map((u) => [u.extractionRef, u] as const));
  const visited = new Set<string>();
  let current: string | null = startRef;

  while (current !== null) {
    if (visited.has(current)) return true;
    visited.add(current);
    if (current !== startRef && duplicated.has(current)) return false;
    const unit = byExtractionRef.get(current);
    if (unit === undefined) return false;
    current = unit.parentExtractionRef;
  }
  return false;
}
