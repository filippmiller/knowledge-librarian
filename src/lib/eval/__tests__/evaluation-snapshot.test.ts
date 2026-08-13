import { describe, expect, it } from 'vitest';
import { buildEvaluationSnapshot, type EvaluationSnapshotMetadata } from '../evaluation-snapshot';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';

/**
 * Goal shift 2026-08-08 (ChatGPT feedback, corrected prompt): benchmark does
 * NOT require human review for this fixture — `EvaluationKnowledgeSnapshot`
 * is an explicitly UNREVIEWED, evaluation-only artifact, kept structurally
 * distinct from `ReviewedKnowledgeSnapshot` (reviewed-snapshot.ts) so the
 * production trust boundary stays intact: nothing here weakens what
 * buildReviewedSnapshot/applyReviewManifest already guarantee, it's a
 * parallel, honestly-labeled path for the benchmark only.
 */

const span = (anchor: string, quote: string) => ({ anchor, quote });

function unit(overrides: Partial<PersistedKnowledgeUnit> = {}): PersistedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'заполнитель',
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    parentRuleRef: null,
    sourceSpan: span('anchor-1', 'заполнитель'),
    evidenceByField: { statement: span('anchor-1', 'заполнитель') },
    uncertainties: [],
    sourceBlockAnchor: 'block-1',
    unitId: 'u1',
    contentHash: 'hash-1',
    ...overrides,
  };
}

const METADATA: EvaluationSnapshotMetadata = {
  sourceRevisionHash: 'source-rev-1',
  canonicalTextHash: 'canonical-text-hash-1',
  parserVersion: '2.0.0',
  extractionRunId: 'run-2026-08-08T23-00-00Z',
  extractionProvider: 'anthropic',
  extractionModel: 'claude-haiku-4-5-20251001',
  extractionPromptVersion: 'test-prompt-v1',
  extractionSchemaVersion: 'test-schema-v1',
};

describe('buildEvaluationSnapshot', () => {
  it('материализует units + metadata, humanReviewed=false всегда', () => {
    const snapshot = buildEvaluationSnapshot(METADATA, [unit()]);
    expect(snapshot.humanReviewed).toBe(false);
    expect(snapshot.units.map((u) => u.unitId)).toEqual(['u1']);
    expect(snapshot.sourceRevisionHash).toBe('source-rev-1');
    expect(snapshot.extractionRunId).toBe('run-2026-08-08T23-00-00Z');
  });

  it('НЕ гейтится никаким manifest — единственная проверка это непустая экстракция (вырожденный "успех" скрыл бы сломанный пайплайн)', () => {
    expect(() => buildEvaluationSnapshot(METADATA, [])).toThrow(/пуст/i);
  });

  it('units с ambiguous-дублями/непройденной идентификацией — не забота этой функции, тот гейт уже прошёл до неё в assignIdentity', () => {
    // buildEvaluationSnapshot не переоткрывает assignIdentity — принимает то,
    // что ему передали, как есть (в отличие от buildReviewedSnapshot, у
    // которого ЕСТЬ committed-manifest гейт).
    expect(() => buildEvaluationSnapshot(METADATA, [unit(), unit({ unitId: 'u2' })])).not.toThrow();
  });
});
