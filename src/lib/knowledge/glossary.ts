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
