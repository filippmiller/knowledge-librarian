import { describe, expect, it } from 'vitest';
import { buildQuestionJournalFingerprint } from '../question-result-journal';
import { computeQuestionBehaviorProbes } from '../question-behavior-probes';

describe('question behavior probes', () => {
  it('captures required semantic outcomes', () => {
    const p = computeQuestionBehaviorProbes();
    expect(p.numericGrounding).toMatchObject({
      parsed: [{ value: '2.5', unit: 'hour' }, { value: '5', unit: 'minute' }, { value: '30', unit: 'second' }, { value: '3', unit: 'cycle' }],
      grounded: { ungrounded: [] }, unitMismatch: { ungrounded: [{ value: '30', unit: 'minute' }] },
    });
    expect(p.questionNumericRedaction).toMatchObject({ supportedRetained: expect.stringContaining('30 секунд') });
    expect(p.questionNumericRedaction).not.toMatchObject({ unsupportedRemoved: expect.stringContaining('90 секунд') });
    expect(p.evidencePack).toMatchObject({
      conditional: { items: [{ applicabilityMode: 'CONDITIONAL' }] }, negative: { numericFacts: [] },
      supportingContext: { supportingContext: [{ unitId: 'parent' }], numericFacts: [{ value: 3 }] },
    });
    expect(p.necessaryCondition).toEqual({ positive: true, sufficient: false, negated: false, ambiguous: false });
    expect(p.challengeSafety).toMatchObject({ compatible: { answerDependsOnProbabilisticExclusion: false }, conflict: { answerDependsOnProbabilisticExclusion: true }, mandatoryCompatible: { answerDependsOnProbabilisticExclusion: true }, exceptionCompatible: { answerDependsOnProbabilisticExclusion: true } });
    expect(p.disposition).toMatchObject({ verifiedFalse: 'UNVERIFIED_ANSWER' });
  });
  it('each component independently changes journal configDigest', () => {
    const probes = computeQuestionBehaviorProbes();
    const base = buildQuestionJournalFingerprint('a'.repeat(64), { probes }).configDigest;
    for (const key of Object.keys(probes)) {
      expect(buildQuestionJournalFingerprint('a'.repeat(64), { probes: { ...probes, [key]: { mutated: true } } }).configDigest, key).not.toBe(base);
    }
  });
});
