import { describe, expect, it } from 'vitest';

import {
  gradeNegativeCase,
  gradePositiveCase,
  type EngineQuestionResultLike,
  type RunArtifacts,
} from '../grade-aurora-fixture';
import type { NegativeCaseApplicabilityOracle } from '../../src/lib/eval/negative-case-oracle';
import type { OracleCase } from '../../src/lib/eval/semantic-rule-oracle';

const positiveOracle: OracleCase = {
  id: 'Q08',
  question: 'Что сделать после неприятного ощущения?',
  expectedRuleIds: [8],
  expectedAnswer: 'Продолжить после паузы.',
  matchReason: 'rule 8',
  negativeCases: [],
};

function result(overrides: Partial<EngineQuestionResultLike> = {}): EngineQuestionResultLike {
  return {
    caseId: 'Q08',
    question: positiveOracle.question,
    queryFrame: {},
    retrieval: { candidatesBeforeRerank: ['u8'], topK: ['u8'] },
    resolution: {
      disposition: 'ANSWER',
      selected: ['u8'],
      excluded: [],
      undetermined: [],
      clarificationNeeds: { facets: [], triggerFacts: [], ambiguities: [] },
      reasons: [],
    },
    verification: { verified: true, violations: [] },
    actualDisposition: 'DIRECT_ANSWER',
    errorMessage: null,
    draft: { text: 'answer', citedUnitIds: ['u8'] },
    ...overrides,
  };
}

function run(
  observed: EngineQuestionResultLike,
  rules: Record<string, number> = { u8: 8 },
  units: RunArtifacts['units'] = []
): RunArtifacts {
  return {
    runId: 'quality-run',
    units,
    sourceRuleIdByUnitId: new Map(Object.entries(rules)),
    results: [observed],
  };
}

