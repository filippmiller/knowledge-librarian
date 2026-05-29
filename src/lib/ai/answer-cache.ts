import type { EnhancedAnswerResult } from './enhanced-answering-engine';

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;
const SIMILARITY_THRESHOLD = 0.82;

type CacheEntry = {
  key: string;
  normalizedQuestion: string;
  terms: string[];
  result: EnhancedAnswerResult;
  expiresAt: number;
  createdAt: number;
};

const answerCache = new Map<string, CacheEntry>();

export function normalizeQuestionForCache(question: string): string {
  return question
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getAnswerCacheKey(question: string, clarificationAnswer?: string): string {
  const normalized = normalizeQuestionForCache(question);
  const clarification = clarificationAnswer ? normalizeQuestionForCache(clarificationAnswer) : '';
  return clarification ? `${normalized}|${clarification}` : normalized;
}

export function getCachedAnswer(
  question: string,
  clarificationAnswer?: string
): { result: EnhancedAnswerResult; cacheHit: 'exact' | 'similar' } | null {
  pruneExpired();

  const key = getAnswerCacheKey(question, clarificationAnswer);
  const exact = answerCache.get(key);
  if (exact && exact.expiresAt > Date.now()) {
    return { result: markCached(exact.result, 'exact'), cacheHit: 'exact' };
  }

  if (clarificationAnswer) return null;

  const normalizedQuestion = normalizeQuestionForCache(question);
  const terms = extractCacheTerms(normalizedQuestion);
  if (terms.length < 2) return null;

  let best: { entry: CacheEntry; score: number } | null = null;
  for (const entry of answerCache.values()) {
    if (entry.expiresAt <= Date.now()) continue;
    const score = termSimilarity(terms, entry.terms);
    if (score >= SIMILARITY_THRESHOLD && (!best || score > best.score)) {
      best = { entry, score };
    }
  }

  return best ? { result: markCached(best.entry.result, 'similar'), cacheHit: 'similar' } : null;
}

export function storeCachedAnswer(
  question: string,
  result: EnhancedAnswerResult,
  clarificationAnswer?: string,
  ttlMs: number = DEFAULT_TTL_MS
): boolean {
  if (!isCacheableAnswer(result)) return false;

  pruneExpired();
  const key = getAnswerCacheKey(question, clarificationAnswer);
  const normalizedQuestion = normalizeQuestionForCache(question);
  answerCache.set(key, {
    key,
    normalizedQuestion,
    terms: extractCacheTerms(normalizedQuestion),
    result,
    expiresAt: Date.now() + ttlMs,
    createdAt: Date.now(),
  });
  enforceMaxEntries();
  return true;
}

export function clearAnswerCache(): void {
  answerCache.clear();
}

function isCacheableAnswer(result: EnhancedAnswerResult): boolean {
  if (result.answerSource === 'general_ai' || result.requiresHumanReview) return false;
  if (result.needsClarification || result.clarificationQuestion || result.scenarioClarification) return false;
  if (result.confidenceLevel === 'low' || result.confidenceLevel === 'insufficient') return false;
  return result.confidence >= 0.5;
}

function markCached(result: EnhancedAnswerResult, cacheHit: 'exact' | 'similar'): EnhancedAnswerResult {
  return {
    ...result,
    debug: result.debug
      ? { ...result.debug, cacheHit } as EnhancedAnswerResult['debug'] & { cacheHit: 'exact' | 'similar' }
      : undefined,
  };
}

function extractCacheTerms(normalizedQuestion: string): string[] {
  const stopWords = new Set([
    'какие', 'какой', 'какая', 'какое', 'можешь', 'назови', 'назвать', 'мне', 'ты', 'что', 'это',
    'есть', 'про', 'для', 'или', 'где', 'как', 'нужно', 'надо', 'пожалуйста',
  ]);

  const terms = normalizedQuestion
    .split(' ')
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !stopWords.has(term))
    .map(stemCacheTerm);

  return [...new Set(terms)];
}

function stemCacheTerm(term: string): string {
  return term
    .replace(/(ами|ями|ого|ему|ими|ыми|ая|ое|ые|ий|ый|ой|ую|их|ых|ам|ям|ах|ях|ом|ем|ов|ев|а|я|ы|и|у|е)$/u, '');
}

function termSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const rightSet = new Set(right);
  const overlap = left.filter((term) => rightSet.has(term)).length;
  return overlap / Math.max(left.length, right.length);
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, entry] of answerCache) {
    if (entry.expiresAt <= now) answerCache.delete(key);
  }
}

function enforceMaxEntries(): void {
  if (answerCache.size <= MAX_CACHE_ENTRIES) return;
  const oldest = [...answerCache.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const entry of oldest.slice(0, answerCache.size - MAX_CACHE_ENTRIES)) {
    answerCache.delete(entry.key);
  }
}
