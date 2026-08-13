import { describe, expect, it } from 'vitest';

import {
  buildRealAnswerPromptMessages,
  buildRelevanceRationaleByUnitId,
} from '../run-aurora-fixture';
import {
  SYNTHESIS_ANSWER_TEXT_POLICY,
  type SynthesisPrompt,
} from '../../src/lib/knowledge/synthesis/synthesize';
import { buildEvidencePack } from '../../src/lib/knowledge/synthesis/evidence-pack';
import type { PersistedKnowledgeUnit } from '../../src/lib/knowledge/applicability/identity-assignment';
import type { ResolutionDecision } from '../../src/lib/knowledge/applicability/resolution';
import type { GatedCandidate } from '../../src/lib/knowledge/applicability/decision-relevance';

/**
 * Q08/Q07 postfix (2026-08-11), three fixes to the real-answer synthesis
 * prompt built in `buildRealAnswerGenerator`:
 *
 *  - Fix 1: don't refuse pre-vetted evidence with "в данных нет ответа" when
 *    a unit answers in substance, even if worded differently than the
 *    question (Q08 root cause: resolution HAD selected relevant evidence,
 *    synthesis refused anyway).
 *  - Fix 2: when a rule's applicability conditions list several alternatives
 *    joined by "либо"/"или", the answer must name ALL of them, not only the
 *    ones matching the question's facts (Q07: one branch of a three-way OR
 *    was silently dropped).
 *  - Fix 3: thread decision-relevance's OWN rationale for why a unit is
 *    relevant through to synthesis, labelled distinctly so it can never be
 *    mistaken for evidence or cited.
 *
 * `buildRealAnswerPromptMessages` is a pure, exported prompt builder (no
 * network) — mirrors `buildExceptionRepairPromptMessages`'s role/testing
 * style elsewhere in this file.
 */

function synthesisPrompt(overrides: Partial<SynthesisPrompt> = {}): SynthesisPrompt {
  return {
    question: 'Что делать после того, как ощущение прошло?',
    evidence: [
      {
        unitId: 'u1',
        kind: 'PROCEDURE_STEP',
        statement: 'Правило А.',
        citation: { anchor: 'a1', quote: 'цитата А' },
        numericConstraint: null,
      },
    ],
    supportingContext: [],
    answerTextPolicy: SYNTHESIS_ANSWER_TEXT_POLICY,
    ...overrides,
  };
}

function messagesOf(prompt: SynthesisPrompt) {
  const messages = buildRealAnswerPromptMessages(prompt);
  return {
    system: messages[0].content,
    user: messages[1].content,
    all: messages.map((m) => m.content).join('\n'),
  };
}

describe('buildRealAnswerPromptMessages — Fix 1: не отказывать в предвыбранном evidence', () => {
  it('запрещает отказ фразой «в данных нет ответа», если unit отвечает по существу', () => {
    const { system } = messagesOf(synthesisPrompt());

    expect(system).toContain(
      'Каждый перечисленный ниже unit уже прошёл проверку релевантности на предыдущем этапе конвейера'
    );
    expect(system).toContain('в предоставленных данных нет ответа');
    expect(system).toContain('отвечает на вопрос по существу');
    expect(system).toContain('пусть и другими словами, чем в вопросе');
  });

  it('не отменяет обязанность цитировать использованный unit', () => {
    const { system } = messagesOf(synthesisPrompt());

    expect(system).toContain('это не отменяет обязанность сослаться на использованный unit в citedUnitIds');
  });
});

describe('buildRealAnswerPromptMessages — Fix 2: все альтернативы составного условия', () => {
  it('требует назвать ВСЕ альтернативы через «либо»/«или», не только упомянутые в вопросе', () => {
    const { system } = messagesOf(synthesisPrompt());

    expect(system).toContain('несколько альтернатив через «либо»/«или»');
    expect(system).toContain('ответ обязан назвать все альтернативы этого правила');
    expect(system).toContain('пропускать часть перечня запрещено');
    expect(system).toContain('даже если вопрос назвал лишь некоторые из них');
  });

  it('явно разрешает перефразирование — требование о полноте, не о дословности', () => {
    const { system } = messagesOf(synthesisPrompt());

    expect(system).toContain('формулировку можно менять, смысл каждой альтернативы — нет');
  });
});

