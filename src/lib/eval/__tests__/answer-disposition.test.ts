import { describe, expect, it } from 'vitest';

import type { VerificationResult } from '@/lib/knowledge/synthesis/verify-answer-claims';

import {
  ANSWER_DISPOSITIONS,
  resolveAnswerDisposition,
  type EngineAnswerDisposition,
} from '../answer-disposition';

/** Фикстуры типизированы РЕАЛЬНЫМ `VerificationResult`, а не структурным
 *  минимумом модуля: так тест заодно доказывает, что то, что фактически
 *  отдаёт `verifyAnswerClaims`, принимается `resolveAnswerDisposition`. */
function verification(overrides: Partial<VerificationResult> = {}): VerificationResult {
  return { verified: true, violations: [], ...overrides };
}

/**
 * RED-first for the guarantee hole verified in
 * `scratchpad/aurora-fixture-full-smoke9/<runId>/engine-results.json`: case
 * `Q05-N1` shipped `actualDisposition: 'DIRECT_ANSWER'` while its own
 * `verification.verified` was `false` (violation `unsupported_number`).
 * `runEngineOnQuestion` computed the verification and then ignored it.
 */
describe('resolveAnswerDisposition', () => {
  it('a verified draft is a direct answer', () => {
    expect(resolveAnswerDisposition(verification({ verified: true }))).toBe('DIRECT_ANSWER');
  });

  it('an UNVERIFIED draft is never a direct answer (the Q05-N1 hole)', () => {
    const disposition = resolveAnswerDisposition(
      verification({
        verified: false,
        violations: [{ code: 'unsupported_number', detail: '«1 cycle» не подтверждено ни одним выбранным unit\'ом' }],
      })
    );
    expect(disposition).not.toBe('DIRECT_ANSWER');
    expect(disposition).toBe('UNVERIFIED_ANSWER');
  });

  it('an unverified draft is NOT downgraded to HOLD — a failed verification must not read as a clarification', () => {
    // grade-aurora-fixture.ts's `gradePositiveCase` picks `primaryFailureStage`
    // by an ordered if/else chain: `actualDisposition === 'HOLD'` is tested
    // BEFORE `verification && !verification.verified`. Returning 'HOLD' here
    // would therefore label a verification failure `UNEXPECTED_HOLD` and drop
    // every `verification.violations` entry from `diagnosticFlags` — the exact
    // "convert the failure into something that looks like a normal clarifying
    // question" outcome this disposition exists to prevent.
    expect(resolveAnswerDisposition(verification({ verified: false }))).not.toBe('HOLD');
  });

  it('an unverified draft is not reported as an engine ERROR either — the pipeline did run', () => {
    expect(resolveAnswerDisposition(verification({ verified: false }))).not.toBe('ERROR');
  });

  it('fails closed: a missing verification result is not a direct answer', () => {
    expect(resolveAnswerDisposition(null)).toBe('UNVERIFIED_ANSWER');
  });

  it('a false-IRRELEVANT cannot silently upgrade an answer to DIRECT_ANSWER', () => {
    expect(
      resolveAnswerDisposition(verification({ verified: true }), {
        answerDependsOnProbabilisticExclusion: true,
      })
    ).toBe('UNVERIFIED_ANSWER');
  });

  it('exposes exactly the four dispositions an engine question can end in', () => {
    expect([...ANSWER_DISPOSITIONS]).toEqual(['DIRECT_ANSWER', 'UNVERIFIED_ANSWER', 'HOLD', 'ERROR']);
    // Pins the literal the grader is read against (see the HOLD test above):
    // renaming it silently would change how every recorded run is graded.
    const unverified: EngineAnswerDisposition = 'UNVERIFIED_ANSWER';
    expect(ANSWER_DISPOSITIONS).toContain(unverified);
  });
});
