import { PaidStructuredSemanticError } from '@/lib/ai/structured-output';
import { describe, expect, it } from 'vitest';
import type { EvidencePack } from '../evidence-pack';
import type { DraftAnswer } from '../draft-answer';
import { buildConditionPreservationMessages, conditionedEvidenceOf, mergeConditionPreservationVerification, validateConditionPreservationDecisions, verifyConditionsAfterBasicVerification } from '../condition-preservation';

const draft: DraftAnswer = { text: 'Если воды нет, используйте антисептик.', citedUnitIds: ['sanitizer'], answerSource: 'knowledge_base' };
const conditionedPack: EvidencePack = { numericFacts: [], items: [{ unitId: 'sanitizer', kind: 'PROCEDURE_STEP', statement: 'Используйте антисептик.', citation: { anchor: 'b', quote: 'При отсутствии воды допустим антисептик.' }, numericConstraint: null, presentationConditions: ['При отсутствии воды'] }] };

describe('presentation condition preservation', () => {
  it('Q02-like preserved sanitizer condition can pass', async () => {
    const result = await verifyConditionsAfterBasicVerification(true, { question: 'Можно сразу?', draft, pack: conditionedPack, runConfig: {} as never }, async () => ({ decisions: [{ unitId: 'sanitizer', verdict: 'PRESERVED', reason: 'condition attached' }], blockingUnitIds: [], attempts: [], requestMessages: [], responseText: null }));
    expect(result?.blockingUnitIds).toEqual([]);
    expect(mergeConditionPreservationVerification({ verified: true, violations: [] }, result)).toEqual({ verified: true, violations: [] });
  });
  it.each(['DROPPED', 'AMBIGUOUS'] as const)('unconditional/uncertain condition verdict %s blocks', async (verdict) => {
    const result = await verifyConditionsAfterBasicVerification(true, { question: 'Q', draft: { ...draft, text: 'Используйте антисептик.' }, pack: conditionedPack, runConfig: {} as never }, async () => ({ decisions: [{ unitId: 'sanitizer', verdict, reason: 'not proven' }], blockingUnitIds: ['sanitizer'], attempts: [], requestMessages: [], responseText: null }));
    expect(result?.blockingUnitIds).toEqual(['sanitizer']);
    expect(mergeConditionPreservationVerification({ verified: true, violations: [] }, result)).toEqual({
      verified: false,
      violations: [{
        code: 'condition_not_preserved',
        detail: 'условие применимости unit sanitizer не сохранено однозначно',
      }],
    });
  });
  it('missing/unexpected ID throws paid semantic error with telemetry', () => {
    expect(() => validateConditionPreservationDecisions(['sanitizer'], [{ unitId: 'other', verdict: 'PRESERVED', reason: 'x' }], { attempts: [], requestMessages: [], responseText: '{}' })).toThrow(PaidStructuredSemanticError);
  });
  it('no selected conditions means zero verifier calls', async () => {
    let calls = 0; const pack: EvidencePack = { items: [{ ...conditionedPack.items[0], presentationConditions: [] }], numericFacts: [] };
    expect(await verifyConditionsAfterBasicVerification(true, { question: 'Q', draft, pack, runConfig: {} as never }, async () => { calls++; throw new Error('no'); })).toBeNull(); expect(calls).toBe(0);
  });
  it('basic verification failure means zero verifier calls', async () => {
    let calls = 0; expect(await verifyConditionsAfterBasicVerification(false, { question: 'Q', draft, pack: conditionedPack, runConfig: {} as never }, async () => { calls++; throw new Error('no'); })).toBeNull(); expect(calls).toBe(0);
  });
  it('extracts only presentation trigger uncertainties exposed by evidence pack', () => { expect(conditionedEvidenceOf(conditionedPack)[0].conditions).toEqual(['При отсутствии воды']); });
  it('NEGATIVE polarity is explicit and a draft permitting despite absent condition must be rejected', () => {
    const negativePack: EvidencePack = {
      numericFacts: [],
      items: [{ ...conditionedPack.items[0], applicabilityMode: 'NEGATIVE', presentationConditions: ['только при согласии'] }],
    };
    const evidence = conditionedEvidenceOf(negativePack);
    expect(evidence[0].applicabilityMode).toBe('NEGATIVE');
    const messages = buildConditionPreservationMessages(
      'Можно?',
      { ...draft, text: 'Согласия нет, но действие разрешено.' },
      evidence
    );
    expect(messages.map((message) => message.content).join('\n')).toContain('означает DROPPED');
    expect(messages.map((message) => message.content).join('\n')).toContain('Режим: NEGATIVE');
  });
});