describe('buildRealAnswerPromptMessages — Fix 3: relevanceRationale рендерится, но не как evidence', () => {
  it('рендерит rationale под отдельной меткой, когда он присутствует', () => {
    const { user } = messagesOf(
      synthesisPrompt({
        evidence: [
          {
            unitId: 'u1',
            kind: 'PROCEDURE_STEP',
            statement: 'Правило А.',
            citation: { anchor: 'a1', quote: 'цитата А' },
            numericConstraint: null,
            relevanceRationale: 'Обоснование Б, отличное от текста правила.',
          },
        ],
      })
    );

    expect(user).toContain('[u1] Правило А.');
    expect(user).toContain(
      'ПОМЕТКА ПРЕДЫДУЩЕГО ЭТАПА (служебная, не текст источника): "Обоснование Б, отличное от текста правила."'
    );
  });

  it('метка стоит СТРУКТУРНО между statement и текстом rationale — не слита с evidence', () => {
    const { user } = messagesOf(
      synthesisPrompt({
        evidence: [
          {
            unitId: 'u1',
            kind: 'PROCEDURE_STEP',
            statement: 'Правило А.',
            citation: { anchor: 'a1', quote: 'цитата А' },
            numericConstraint: null,
            relevanceRationale: 'Обоснование Б, отличное от текста правила.',
          },
        ],
      })
    );

    const statementIndex = user.indexOf('Правило А.');
    const labelIndex = user.indexOf('ПОМЕТКА ПРЕДЫДУЩЕГО ЭТАПА');
    const rationaleIndex = user.indexOf('Обоснование Б, отличное от текста правила.');

    expect(statementIndex).toBeGreaterThanOrEqual(0);
    expect(labelIndex).toBeGreaterThan(statementIndex);
    expect(rationaleIndex).toBeGreaterThan(labelIndex);
  });

  it('не рендерит метку вовсе, если ни у одного evidence нет relevanceRationale', () => {
    const { user } = messagesOf(synthesisPrompt());

    expect(user).not.toContain('ПОМЕТКА ПРЕДЫДУЩЕГО ЭТАПА');
  });

  it('система объясняет, что метка — не факт источника и не для цитирования', () => {
    const { system } = messagesOf(synthesisPrompt());

    expect(system).toContain(
      'Строка «ПОМЕТКА ПРЕДЫДУЩЕГО ЭТАПА (служебная, не текст источника)» у unit\'а'
    );
    expect(system).toContain('это не факт документа');
    expect(system).toContain('ссылаться на неё как на источник или приводить её в тексте ответа запрещено');
  });

  it('sanity: Fix1/Fix2/rationale-label sentences all coexist in one system message without truncation', () => {
    const { all } = messagesOf(synthesisPrompt());
    // Existing pre-Fix behavior must remain intact alongside the new sentences.
    expect(all).toContain('не добавляй ничего от себя');
    expect(all).toContain('OVERRIDDEN_PARENT_CONTEXT никогда не является самостоятельным разрешением');
    expect(all).toContain('Ответ СТРОГО JSON');
  });
});

describe('buildRelevanceRationaleByUnitId — Fix 3 filtering', () => {
  const gated = (
    unitId: string,
    verdict: GatedCandidate['relevance']['verdict'],
    reason: string
  ): GatedCandidate => ({ unitId, relevance: { verdict, reason, potentiallyDecidingFacts: [] } });

  it('сохраняет RELEVANT вердикт', () => {
    const map = buildRelevanceRationaleByUnitId([gated('u1', 'RELEVANT', 'reason A')]);

    expect(map.get('u1')).toBe('reason A');
  });

  it('сохраняет CONDITIONALLY_RELEVANT вердикт — не только RELEVANT', () => {
    const map = buildRelevanceRationaleByUnitId([gated('u1', 'CONDITIONALLY_RELEVANT', 'reason B')]);

    expect(map.get('u1')).toBe('reason B');
  });

  it('ИСКЛЮЧАЕТ IRRELEVANT вердикт полностью', () => {
    const map = buildRelevanceRationaleByUnitId([gated('u1', 'IRRELEVANT', 'reason C')]);

    expect(map.has('u1')).toBe(false);
  });

  it('в смешанном trace оставляет только не-IRRELEVANT записи', () => {
    const map = buildRelevanceRationaleByUnitId([
      gated('relevant-unit', 'RELEVANT', 'reason A'),
      gated('irrelevant-unit', 'IRRELEVANT', 'reason C'),
      gated('conditional-unit', 'CONDITIONALLY_RELEVANT', 'reason B'),
    ]);

    expect([...map.keys()].sort()).toEqual(['conditional-unit', 'relevant-unit']);
  });
});

