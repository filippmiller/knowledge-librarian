// Bureau abbreviation/synonym glossary — single source of truth.
//
// Used to EXPAND abbreviations before scenario classification and retrieval so
// the engine sees the canonical term instead of guessing. This replaces brittle
// per-abbreviation regexes (e.g. СО[РБС]) with data: add a line here, every
// consumer benefits. The expansion is APPENDED (original text is kept) so
// keyword search still matches the literal abbreviation too.
//
// Domain owner: extend this list as the bureau's shorthand grows. `abbr` is
// matched as a whole word, case-insensitively.

export interface GlossaryEntry {
  abbr: string;
  canonical: string;
}

export const GLOSSARY: GlossaryEntry[] = [
  { abbr: 'СОР', canonical: 'свидетельство о рождении' },
  { abbr: 'СОБ', canonical: 'свидетельство о браке' },
  { abbr: 'СОС', canonical: 'свидетельство о смерти' },
  { abbr: 'СОН', canonical: 'справка об отсутствии судимости' },
  { abbr: 'КЗАГС', canonical: 'Комитет по делам ЗАГС Санкт-Петербурга' },
  { abbr: 'НКО', canonical: 'нотариальная копия' },
  { abbr: 'НЗК', canonical: 'нотариально заверенная копия' },
  { abbr: 'МЮ', canonical: 'Министерство юстиции' },
  { abbr: 'КЛ', canonical: 'консульская легализация' },
  { abbr: 'ЛО', canonical: 'Ленинградская область' },
];

// Short tokens (<5 chars) that are domain-CRITICAL and must NOT be dropped from
// the keyword prefilter. These acronyms (an authority or document type) are the
// MOST discriminating terms — exactly what pinpoints the one right rule. The
// retrieval prefilter otherwise keeps only terms length>=5, which silently
// discards them: e.g. "МВД" is dropped, so the single rule "Апостиль на
// документы МВД в городе выдачи" never enters the candidate pool (it loses the
// top-N-by-confidence race against hundreds of generic "апостиль/документ"
// matches). Normalized to match extractSearchTerms output: lowercase, ё→е.
// Derived from the glossary abbreviations + standalone acronyms that need no
// canonical expansion.
export const SIGNIFICANT_SHORT_TERMS: ReadonlySet<string> = new Set<string>([
  ...GLOSSARY.map((g) => g.abbr.toLowerCase().replace(/ё/g, 'е')),
  'мвд', 'загс', 'мфц', 'вуз', 'дпо', 'упд', 'эдо', 'опек', 'апостил',
]);

/**
 * Pick the significant terms for the keyword prefilter from a raw term list.
 * Keeps a term if it is long enough to be specific (>=5 chars) OR is a known
 * domain-critical short acronym (see SIGNIFICANT_SHORT_TERMS). Generic short
 * words ("для", "как", "что") are still dropped. Caps the result so a single
 * query can't fan out into too many per-term DB fetches.
 */
export function selectKeyTerms(terms: string[], cap = 12): string[] {
  return [...new Set(terms)]
    .filter((t) => t.length >= 5 || SIGNIFICANT_SHORT_TERMS.has(t))
    .slice(0, cap);
}

// Non-letter/digit boundary that is aware of both Cyrillic and Latin so "СОР"
// matches as a word but "СОРТ"/"договор" do not.
const BOUNDARY = '[^а-яёА-ЯЁa-zA-Z0-9]';

/**
 * Append the canonical expansion for every glossary abbreviation that appears
 * as a whole word in `text`. Each expansion is added at most once. The original
 * text is preserved (expansions are appended), so downstream keyword/semantic
 * search still sees the literal abbreviation.
 *
 * Example: "как апостилировать СОР в спб"
 *       → "как апостилировать СОР в спб (свидетельство о рождении)"
 */
export function expandAbbreviations(text: string): string {
  if (!text) return text;
  const additions: string[] = [];
  for (const { abbr, canonical } of GLOSSARY) {
    const re = new RegExp(`(^|${BOUNDARY})${abbr}(?=${BOUNDARY}|$)`, 'iu');
    if (re.test(text)) additions.push(canonical);
  }
  return additions.length > 0 ? `${text} (${additions.join('; ')})` : text;
}
