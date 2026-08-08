import type { ExtractedKnowledgeUnit, ExtractionUncertainty } from './extraction';

/**
 * Разрешает `parentRuleRef` каждого unit'а на реальный якорь — либо якорь
 * исходного документа (переданный вызывающим до LLM), либо `sourceSpan.anchor`
 * другого unit'а ЭТОГО ЖЕ прогона извлечения (родитель мог сам оказаться
 * фрагментом без собственного анкера в исходном документе).
 *
 * Неразрешившаяся ссылка — ровно тот баг, что случился в реальном прогоне
 * (translation-2n9): "не более 3 дней" сослалось на несуществующий anchor и
 * связь с "раздражение кожи" потерялась молча. Здесь она не теряется:
 * `parentRuleRef` остаётся на месте (для ручного ревью F), а к unit'у
 * добавляется явная `DANGLING_PARENT_REF` uncertainty.
 *
 * Ссылка unit'а на СВОЙ ЖЕ `sourceSpan.anchor` — не родитель, а
 * самопротиворечие (правило не может быть фрагментом самого себя), и
 * считается неразрешившейся, даже если тот же anchor легален для ДРУГИХ
 * unit'ов этого прогона.
 */
export function validateParentRefs(
  units: readonly ExtractedKnowledgeUnit[],
  knownSourceAnchors: readonly string[]
): ExtractedKnowledgeUnit[] {
  const resolvable = new Set(knownSourceAnchors);
  for (const u of units) resolvable.add(u.sourceSpan.anchor);

  return units.map((u) => {
    if (u.parentRuleRef === null) return u;
    const isSelfReference = u.parentRuleRef === u.sourceSpan.anchor;
    if (!isSelfReference && resolvable.has(u.parentRuleRef)) return u;

    const description = isSelfReference
      ? `parentRuleRef "${u.parentRuleRef}" совпадает с собственным sourceSpan.anchor unit'а — правило не может быть родителем самого себя`
      : `parentRuleRef "${u.parentRuleRef}" не разрешился ни в якорь документа, ни в sourceSpan другого unit'а этого прогона`;
    const uncertainty: ExtractionUncertainty = {
      kind: 'DANGLING_PARENT_REF',
      description,
      quote: u.sourceSpan.quote,
    };
    return { ...u, uncertainties: [...u.uncertainties, uncertainty] };
  });
}
