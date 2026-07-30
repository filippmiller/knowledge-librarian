import type { EnhancedAnswerResult } from './enhanced-answering-engine';
import type { Audience } from '@/lib/knowledge/audience';

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

/**
 * НЕЧЁТКОЕ СОВПАДЕНИЕ УДАЛЕНО НАМЕРЕННО. Оно отдавало ответ на противоположный
 * вопрос.
 *
 * Ключ строился из термов длиной от трёх символов. Русские служебные слова,
 * переворачивающие смысл, короче: «не», «с», «на». Они отбрасывались, после чего
 * пары вопросов схлопывались в одинаковый набор термов и давали similarity 1.0
 * при пороге 0.82:
 *
 *   «Нужен ли оригинал для заверения?»    ←→ «Не нужен ли оригинал…?»
 *   «Можно ли апостилировать в СПб?»      ←→ «Можно ли не апостилировать…?»
 *   «Перевод С английского»               ←→ «Перевод НА английский»
 *
 * Последняя пара — разные тарифные колонки, то есть разные деньги. Порог тут
 * ни при чём: метрика по пересечению термов в принципе не различает утверждение
 * и его отрицание. Воспроизведено запуском, см. scripts/audit-verify-codex-claims.ts.
 *
 * Восстанавливать нечёткий проход можно только на эмбеддингах и только с
 * отдельной проверкой полярности вопроса.
 */

type CacheEntry = {
  key: string;
  /** Кому предназначен закэшированный ответ. Внутренний ответ содержит факты,
   *  недопустимые для клиента, поэтому пересекать аудитории нельзя. */
  audience: Audience;
  normalizedQuestion: string;
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

export function getAnswerCacheKey(
  audience: Audience,
  question: string,
  clarificationAnswer?: string
): string {
  const normalized = normalizeQuestionForCache(question);
  const clarification = clarificationAnswer ? normalizeQuestionForCache(clarificationAnswer) : '';
  const base = clarification ? `${normalized}|${clarification}` : normalized;
  return `${audience}::${base}`;
}

export function getCachedAnswer(
  audience: Audience,
  question: string,
  clarificationAnswer?: string
): { result: EnhancedAnswerResult; cacheHit: 'exact' } | null {
  pruneExpired();

  const key = getAnswerCacheKey(audience, question, clarificationAnswer);
  const exact = answerCache.get(key);
  if (exact && exact.expiresAt > Date.now()) {
    return { result: markCached(exact.result, 'exact'), cacheHit: 'exact' };
  }

  return null;
}

export function storeCachedAnswer(
  audience: Audience,
  question: string,
  result: EnhancedAnswerResult,
  clarificationAnswer?: string,
  ttlMs: number = DEFAULT_TTL_MS
): boolean {
  if (!isCacheableAnswer(result)) return false;

  pruneExpired();
  const key = getAnswerCacheKey(audience, question, clarificationAnswer);
  const normalizedQuestion = normalizeQuestionForCache(question);
  answerCache.set(key, {
    key,
    audience,
    normalizedQuestion,
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

function markCached(result: EnhancedAnswerResult, cacheHit: 'exact'): EnhancedAnswerResult {
  return {
    ...result,
    debug: result.debug
      ? { ...result.debug, cacheHit } as EnhancedAnswerResult['debug'] & { cacheHit: 'exact' }
      : undefined,
  };
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