/**
 * The subtle case: a unit can reach the evidence pack through a path OTHER
 * than "decision-relevance said RELEVANT" — e.g. kept as negative evidence
 * because its trigger is INACTIVE, or promoted into `resolution.selected` by
 * the bounded challenge-recovery round. In both cases `resolveKnowledgeSet`'s
 * OWN reasoning is what put the unit in the pack, not decision-relevance's
 * verdict — so if that unit's ORIGINAL decision-relevance verdict was
 * IRRELEVANT, `buildRelevanceRationaleByUnitId` must have excluded it, and
 * `buildEvidencePack` must render no rationale for it at all.
 */
describe('buildRelevanceRationaleByUnitId + buildEvidencePack composed — IRRELEVANT never resurfaces via another path', () => {
  const span = (anchor: string, quote: string) => ({ anchor, quote });

  function unit(overrides: Partial<PersistedKnowledgeUnit> = {}): PersistedKnowledgeUnit {
    return {
      kind: 'PROCEDURE_STEP',
      statement: 'Некоторое правило.',
      facets: {},
      triggerCondition: null,
      numericConstraint: null,
      parentRuleRef: null,
      sourceSpan: span('anchor-1', 'некоторое правило'),
      evidenceByField: { statement: span('anchor-1', 'некоторое правило') },
      uncertainties: [],
      sourceBlockAnchor: 'block-1',
      unitId: 'u1',
      contentHash: 'hash-1',
      ...overrides,
    };
  }

  function resolution(overrides: Partial<ResolutionDecision> = {}): ResolutionDecision {
    return {
      disposition: 'ANSWER',
      selected: ['u1'],
      undetermined: [],
      excluded: [],
      overridden: [],
      numericConflicts: [],
      requiresHumanReview: false,
      clarificationNeeds: { facets: [], triggerFacts: [], ambiguities: [] },
      reasons: [],
      ...overrides,
    };
  }

  const gated = (
    unitId: string,
    verdict: GatedCandidate['relevance']['verdict'],
    reason: string
  ): GatedCandidate => ({ unitId, relevance: { verdict, reason, potentiallyDecidingFacts: [] } });

  it('unit kept as negative evidence despite an IRRELEVANT original verdict gets no rationale', () => {
    const relevanceRationaleByUnitId = buildRelevanceRationaleByUnitId([
      gated('u1', 'IRRELEVANT', 'правило говорит о другой ситуации'),
    ]);
    const negative = unit({ numericConstraint: { factKey: 'maximum', value: 3, unit: 'times' } });

    const pack = buildEvidencePack(
      [negative],
      resolution({ selected: [], negativeEvidence: ['u1'] }),
      relevanceRationaleByUnitId
    );

    expect(pack.items).toHaveLength(1);
    expect(pack.items[0].relevanceRationale).toBeUndefined();
  });

  it('unit promoted into `selected` by recovery, whose ORIGINAL verdict was IRRELEVANT, gets no rationale', () => {
    // Mirrors run-aurora-fixture.ts: relevanceRationaleByUnitId is built ONCE
    // from the ORIGINAL decisionRelevance.trace and reused unchanged for the
    // post-recovery pack. A challenge candidate promoted by
    // selectChallengeRecoveryCandidates was, by construction, IRRELEVANT in
    // that original trace — its promotion into `selected` here must not make
    // a rationale appear from nowhere.
    const relevanceRationaleByUnitId = buildRelevanceRationaleByUnitId([
      gated('u1', 'IRRELEVANT', 'правило про дополнительный случай, не относящийся к вопросу'),
    ]);
    const promoted = unit();

    const pack = buildEvidencePack([promoted], resolution({ selected: ['u1'] }), relevanceRationaleByUnitId);

    expect(pack.items[0].relevanceRationale).toBeUndefined();
  });

  it('control: the SAME unit WOULD get a rationale if its original verdict had been RELEVANT', () => {
    // Establishes the contrast: absence above is because of the IRRELEVANT
    // verdict specifically, not because negative-evidence/promoted units can
    // never carry a rationale at all.
    const relevanceRationaleByUnitId = buildRelevanceRationaleByUnitId([
      gated('u1', 'RELEVANT', 'обязательный сопутствующий шаг той же процедуры'),
    ]);
    const promoted = unit();

    const pack = buildEvidencePack([promoted], resolution({ selected: ['u1'] }), relevanceRationaleByUnitId);

    expect(pack.items[0].relevanceRationale).toBe('обязательный сопутствующий шаг той же процедуры');
  });
});
