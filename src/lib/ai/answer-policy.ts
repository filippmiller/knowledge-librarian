// Pure answer/clarification/draft policy predicates.
//
// Deliberately ZERO runtime imports (only a type-only import that erases at
// build time) so this logic is cheap to unit-test in isolation and is the single
// source of truth for three decisions that were previously inlined and drifted:
//   - isClarificationTurn   — should a turn escalate to a human? (no, if it's a clarification)
//   - looksLikeClarificationReply — is typed text an answer to a pending clarification?
//   - isDraftableDraft      — is a Q→A worth capturing as a draft rule?

import type { EnhancedAnswerResult } from './enhanced-answering-engine';

/**
 * A clarification turn (scenario buttons / "уточните регион") is the bot working
 * exactly as designed — it asked the user a question instead of guessing. It is
 * NOT a failed answer and must never escalate to a human, otherwise every
 * healthy clarification spams the super-admin with "Требуется проверка ответа ИИ".
 */
export function isClarificationTurn(
  result: Pick<
    EnhancedAnswerResult,
    'scenarioClarification' | 'needsClarification' | 'clarificationQuestion'
  >
): boolean {
  return Boolean(
    result.scenarioClarification || result.needsClarification || result.clarificationQuestion
  );
}

/**
 * Heuristic: does this free-text message look like an ANSWER to a pending
 * clarification, rather than a brand-new question? Users type "Москва" instead
 * of tapping the region button — that must merge into the original question, not
 * start over. But a user may also abandon the clarification and ask something
 * new ("а сколько стоит перевод?") — that must NOT merge.
 *
 * A reply looks like a clarification answer when it is short and is not itself a
 * question (no "?" and no interrogative word).
 */
// Interrogatives that mark a message as a NEW question, not a clarification
// reply. Matched by exact token (NOT a \b regex — JS word boundaries are
// ASCII-only and silently fail to anchor Cyrillic, the recurring \w/\b trap).
const INTERROGATIVES = new Set([
  'как', 'сколько', 'где', 'когда', 'можно', 'почему', 'что', 'какой', 'какая',
  'какое', 'какие', 'нужно', 'надо', 'зачем', 'каков', 'кто', 'куда', 'чем',
]);

export function looksLikeClarificationReply(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (t.includes('?')) return false; // it's a question itself
  const words = t.split(/[\s,.;:!]+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return false; // too long to be a button-style reply
  if (words.some((w) => INTERROGATIVES.has(w))) return false; // interrogative → a new question
  return true;
}

// A "non-answer": the bot saying it has no data / asking the user to clarify.
// Saving one of these as a Q→A pair would teach the KB to answer that question
// with "нет данных" — actively harmful. Must NOT become a draft.
const NON_ANSWER_RE =
  /нет данных|уточните|не нашёл|не смог найти|о како[йм]\s+(услуг|вопрос)|переформулируйте/i;

/**
 * Gate a candidate draft on QUALITY, independent of trust. A draft deserves an
 * admin's attention only if it pairs a real question with real content. Rejects
 * two classes of garbage seen on the live bot:
 *   1. Context-less fragments — a one-word clarification reply ("Москва") that
 *      reached the engine standalone. A real KB question has ≥2 words.
 *   2. Non-answers — "в базе нет данных, уточните услугу". Capturing these
 *      poisons the base.
 */
export function isDraftableDraft(question: string, answer: string): boolean {
  const q = question.trim();
  if (q.split(/\s+/).length < 2) return false;
  if (NON_ANSWER_RE.test(answer.trim())) return false;
  return true;
}