describe('aurora deterministic grader diagnostics', () => {
  const evidenceUnit = (unitId: string, statement: string) => ({
    unitId,
    statement,
    sourceSpan: { anchor: unitId, quote: statement },
  }) as RunArtifacts['units'][number];

  it('classifies Q08 HOLD at the resolution stage and preserves reason diagnostics', () => {
    const verdict = gradePositiveCase(
      positiveOracle,
      run(result({
        actualDisposition: 'HOLD',
        verification: null,
        draft: null,
        resolution: { ...result().resolution!, disposition: 'HOLD', reasons: ['insufficient_applicable_knowledge'] },
      }))
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.primaryFailureStage).toBe('RESOLUTION_ERROR');
    expect(verdict.diagnosticFlags).toContain('resolution: insufficient_applicable_knowledge');
  });

  it('classifies a fully retrieved Q08 UNVERIFIED_ANSWER as synthesis failure', () => {
    const verdict = gradePositiveCase(
      positiveOracle,
      run(result({
        actualDisposition: 'UNVERIFIED_ANSWER',
        verification: { verified: false, violations: [{ code: 'UNSUPPORTED_CLAIM', detail: 'claim lacks evidence' }] },
      }))
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.primaryFailureStage).toBe('SYNTHESIS_ERROR');
    expect(verdict.diagnosticFlags).toContain('UNSUPPORTED_CLAIM: claim lacks evidence');
  });

  it('never passes Q05-N1 when applicability is correct but the answer is unverified', () => {
    const oracle: NegativeCaseApplicabilityOracle = {
      id: 'Q05-N1',
      expectedDisposition: 'DIRECT_ANSWER',
      requiredCandidateRuleIds: [1, 3, 5],
      requiredSelectedRuleIds: [1, 3],
      forbiddenSelectedRuleIds: [5],
      expectedReasonCodes: ['privacyContext_violated', 'exception_trigger_inactive'],
    };
    const observed = result({
      caseId: 'Q05-N1',
      actualDisposition: 'UNVERIFIED_ANSWER',
      retrieval: { candidatesBeforeRerank: ['u1', 'u3', 'u5'], topK: ['u1', 'u3', 'u5'] },
      resolution: {
        ...result().resolution!,
        selected: ['u1', 'u3'],
        reasons: ['privacyContext_violated', 'exception_trigger_inactive'],
      },
      verification: { verified: false, violations: [{ code: 'UNSUPPORTED_CLAIM', detail: 'unsupported' }] },
    });
    const verdict = gradeNegativeCase(oracle, run(observed, { u1: 1, u3: 3, u5: 5 }));
    expect(verdict.pass).toBe(false);
    expect(verdict.primaryFailureStage).toBe('SYNTHESIS_ERROR');
  });

  it('Q05-N1 keeps forbidden selection as APPLICABILITY_ERROR when verification passed', () => {
    const oracle: NegativeCaseApplicabilityOracle = {
      id: 'Q05-N1',
      expectedDisposition: 'DIRECT_ANSWER',
      forbiddenSelectedRuleIds: [5],
      expectedReasonCodes: ['privacyContext_violated', 'exception_trigger_inactive'],
    };
    const observed = result({
      caseId: 'Q05-N1',
      actualDisposition: 'UNVERIFIED_ANSWER',
      answerDependsOnProbabilisticExclusion: true,
      retrieval: { candidatesBeforeRerank: ['u5'], topK: ['u5'] },
      resolution: { ...result().resolution!, selected: ['u5'], reasons: [] },
      verification: { verified: true, violations: [] },
    });
    const verdict = gradeNegativeCase(oracle, run(observed, { u5: 5 }));
    expect(verdict.pass).toBe(false);
    expect(verdict.primaryFailureStage).toBe('APPLICABILITY_ERROR');
    expect(verdict.diagnosticFlags).not.toContainEqual(expect.stringContaining('SYNTHESIS'));
  });

  it('Q09-N1 attributes verified probabilistic exclusion to applicability, not synthesis', () => {
    const oracle: NegativeCaseApplicabilityOracle = {
      id: 'Q09-N1',
      expectedDisposition: 'DIRECT_ANSWER',
      requiredCandidateRuleIds: [9],
      requiredNegativeEvidenceRuleIds: [9],
      expectedReasonCodes: ['consentStatus_violated'],
    };
    const observed = result({
      caseId: 'Q09-N1',
      actualDisposition: 'UNVERIFIED_ANSWER',
      answerDependsOnProbabilisticExclusion: true,
      retrieval: { candidatesBeforeRerank: ['u9'], topK: ['u9'] },
      resolution: { ...result().resolution!, selected: [], negativeEvidence: ['u9'], reasons: [] },
      verification: { verified: true, violations: [] },
      draft: { text: 'Нет.', citedUnitIds: ['u9'] },
    });
    const verdict = gradeNegativeCase(oracle, run(observed, { u9: 9 }));
    expect(verdict.pass).toBe(false);
    expect(verdict.primaryFailureStage).toBe('APPLICABILITY_ERROR');
    expect(verdict.diagnosticFlags).toContain('missing expected reason code(s): consentStatus_violated');
  });

  describe('Q09-N1 negative-evidence polarity contract', () => {
    const oracle: NegativeCaseApplicabilityOracle = {
      id: 'Q09-N1',
      expectedDisposition: 'DIRECT_ANSWER',
      requiredCandidateRuleIds: [9],
      requiredNegativeEvidenceRuleIds: [9],
      expectedReasonCodes: ['consentStatus_violated'],
    };
    const q09 = (resolutionOverrides: Partial<NonNullable<EngineQuestionResultLike['resolution']>> = {}, citedUnitIds = ['u9']) => result({
      caseId: 'Q09-N1',
      question: 'Можно при отсутствии согласия?',
      retrieval: { candidatesBeforeRerank: ['u9'], topK: ['u9'] },
      resolution: {
        ...result().resolution!,
        selected: [],
        negativeEvidence: ['u9'],
        reasons: ['consentStatus_violated'],
        ...resolutionOverrides,
      },
      draft: { text: 'Нет, требуется ясное согласие.', citedUnitIds },
    });

    it('passes when rule 9 is non-operative negative evidence and is cited', () => {
      expect(gradeNegativeCase(oracle, run(q09(), { u9: 9 })).pass).toBe(true);
    });

    it('classifies missing negative evidence as applicability failure', () => {
      const verdict = gradeNegativeCase(oracle, run(q09({ negativeEvidence: [] }), { u9: 9 }));
      expect(verdict.pass).toBe(false);
      expect(verdict.primaryFailureStage).toBe('APPLICABILITY_ERROR');
      expect(verdict.diagnosticFlags).toContain('required negative-evidence rule(s) 9 absent from negativeEvidence');
    });

    it('rejects the same rule being operative-selected even when negative evidence is also present', () => {
      const verdict = gradeNegativeCase(oracle, run(q09({ selected: ['u9'] }), { u9: 9 }));
      expect(verdict.pass).toBe(false);
      expect(verdict.primaryFailureStage).toBe('APPLICABILITY_ERROR');
      expect(verdict.diagnosticFlags).toContain('required negative-evidence rule(s) 9 also appeared in operative selected');
    });

    it('classifies uncited negative evidence as evidence failure', () => {
      const verdict = gradeNegativeCase(oracle, run(q09({}, []), { u9: 9 }));
      expect(verdict.pass).toBe(false);
      expect(verdict.primaryFailureStage).toBe('EVIDENCE_ERROR');
      expect(verdict.diagnosticFlags).toContain('required negative-evidence rule(s) 9 not cited by direct answer');
    });

    it('does not let negative evidence satisfy ordinary requiredSelectedRuleIds', () => {
      const ordinary: NegativeCaseApplicabilityOracle = {
        id: 'Q09-N1', expectedDisposition: 'DIRECT_ANSWER', requiredSelectedRuleIds: [9],
      };
      const verdict = gradeNegativeCase(ordinary, run(q09(), { u9: 9 }));
      expect(verdict.pass).toBe(false);
      expect(verdict.primaryFailureStage).toBe('RESOLUTION_ERROR');
    });

    it('does not treat a forbidden rule in negative evidence as operative selection', () => {
      const forbidden: NegativeCaseApplicabilityOracle = {
        id: 'Q09-N1', expectedDisposition: 'DIRECT_ANSWER', forbiddenSelectedRuleIds: [9],
      };
      expect(gradeNegativeCase(forbidden, run(q09(), { u9: 9 })).pass).toBe(true);
    });
  });

  it('Q10-N1 preserves the upstream forbidden-rule applicability failure', () => {
    const oracle: NegativeCaseApplicabilityOracle = {
      id: 'Q10-N1',
      expectedDisposition: 'DIRECT_ANSWER',
      forbiddenSelectedRuleIds: [10],
      expectedReasonCodes: ['reachability_violated', 'exception_trigger_inactive'],
    };
    const observed = result({
      caseId: 'Q10-N1',
      actualDisposition: 'UNVERIFIED_ANSWER',
      answerDependsOnProbabilisticExclusion: true,
      retrieval: { candidatesBeforeRerank: ['u10'], topK: ['u10'] },
      resolution: { ...result().resolution!, selected: ['u10'], reasons: [] },
      verification: { verified: true, violations: [] },
    });
    const verdict = gradeNegativeCase(oracle, run(observed, { u10: 10 }));
    expect(verdict.pass).toBe(false);
    expect(verdict.primaryFailureStage).toBe('APPLICABILITY_ERROR');
  });

  it('missing verification is EVIDENCE_ERROR, never a claimed synthesis failure', () => {
    const oracle: NegativeCaseApplicabilityOracle = {
      id: 'Q09-N1',
      expectedDisposition: 'DIRECT_ANSWER',
    };
    const verdict = gradeNegativeCase(
      oracle,
      run(result({ caseId: 'Q09-N1', actualDisposition: 'UNVERIFIED_ANSWER', verification: null }))
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.primaryFailureStage).toBe('EVIDENCE_ERROR');
  });

  it('assigns missing expected reason codes to resolution diagnostics', () => {
    const oracle: NegativeCaseApplicabilityOracle = {
      id: 'Q05-N1',
      expectedDisposition: 'DIRECT_ANSWER',
      expectedReasonCodes: ['exception_trigger_inactive'],
    };
    const verdict = gradeNegativeCase(oracle, run(result({ caseId: 'Q05-N1' })));
    expect(verdict.pass).toBe(false);
    expect(verdict.primaryFailureStage).toBe('RESOLUTION_ERROR');
    expect(verdict.diagnosticFlags[0]).toMatch(/missing expected reason code/);
  });

  it('does not ignore numeric assertions in negative/quality cases', () => {
    const oracle: NegativeCaseApplicabilityOracle = {
      id: 'Q04-N1',
      expectedDisposition: 'DIRECT_ANSWER',
      numericAssertions: [{ value: 15, unit: 'seconds' }, { value: 3, unit: 'cycles' }],
    };
    const observed = result({
      caseId: 'Q04-N1',
      retrieval: { candidatesBeforeRerank: ['u4'], topK: ['u4'] },
      resolution: { ...result().resolution!, selected: ['u4'] },
    });
    const unit = {
      unitId: 'u4',
      numericConstraint: { factKey: 'duration', value: 15, unit: 'second' },
    } as RunArtifacts['units'][number];
    const verdict = gradeNegativeCase(oracle, run(observed, { u4: 4 }, [unit]));
    expect(verdict.pass).toBe(false);
    expect(verdict.primaryFailureStage).toBe('EVIDENCE_ERROR');
    expect(verdict.diagnosticFlags).toContain('selected evidence misses required numeric(s): 3 cycles');
  });

  it('Q01 fails when a rule-1 clothing unit is selected without the private-place prerequisite', () => {
    const oracle: OracleCase = {
      id: 'Q01', question: 'Насколько спустить одежду?', expectedRuleIds: [1],
      expectedAnswer: 'Ослабить одежду в уединённом месте.', matchReason: 'complete rule 1', negativeCases: [],
    };
    const clothing = evidenceUnit('clothing', 'Брюки следует спустить настолько, чтобы открыть нужный участок; полностью снимать одежду не требуется.');
    const observed = result({
      caseId: 'Q01', retrieval: { candidatesBeforeRerank: ['clothing'], topK: ['clothing'] },
      resolution: { ...result().resolution!, selected: ['clothing'] },
      draft: { text: 'Достаточно немного спустить брюки.', citedUnitIds: ['clothing'] },
    });
    const verdict = gradePositiveCase(oracle, run(observed, { clothing: 1 }, [clothing]));
    expect(verdict.pass).toBe(false);
    expect(verdict.primaryFailureStage).toBe('RESOLUTION_ERROR');
    expect(verdict.diagnosticFlags).toContainEqual(expect.stringContaining('закрытое место'));
  });

  it('Q01 passes only when clothing extent and private-place prerequisite are both selected', () => {
    const oracle: OracleCase = {
      id: 'Q01', question: 'Насколько спустить одежду?', expectedRuleIds: [1],
      expectedAnswer: 'Ослабить одежду в уединённом месте.', matchReason: 'complete rule 1', negativeCases: [],
    };
    const clothing = evidenceUnit('clothing', 'Брюки следует спустить настолько, чтобы открыть нужный участок; полностью снимать одежду не требуется.');
    const privacy = evidenceUnit('privacy', 'Перед началом нужно перейти в закрытое место, где действия не видны окружающим.');
    const observed = result({
      caseId: 'Q01', retrieval: { candidatesBeforeRerank: ['clothing', 'privacy'], topK: ['clothing', 'privacy'] },
      resolution: { ...result().resolution!, selected: ['clothing', 'privacy'] },
      draft: { text: 'Немного спустить одежду в закрытом месте.', citedUnitIds: ['clothing', 'privacy'] },
    });
    expect(gradePositiveCase(oracle, run(observed, { clothing: 1, privacy: 1 }, [clothing, privacy])).pass).toBe(true);
  });

  it('Q10 rejects the old reachability-only evidence and accepts the full helper safety contract', () => {
    const oracle: OracleCase = {
      id: 'Q10', question: 'Как помочь, если не дотянуться?', expectedRuleIds: [10],
      expectedAnswer: 'Безопасная помощь.', matchReason: 'complete helper contract', negativeCases: [],
    };
    const units = [
      evidenceUnit('reach', 'Если человек не может дотянуться, допускается помощь ухаживающего лица или мягкая ткань.'),
      evidenceUnit('sharp', 'Приспособление с твёрдым или острым концом применять нельзя.'),
      evidenceUnit('consent', 'Другой человек может помочь только после ясного согласия.'),
      evidenceUnit('gloves', 'Помощник обязан надеть чистые одноразовые перчатки.'),
      evidenceUnit('limits', 'Помощник обязан соблюдать ограничения по силе воздействия и по времени.'),
      evidenceUnit('stop', 'Помощник обязан немедленно остановиться по первой просьбе.'),
    ];
    const rules = { reach: 10, sharp: 10, consent: 9, gloves: 9, limits: 9, stop: 9 };
    const incomplete = result({
      caseId: 'Q10', retrieval: { candidatesBeforeRerank: Object.keys(rules), topK: Object.keys(rules) },
      resolution: { ...result().resolution!, selected: ['reach', 'sharp'] },
      draft: { text: 'Можно попросить помощника.', citedUnitIds: ['reach'] },
    });
    expect(gradePositiveCase(oracle, run(incomplete, rules, units)).pass).toBe(false);

    const complete = result({
      ...incomplete,
      resolution: { ...result().resolution!, selected: Object.keys(rules) },
      draft: { text: 'Помощь только с согласием, перчатками, лимитами и остановкой по просьбе.', citedUnitIds: Object.keys(rules) },
    });
    expect(gradePositiveCase(oracle, run(complete, rules, units)).pass).toBe(true);
  });
});
