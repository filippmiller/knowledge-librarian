import { checkClaimGrounding, extractRiskyClaims, redactUnsupportedNumericClaims } from '@/lib/ai/claim-grounding';
import { hasSourceBackedNecessaryCondition } from './knowledge-unit-adapter';
import { buildEvidencePack } from '@/lib/knowledge/synthesis/evidence-pack';
import { resolveProbabilisticExclusionSafety } from '@/lib/knowledge/synthesis/challenge-compatibility';
import { resolveAnswerDisposition } from './answer-disposition';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';
import type { ResolutionDecision } from '@/lib/knowledge/applicability/resolution';

const unit = (id: string, overrides: Partial<PersistedKnowledgeUnit> = {}): PersistedKnowledgeUnit => ({
  kind: 'PROCEDURE_STEP', statement: 'Действуйте не более 30 секунд.', facets: {}, triggerCondition: null,
  numericConstraint: { factKey: 'duration', value: 30, unit: 'seconds' }, parentRuleRef: null,
  sourceSpan: { anchor: id, quote: 'не более 30 секунд' }, evidenceByField: { statement: { anchor: id, quote: 'не более 30 секунд' } },
  uncertainties: [], sourceBlockAnchor: id, unitId: id, contentHash: `hash-${id}`, ...overrides,
});
const resolution = (overrides: Partial<ResolutionDecision> = {}): ResolutionDecision => ({
  disposition: 'ANSWER', selected: ['normal'], undetermined: [], excluded: [], overridden: [], numericConflicts: [],
  requiresHumanReview: false, clarificationNeeds: { facets: [], triggerFacts: [], ambiguities: [] }, reasons: [], ...overrides,
});
const challenge = (id: string, kind: 'PROCEDURE_STEP' | 'EXCEPTION_RULE' = 'PROCEDURE_STEP', mandatoryPrerequisite = false) => ({
  unitId: id, statement: id, quote: id, mandatoryPrerequisite, evaluated: { unitId: id, kind } as never,
});
const safety = (id: string, verdict: 'COMPATIBLE' | 'CONFLICTS' | 'AMBIGUOUS' | null, kind: 'PROCEDURE_STEP' | 'EXCEPTION_RULE' = 'PROCEDURE_STEP', mandatory = false, restored: 'ANSWER' | 'HOLD' = 'ANSWER') => {
  const c = challenge(id, kind, mandatory);
  return resolveProbabilisticExclusionSafety(
    { relevant: [], trace: [], droppedByClassifier: [id], answerDependsOnProbabilisticExclusion: true, classifierTelemetry: null, challengeCandidates: [c] },
    { restoredDispositionByUnitId: { [id]: restored }, blockingUnitIds: restored === 'HOLD' ? [id] : [] },
    verdict === null ? null : { decisions: [{ unitId: id, verdict, contradiction: verdict === 'CONFLICTS' ? 'YES' : verdict === 'AMBIGUOUS' ? 'UNKNOWN' : 'NO', missingRequiredContent: 'NO', reason: 'probe' }] }
  );
};

export function computeQuestionBehaviorProbes(): Record<string, unknown> {
  const normal = unit('normal');
  const conditionalResolution = resolution({ selectedApplicability: [{ unitId: 'normal', mode: 'CONDITIONAL', presentationConditions: ['если доступ разрешён'] }] });
  const negativeResolution = resolution({ selected: [], negativeEvidence: ['normal'], selectedApplicability: [{ unitId: 'normal', mode: 'NEGATIVE', presentationConditions: ['только при согласии'] }] });
  const grand = unit('grand');
  const parent = unit('parent', { kind: 'EXCEPTION_RULE', parentRuleRef: 'grand', numericConstraint: { factKey: 'parent_limit', value: 99, unit: 'seconds' } });
  const child = unit('child', { kind: 'EXCEPTION_RULE', parentRuleRef: 'parent', numericConstraint: { factKey: 'child_limit', value: 3, unit: 'cycles' } });
  return {
    numericGrounding: {
      parsed: extractRiskyClaims('30 секунд, 3 цикла, пять минут, 2.5 часа; 07.08.2026, 15:30, пункт 4.2'),
      grounded: checkClaimGrounding('30 секунд и 3 цикла', ['не более 30 секунд; максимум 3 цикла']),
      unitMismatch: checkClaimGrounding('30 минут', ['30 секунд']),
    },
    questionNumericRedaction: {
      unsupportedRemoved: redactUnsupportedNumericClaims('Можно выполнять 90 секунд?', ['разрешено 30 секунд']),
      supportedRetained: redactUnsupportedNumericClaims('Можно выполнять 30 секунд?', ['разрешено 30 секунд']),
    },
    evidencePack: {
      normal: buildEvidencePack([normal], resolution()),
      conditional: buildEvidencePack([normal], conditionalResolution),
      negative: buildEvidencePack([normal], negativeResolution),
      supportingContext: buildEvidencePack([grand, parent, child], resolution({ selected: ['child'], overridden: [{ unitId: 'grand', byUnitId: 'parent' }, { unitId: 'parent', byUnitId: 'child' }] })),
    },
    necessaryCondition: {
      positive: hasSourceBackedNecessaryCondition('Доступно только при согласии.', []),
      sufficient: hasSourceBackedNecessaryCondition('Если согласен, доступно.', []),
      negated: hasSourceBackedNecessaryCondition('Не только при согласии.', []),
      ambiguous: hasSourceBackedNecessaryCondition('Согласие может потребоваться.', []),
    },
    challengeSafety: {
      compatible: safety('compatible', 'COMPATIBLE'), conflict: safety('conflict', 'CONFLICTS'),
      ambiguous: safety('ambiguous', 'AMBIGUOUS'), missing: safety('missing', null),
      restoredHoldCompatible: safety('restored', 'COMPATIBLE', 'PROCEDURE_STEP', false, 'HOLD'),
      mandatoryCompatible: safety('mandatory', 'COMPATIBLE', 'PROCEDURE_STEP', true),
      exceptionCompatible: safety('exception', 'COMPATIBLE', 'EXCEPTION_RULE'),
    },
    disposition: {
      verifiedSafe: resolveAnswerDisposition({ verified: true }, { answerDependsOnProbabilisticExclusion: false }),
      verifiedUnsafe: resolveAnswerDisposition({ verified: true }, { answerDependsOnProbabilisticExclusion: true }),
      verifiedFalse: resolveAnswerDisposition({ verified: false }), nullVerification: resolveAnswerDisposition(null),
    },
  };
}
