// Quality gate for knowledge extracted from uploaded documents.
//
// Runs BEFORE rules are committed to the knowledge base. Catches the two failure
// modes that historically polluted the KB:
//   1. Hallucinated specifics — a rule asserts a number/price/phone/address that
//      does NOT appear in its own source quote (the model invented it).
//   2. Junk content — placeholders, empty/degenerate bodies, marketing filler.
//
// Non-blocking by design: returns warnings the caller surfaces to the admin and
// logs. The admin still decides; we never silently drop their content. The point
// is VISIBILITY at ingest time, so bad extractions are caught at the source
// instead of surfacing as wrong answers weeks later.

export interface LintInput {
  ruleCode: string;
  title: string;
  body: string;
  /** The verbatim source text the rule was extracted from. */
  sourceQuote: string;
}

export interface LintWarning {
  ruleCode: string;
  kind: 'hallucinated_fact' | 'placeholder' | 'too_short' | 'too_long' | 'filler';
  detail: string;
}

const PLACEHOLDER = /\b(lorem ipsum|todo|tbd|placeholder|xxxx+|\.\.\.\.\.+|пример текста|заполнить)\b/i;

// Generic marketing/atmospheric filler that has no place in an operational rule.
// Russian tails use [а-яё]*, NOT \w* — JS \w is ASCII-only, so "волшебная" /
// "восхитительное" / "уютной атмосфере" would slip past a \w pattern.
const FILLER = /(незабываем|атмосфер[ауеоы]|погрузитесь|уютн[а-яё]*\s+атмосфер|тёплая\s+атмосфер|волшебн[а-яё]*|восхитительн[а-яё]*)/i;

const MIN_BODY = 12;     // chars — shorter than this carries no operational content
const MAX_BODY = 4000;   // chars — a single rule this long is really many rules

/** Extract "hard" facts (numbers, prices, phones) that must be traceable to the source.
 *
 * Implementation note: we do NOT strip spaces before running the regex. The old approach
 * of `text.replace(/\s+/g, '')` concatenated adjacent numbers ("630 1540" → "6301540"),
 * turning each individual price into a "hallucinated" fact because the composite string
 * never matched the extracted number. Instead we normalise thin/non-breaking thousand-
 * separator spaces (e.g. "1 540 руб" → "1540") using a targeted replacement that only
 * collapses a single space between digit groups of 1–3 digits.
 */
function hardFacts(text: string): string[] {
  // Collapse thousand-separator spaces: "1 540" → "1540", but "630 1540" stays "630 1540"
  const norm = text.replace(/(\d{1,3})\s(\d{3})\b/g, '$1$2');
  const facts: string[] = [];
  // Standalone numbers of 3+ digits (prices, postal codes, fees, building nums)
  for (const m of norm.matchAll(/\b\d{3,}\b/g)) facts.push(m[0]);
  return [...new Set(facts)];
}

/**
 * Lint one extracted rule against its source. Returns 0+ warnings.
 * The anti-hallucination check compares digit-runs (>=3 digits) in the rule body
 * to those in the source quote: a 3+ digit number in the body that is absent from
 * the source is very likely invented (e.g. a price or phone the model guessed).
 */
export function lintRule(input: LintInput): LintWarning[] {
  const warnings: LintWarning[] = [];
  const body = (input.body ?? '').trim();
  const code = input.ruleCode;

  if (body.length < MIN_BODY) {
    warnings.push({ ruleCode: code, kind: 'too_short', detail: `body is ${body.length} chars` });
  }
  if (body.length > MAX_BODY) {
    warnings.push({ ruleCode: code, kind: 'too_long', detail: `body is ${body.length} chars — likely several rules` });
  }
  if (PLACEHOLDER.test(body)) {
    warnings.push({ ruleCode: code, kind: 'placeholder', detail: 'contains placeholder text' });
  }
  if (FILLER.test(body)) {
    warnings.push({ ruleCode: code, kind: 'filler', detail: 'contains marketing/atmospheric filler' });
  }

  const sourceFacts = new Set(hardFacts(input.sourceQuote ?? ''));
  for (const fact of hardFacts(body)) {
    if (!sourceFacts.has(fact)) {
      warnings.push({
        ruleCode: code,
        kind: 'hallucinated_fact',
        detail: `number "${fact}" is in the rule but not in its source quote`,
      });
    }
  }

  return warnings;
}

/** Lint a batch; returns a flat list of warnings across all rules. */
export function lintRules(inputs: LintInput[]): LintWarning[] {
  return inputs.flatMap(lintRule);
}
