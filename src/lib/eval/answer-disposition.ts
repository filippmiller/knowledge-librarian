/**
 * What an engine question is allowed to END IN, and the single rule that
 * decides between "answered" and "answered but not verified" (W1-A, plan
 * `docs/plans/2026-08-10-cost-and-reliability-hardening.md`).
 *
 * WHY THIS EXISTS. `runEngineOnQuestion` (scripts/run-aurora-fixture.ts)
 * computed `verifyAnswerClaims(draft, evidencePack)` and then returned
 * `actualDisposition: 'DIRECT_ANSWER'` unconditionally, discarding the
 * verdict. That is not theoretical: in
 * `scratchpad/aurora-fixture-full-smoke9/<runId>/engine-results.json`, case
 * `Q05-N1` shipped as `DIRECT_ANSWER` carrying `verification.verified: false`
 * with an `unsupported_number` violation — a number in the answer text that
 * no selected unit supported. The benchmark's own "an answer was delivered"
 * signal therefore included answers the system itself had already judged
 * ungrounded.
 *
 * WHY A NEW DISPOSITION AND NOT `HOLD`. `HOLD` already means "the engine
 * declined to answer and asked for something" (resolution disposition
 * != ANSWER). Reusing it here would be lossy in a way that is easy to verify
 * against the grader, which must not be edited for this change:
 * `grade-aurora-fixture.ts`'s `gradePositiveCase` selects
 * `primaryFailureStage` through an ORDERED if/else chain in which
 * `actualDisposition === 'HOLD'` is tested BEFORE
 * `verification && !verification.verified`. A failed verification returned as
 * `HOLD` would therefore be filed as `UNEXPECTED_HOLD` and every
 * `verification.violations` entry would be dropped from `diagnosticFlags` —
 * the failure would be laundered into something indistinguishable from a
 * normal clarifying question.
 *
 * `UNVERIFIED_ANSWER` instead falls THROUGH that chain to the verification
 * branch, so the grader files it as `SYNTHESIS_ERROR` and attaches the real
 * violation codes. `pass` is false either way (it requires
 * `actualDisposition === 'DIRECT_ANSWER'` AND `verification.verified`), so
 * this never changes a verdict — only what the report says about WHY, and
 * whether the run artifact claims a direct answer was delivered.
 *
 * For negative cases, `gradeNegativeCase` compares `actualDisposition`
 * against the oracle's `expectedDisposition` (`DIRECT_ANSWER` | `HOLD`);
 * `UNVERIFIED_ANSWER` matches neither, so the case fails — and, notably, it
 * is NOT filed as `EXPECTED_CLARIFICATION_MISSED`, which would overstate what
 * happened (the engine did not silently pass off an answer as a clarification;
 * it produced an answer that failed its own grounding check).
 */

/** Что вопрос фактически сделал в бенчмарке. Порядок — от «доставлено» к
 *  «ничего не доставлено», он же порядок в `ANSWER_DISPOSITIONS`. */
export type EngineAnswerDisposition = 'DIRECT_ANSWER' | 'UNVERIFIED_ANSWER' | 'HOLD' | 'ERROR';

export const ANSWER_DISPOSITIONS = [
  'DIRECT_ANSWER',
  'UNVERIFIED_ANSWER',
  'HOLD',
  'ERROR',
] as const satisfies readonly EngineAnswerDisposition[];

/** Только поле, от которого зависит решение — не весь `VerificationResult`,
 *  чтобы этот модуль не тянул за собой synthesis-слой ради одного boolean. */
export interface AnswerVerificationLike {
  readonly verified: boolean;
}

/**
 * Единственное место, где решается, имеет ли черновик право называться
 * прямым ответом.
 *
 * `null` — не «проверять нечего», а «проверка не отработала»: fail closed.
 * Отсутствующий вердикт даёт ровно столько же оснований называть ответ
 * подтверждённым, сколько отрицательный, то есть нисколько.
 */
export function resolveAnswerDisposition(
  verification: AnswerVerificationLike | null
): 'DIRECT_ANSWER' | 'UNVERIFIED_ANSWER' {
  return verification?.verified === true ? 'DIRECT_ANSWER' : 'UNVERIFIED_ANSWER';
}
