import { describe, expect, it } from 'vitest';
import type {
  ChallengeCounterfactualResult,
  DecisionRelevanceChallenge,
  DecisionRelevanceGateResult,
} from '../../applicability/decision-relevance';
import {
  buildChallengeCompatibilityMessages,
  resolveProbabilisticExclusionSafety,
  selectChallengeRecoveryCandidates,
  validateChallengeCompatibilityDecisions,
  verifyChallengesAfterBasicVerification,
  type ChallengeCompatibilityDecision,
} from '../challenge-compatibility';
import type { DraftAnswer } from '../draft-answer';
import type { EvidencePack } from '../evidence-pack';
import type { ResolutionDecision } from '../../applicability/resolution';
import { resolveKnowledgeSet, type EvaluatedCandidate } from '../../applicability/resolution';
import { buildEvidencePack } from '../evidence-pack';
import { synthesizeFromSelectedUnits } from '../synthesize';
import { verifyAnswerClaims } from '../verify-answer-claims';
import type { PersistedKnowledgeUnit } from '../../applicability/identity-assignment';
import { PaidStructuredSemanticError } from '@/lib/ai/structured-output';

const draft: DraftAnswer = {
  text: 'Основной ответ.',
  citedUnitIds: ['primary'],
  answerSource: 'knowledge_base',
};

const pack: EvidencePack = {
  items: [{
    unitId: 'primary', kind: 'PROCEDURE_STEP', statement: 'Selected narrow action.',
    citation: { anchor: 'b', quote: 'Selected narrow action.' }, numericConstraint: null,
  }],
  numericFacts: [],
};

const resolution: ResolutionDecision = {
  disposition: 'ANSWER', selected: ['primary'], undetermined: [], excluded: [],
  overridden: [], numericConflicts: [], requiresHumanReview: false,
  clarificationNeeds: { facets: [], triggerFacts: [], ambiguities: [] }, reasons: [],
};

function challenge(unitId: string, statement: string): DecisionRelevanceChallenge {
  return { unitId, statement, quote: statement, mandatoryPrerequisite: false, evaluated: { unitId } as never };
}

function evaluated(unitId: string): EvaluatedCandidate {
  return {
    unitId, kind: 'PROCEDURE_STEP', parentRuleRef: null, supersedes: [], numericConstraint: null, trigger: null,
    eligibility: { eligible: true, autoAnswerAllowed: true, requiresHumanReview: false, reasons: [], blockingReasons: [], unknownRequiredFacets: [], absentRequiredFacets: [] },
    scope: { verdict: 'MATCH', facetVerdicts: [], missingFacets: [], unknownFacets: [], conflictingFacets: [], requiresClarification: false, reasons: [] },
  };
}

function persisted(unitId: string, statement: string, condition?: string): PersistedKnowledgeUnit {
  return {
    unitId, contentHash: `hash-${unitId}`, sourceBlockAnchor: 'block', kind: 'PROCEDURE_STEP', statement,
    facets: {}, triggerCondition: null, numericConstraint: null, parentRuleRef: null,
    sourceSpan: { anchor: 'block', quote: statement }, evidenceByField: { statement: { anchor: 'block', quote: statement } },
    uncertainties: condition ? [{ kind: 'UNRECOGNIZED_TRIGGER_CONDITION', description: 'presentation condition', quote: condition }] : [],
  };
}

function gate(
  challenges: readonly DecisionRelevanceChallenge[],
  exceptionDrops: readonly string[] = []
): DecisionRelevanceGateResult {
  return {
    relevant: [],
    trace: [],
    droppedByClassifier: [...challenges.map((item) => item.unitId), ...exceptionDrops],
    answerDependsOnProbabilisticExclusion: true,
    classifierTelemetry: null,
    challengeCandidates: challenges,
  };
}

function counterfactual(
  challenges: readonly DecisionRelevanceChallenge[],
  blockingUnitIds: readonly string[] = []
): ChallengeCounterfactualResult {
  return {
    restoredDispositionByUnitId: Object.fromEntries(
      challenges.map((item) => [item.unitId, blockingUnitIds.includes(item.unitId) ? 'HOLD' : 'ANSWER'])
    ),
    blockingUnitIds,
  };
}

function decisions(values: readonly [string, 'COMPATIBLE' | 'CONFLICTS' | 'AMBIGUOUS'][]): {
  decisions: readonly ChallengeCompatibilityDecision[];
} {
  return {
    decisions: values.map(([unitId, verdict]) => ({
      unitId,
      verdict,
      contradiction: verdict === 'CONFLICTS' ? 'YES' : verdict === 'AMBIGUOUS' ? 'UNKNOWN' : 'NO',
      missingRequiredContent: 'NO',
      reason: 'test evidence',
    })),
  };
}

