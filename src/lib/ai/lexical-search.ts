/**
 * Лексический поиск in-memory (PR G, план §3) — тот же подход, что
 * `searchByKeywords`/`searchByKeywordTerms` (vector-search.ts), но без SQL:
 * тот путь Prisma-bound над `DocChunk`, из in-memory JSONL-пути невызываем.
 * Токенизация намеренно та же (нижний регистр, слова короче 3 символов
 * отброшены) — не второй способ решить, что считать словом.
 */

export interface LexicalCandidate {
  readonly id: string;
  readonly text: string;
}

export interface LexicalMatch {
  readonly id: string;
  readonly score: number;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\wа-яё\s]/gi, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

export function searchLexical(
  query: string,
  candidates: readonly LexicalCandidate[]
): LexicalMatch[] {
  const queryTerms = new Set(tokenize(query));
  if (queryTerms.size === 0) return [];

  const matches: LexicalMatch[] = [];
  for (const candidate of candidates) {
    const candidateTerms = tokenize(candidate.text);
    const overlap = candidateTerms.filter((t) => queryTerms.has(t)).length;
    if (overlap > 0) matches.push({ id: candidate.id, score: overlap });
  }
  return matches.sort((a, b) => b.score - a.score);
}
