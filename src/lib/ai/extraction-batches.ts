export interface ExtractionBatch {
  index: number;
  total: number;
  startLine: number;
  endLine: number;
  text: string;
  numberedText: string;
}

export interface RuleLike {
  ruleCode: string;
  title: string;
  body: string;
  sourceSpan?: {
    quote?: string;
    locationHint?: string;
  };
}

export interface QALike {
  linkedRuleCode: string | null;
}

const DEFAULT_BATCH_CHAR_LIMIT = 4200;
const DEFAULT_OVERLAP_LINES = 8;

export function buildExtractionBatches(
  documentText: string,
  options: { maxChars?: number; overlapLines?: number } = {}
): ExtractionBatch[] {
  const maxChars = options.maxChars ?? DEFAULT_BATCH_CHAR_LIMIT;
  const overlapLines = options.overlapLines ?? DEFAULT_OVERLAP_LINES;
  const lines = normalizeExtractionLines(documentText);

  if (lines.length === 0) {
    return [];
  }

  const batches: Omit<ExtractionBatch, 'total'>[] = [];
  let start = 0;

  while (start < lines.length) {
    let end = start;
    let charCount = 0;

    while (end < lines.length) {
      const nextLength = lines[end].length + 1;
      if (end > start && charCount + nextLength > maxChars) break;
      charCount += nextLength;
      end++;
    }

    const batchLines = lines.slice(start, end);
    batches.push({
      index: batches.length + 1,
      startLine: start + 1,
      endLine: end,
      text: batchLines.join('\n'),
      numberedText: batchLines
        .map((line, lineIndex) => `[L${String(start + lineIndex + 1).padStart(4, '0')}] ${line}`)
        .join('\n'),
    });

    if (end >= lines.length) break;
    start = Math.max(end - overlapLines, start + 1);
  }

  return batches.map((batch) => ({ ...batch, total: batches.length }));
}

export function dedupeAndRenumberRules<T extends RuleLike, Q extends QALike>(
  rules: T[],
  qaPairs: Q[],
  startCode: number
): { rules: T[]; qaPairs: Q[] } {
  const seen = new Map<string, T>();
  const oldToNewCode = new Map<string, string>();
  const deduped: T[] = [];

  for (const rule of rules) {
    const signature = ruleSignature(rule);
    const existing = seen.get(signature);
    if (existing) {
      oldToNewCode.set(rule.ruleCode, existing.ruleCode);
      continue;
    }

    const newCode = `R-${startCode + deduped.length}`;
    oldToNewCode.set(rule.ruleCode, newCode);
    const renumbered = { ...rule, ruleCode: newCode };
    seen.set(signature, renumbered);
    deduped.push(renumbered);
  }

  const updatedQaPairs = qaPairs.map((qa) => ({
    ...qa,
    linkedRuleCode: qa.linkedRuleCode ? oldToNewCode.get(qa.linkedRuleCode) ?? qa.linkedRuleCode : null,
  }));

  return { rules: deduped, qaPairs: updatedQaPairs };
}

function normalizeExtractionLines(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .flatMap(splitDenseLine)
    .filter((line) => line.length > 0);
}

function splitDenseLine(line: string): string[] {
  if (line.length <= 240) return [line];

  const withBreaks = line
    .replace(/([.:;!?])(?=\p{Lu})/gu, '$1\n')
    .replace(/([а-яё])(?=[А-ЯЁ][а-яё])/gu, '$1\n')
    .replace(/(\))(?=\p{Lu})/gu, '$1\n')
    .replace(/((?:^|\s)\d{1,2}\. [^0-9\n]{3,80}?)(?=\s\d{1,2}\. )/gu, '$1\n');

  const parts = withBreaks
    .split('\n')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length > 1) return parts.flatMap(splitLongSentence);
  return splitLongSentence(line);
}

function splitLongSentence(line: string): string[] {
  if (line.length <= 420) return [line];

  const parts = line
    .split(/(?<=[.!?;])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length > 1) return parts;

  const chunks: string[] = [];
  let remaining = line;
  while (remaining.length > 420) {
    const splitAt = remaining.lastIndexOf(' ', 420);
    const index = splitAt > 160 ? splitAt : 420;
    chunks.push(remaining.slice(0, index).trim());
    remaining = remaining.slice(index).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function ruleSignature(rule: RuleLike): string {
  const quote = rule.sourceSpan?.quote ?? '';
  return normalizeForSignature(`${rule.title} ${rule.body} ${quote}`).slice(0, 500);
}

function normalizeForSignature(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/r-\d+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