describe('challenge-candidate safety', () => {
  it('location restriction that changes an undressing answer remains blocking (Q01 regression class)', () => {
    const c = challenge('location-rule', 'In a shared place clothing must remain closed.');
    const result = resolveProbabilisticExclusionSafety(
      gate([c]),
      counterfactual([c]),
      decisions([['location-rule', 'CONFLICTS']])
    );
    expect(result).toEqual({ answerDependsOnProbabilisticExclusion: true, blockingUnitIds: ['location-rule'] });
  });

  it('special emergency action that replaces the normal duration regime remains blocking (Q04 regression class)', () => {
    const c = challenge('emergency-rule', 'In the special context only one three-second press is allowed.');
    const result = resolveProbabilisticExclusionSafety(
      gate([c]),
      counterfactual([c]),
      decisions([['emergency-rule', 'AMBIGUOUS']])
    );
    expect(result.answerDependsOnProbabilisticExclusion).toBe(true);
  });

  it.each([
    ['redundant-detail', 'A weaker detail beside a stronger method prohibition.'],
    ['orthogonal-aftercare', 'A step performed after the already-required stop.'],
    ['independent-threshold', 'A threshold irrelevant because another stated OR condition is sufficient.'],
  ])('compatible redundant/orthogonal challenge %s does not downgrade a verified answer', (unitId, statement) => {
    const c = challenge(unitId, statement);
    const result = resolveProbabilisticExclusionSafety(
      gate([c]),
      counterfactual([c]),
      decisions([[unitId, 'COMPATIBLE']])
    );
    expect(result).toEqual({ answerDependsOnProbabilisticExclusion: false, blockingUnitIds: [] });
  });

  it('missing compatibility result fails closed', () => {
    const c = challenge('challenge', 'Potential qualification.');
    expect(resolveProbabilisticExclusionSafety(gate([c]), counterfactual([c]), null).answerDependsOnProbabilisticExclusion).toBe(true);
  });

  it('explicit compatibility may clear an over-conservative structural HOLD for an ordinary rule', () => {
    const c = challenge('ordinary', 'General rule compatible with the selected narrow action.');
    expect(resolveProbabilisticExclusionSafety(
      gate([c]), counterfactual([c], ['ordinary']), decisions([['ordinary', 'COMPATIBLE']])
    )).toEqual({ answerDependsOnProbabilisticExclusion: false, blockingUnitIds: [] });
  });

  it('false COMPATIBLE cannot clear a deterministic mandatory prerequisite', () => {
    const c = {
      ...challenge('mandatory', 'The action is allowed only after approval.'),
      mandatoryPrerequisite: true,
    };
    expect(resolveProbabilisticExclusionSafety(
      gate([c]), counterfactual([c], ['mandatory']), decisions([['mandatory', 'COMPATIBLE']])
    )).toEqual({ answerDependsOnProbabilisticExclusion: true, blockingUnitIds: ['mandatory'] });
  });

  it('selects only mandatory prerequisites and exact no-contradiction missing-content challenges for one recovery', () => {
    const mandatory = { ...challenge('mandatory', 'Only after approval.'), mandatoryPrerequisite: true };
    const omitted = challenge('omitted', 'Conditional alternative.');
    const conflict = challenge('conflict', 'Contradictory rule.');
    const compatibility = {
      decisions: [
        { unitId: 'mandatory', verdict: 'AMBIGUOUS' as const, contradiction: 'UNKNOWN' as const, missingRequiredContent: 'NO' as const, reason: 'x' },
        { unitId: 'omitted', verdict: 'CONFLICTS' as const, contradiction: 'NO' as const, missingRequiredContent: 'YES' as const, reason: 'x' },
        { unitId: 'conflict', verdict: 'CONFLICTS' as const, contradiction: 'YES' as const, missingRequiredContent: 'NO' as const, reason: 'x' },
      ],
    };
    expect(selectChallengeRecoveryCandidates(gate([mandatory, omitted, conflict]), compatibility).map((item) => item.unitId))
      .toEqual(['mandatory', 'omitted']);
  });

  it('provider semantic ID errors remain paid semantic errors with telemetry', () => {
    expect(() => validateChallengeCompatibilityDecisions(
      ['expected'],
      [{ unitId: 'unexpected', verdict: 'COMPATIBLE', contradiction: 'NO', missingRequiredContent: 'NO', reason: 'x' }],
      { attempts: [], requestMessages: [{ role: 'user', content: 'paid request' }], responseText: '{"results":[]}' }
    )).toThrow(PaidStructuredSemanticError);
  });

  it('no recoverable omission schedules no recovery work', () => {
    const unrelated = challenge('unrelated', 'Unrelated detail.');
    expect(selectChallengeRecoveryCandidates(
      gate([unrelated]),
      decisions([['unrelated', 'COMPATIBLE']])
    )).toEqual([]);
  });

  it.each([
    ['Q02 sanitizer', 'id-a91', 'Visual cleanliness is insufficient.', 'id-b92', 'Use sanitizer.', 'When water is unavailable'],
    ['Q03 short nails', 'id-c93', 'Use fingertips.', 'id-d94', 'Nails must be short.', undefined],
  ] as const)('%s omission recovers through resolution, evidence, synthesis and deterministic verification', async (_name, baseId, baseText, omittedId, omittedText, condition) => {
    const omittedChallenge: DecisionRelevanceChallenge = {
      ...challenge(omittedId, omittedText), evaluated: evaluated(omittedId),
    };
    const initialGate = {
      ...gate([omittedChallenge]),
      relevant: [evaluated(baseId)],
    };
    const compatibility = {
      decisions: [{
        unitId: omittedId, verdict: 'CONFLICTS' as const, contradiction: 'NO' as const,
        missingRequiredContent: 'YES' as const, reason: 'required content omitted',
      }],
    };
    const promoted = selectChallengeRecoveryCandidates(initialGate, compatibility);
    expect(promoted.map((item) => item.unitId)).toEqual([omittedId]);
    const recoveredResolution = resolveKnowledgeSet(
      [...initialGate.relevant, ...promoted.map((item) => item.evaluated)],
      { concepts: [], facets: {} as never, triggerFacts: {} as never, questionAspects: [], ambiguities: [] }
    );
    expect(recoveredResolution.disposition).toBe('ANSWER');
    const recoveredPack = buildEvidencePack(
      [persisted(baseId, baseText), persisted(omittedId, omittedText, condition)],
      recoveredResolution
    );
    const recoveredDraft = await synthesizeFromSelectedUnits(recoveredPack, 'Question?', async (prompt) => ({
      text: prompt.evidence.map((item) => `${item.presentationConditions?.join(' ') ?? ''} ${item.statement}`).join(' '),
      citedUnitIds: prompt.evidence.map((item) => item.unitId),
    }));
    expect(verifyAnswerClaims(recoveredDraft, recoveredPack).verified).toBe(true);
    expect(recoveredDraft.citedUnitIds).toContain(omittedId);
    if (condition) expect(recoveredDraft.text).toContain(condition);
  });

  it('a dropped exception remains blocking even if a malformed caller puts it in challenges as COMPATIBLE', () => {
    const c = {
      ...challenge('exception', 'Narrow exception.'),
      evaluated: { unitId: 'exception', kind: 'EXCEPTION_RULE' } as never,
    };
    expect(resolveProbabilisticExclusionSafety(
      gate([c]), counterfactual([c]), decisions([['exception', 'COMPATIBLE']])
    ).blockingUnitIds).toEqual(['exception']);
  });

  it('classifier-dropped exception never enters the clearable challenge path', () => {
    const result = resolveProbabilisticExclusionSafety(gate([], ['unknown-trigger-exception']), counterfactual([]), decisions([]));
    expect(result).toEqual({
      answerDependsOnProbabilisticExclusion: true,
      blockingUnitIds: ['unknown-trigger-exception'],
    });
  });

  it('failed basic verification makes zero compatibility calls and retains fail-closed provenance', async () => {
    const c = challenge('still-blocking', 'Potential qualification.');
    let providerCalls = 0;
    const compatibility = await verifyChallengesAfterBasicVerification(
      false,
      { question: 'Question?', draft, challenges: [c], pack, resolution, counterfactuals: counterfactual([c]), runConfig: {} as never },
      async () => {
        providerCalls++;
        throw new Error('must not be called');
      }
    );
    expect(providerCalls).toBe(0);
    expect(compatibility).toBeNull();
    expect(
      resolveProbabilisticExclusionSafety(gate([c]), counterfactual([c]), compatibility)
    ).toEqual({
      answerDependsOnProbabilisticExclusion: true,
      blockingUnitIds: ['still-blocking'],
    });
  });

  it('prompt exposes every challenge statement and asks about compatibility with the completed draft', () => {
    const contextualResolution = { ...resolution, overridden: [{ unitId: 'general', byUnitId: 'primary' }] };
    const messages = buildChallengeCompatibilityMessages(
      'Question?', draft,
      [challenge('c1', 'First constraint.'), challenge('c2', 'Second constraint.')],
      pack, contextualResolution, counterfactual([], [])
    );
    const text = messages.map((message) => message.content).join('\n');
    expect(text).toContain('Основной ответ.');
    expect(text).toContain('First constraint.');
    expect(text).toContain('Second constraint.');
    expect(text).toContain('AMBIGUOUS');
    expect(text).toContain('Selected narrow action.');
    expect(text).toContain('general -> primary');
    expect(text).toContain('нет пропущенного обязательного содержания');
  });

  it('Q05 class prompt distinguishes narrow pressing evidence from a general closed-place scratching rule', () => {
    const contextualPack: EvidencePack = {
      items: [{ ...pack.items[0], statement: 'In public, one brief press through clothing is allowed; it is not scratching.' }],
      numericFacts: [],
    };
    const messages = buildChallengeCompatibilityMessages(
      'What may I do on a bus?',
      { ...draft, text: 'One brief press through clothing is allowed, not scratching.' },
      [challenge('closed-place', 'Before scratching, move to a closed place.')],
      contextualPack, resolution, counterfactual([], [])
    );
    const text = messages.map((message) => message.content).join('\n');
    expect(text).toContain('Различай действия буквально');
    expect(text).toContain('one brief press');
    expect(text).toContain('Before scratching');
  });
});
