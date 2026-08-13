import { describe, expect, it } from 'vitest';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';
import { computeReviewedUnitHash, type ReviewManifestEntry } from '../review-manifest';
import { buildReviewedSnapshot, type SnapshotProvenance } from '../reviewed-snapshot';

/**
 * translation-bqt — реализация docs/plans/2026-08-08-reviewed-snapshot-vs-drift-gate-design.md.
 *
 * `buildReviewedSnapshot` — тонкая обёртка над `applyReviewManifest`
 * (семантика Gate 1 БЕЗ ИЗМЕНЕНИЙ, design note §"Что НЕ меняется"):
 * материализует `confirmed` в иммутабельный артефакт с provenance, вместо
 * того чтобы вызывающий код каждый раз заново гонял qualification.
 */

const span = (anchor: string, quote: string) => ({ anchor, quote });

function unit(overrides: Partial<PersistedKnowledgeUnit> = {}): PersistedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'Не дольше 15 секунд подряд.',
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    parentRuleRef: null,
    sourceSpan: span('anchor-1', 'не дольше 15 секунд'),
    evidenceByField: { statement: span('anchor-1', 'не дольше 15 секунд') },
    uncertainties: [],
    sourceBlockAnchor: 'block-1',
    unitId: 'u1',
    contentHash: 'hash-1',
    ...overrides,
  };
}

function entry(overrides: Partial<ReviewManifestEntry> = {}): ReviewManifestEntry {
  return {
    sourceRuleId: 4,
    unitId: 'u1',
    sourceAnchor: 'block-1',
    decision: 'ACCEPT',
    reviewedContentHash: 'hash-1',
    reviewedUnitHash: computeReviewedUnitHash(unit()),
    reviewedBy: 'fixture-reviewer',
    reviewedAt: '2026-08-07T00:00:00+03:00',
    ...overrides,
  };
}

const PROVENANCE: SnapshotProvenance = {
  sourceRevisionHash: 'source-rev-1',
  parserVersion: '2.0.0',
  extractionProvider: 'anthropic',
  extractionModel: 'claude-haiku-4-5-20251001',
  extractionPromptVersion: 'test-prompt-v1',
  extractionSchemaVersion: 'test-schema-v1',
};

describe('buildReviewedSnapshot — успешная материализация', () => {
  it('Gate 1 пройден -> snapshot содержит confirmed units + provenance + qualifiedAt', () => {
    const result = buildReviewedSnapshot([unit()], [entry()], PROVENANCE, '2026-08-08T00:00:00Z');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.units.map((u) => u.unitId)).toEqual(['u1']);
    expect(result.snapshot.sourceRevisionHash).toBe('source-rev-1');
    expect(result.snapshot.parserVersion).toBe('2.0.0');
    expect(result.snapshot.extractionProvider).toBe('anthropic');
    expect(result.snapshot.extractionModel).toBe('claude-haiku-4-5-20251001');
    expect(result.snapshot.qualifiedAt).toBe('2026-08-08T00:00:00Z');
  });

  it('REJECT-нутые units не попадают в snapshot (та же семантика confirmed, что и applyReviewManifest)', () => {
    const result = buildReviewedSnapshot(
      [unit()],
      [entry({ decision: 'REJECT' })],
      PROVENANCE,
      '2026-08-08T00:00:00Z'
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshot.units).toEqual([]);
  });

  it('sourceRuleByUnitId возвращается ОТДЕЛЬНО от snapshot.units — не смешивается с engine-входом', () => {
    const result = buildReviewedSnapshot([unit()], [entry({ sourceRuleId: 4 })], PROVENANCE, '2026-08-08T00:00:00Z');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sourceRuleByUnitId.get('u1')).toBe(4);
    for (const u of result.snapshot.units) {
      expect(u).not.toHaveProperty('sourceRuleId');
    }
  });
});

describe('buildReviewedSnapshot — Gate 1 семантика НЕ ослаблена (design note: "что не меняется")', () => {
  it('провал applyReviewManifest -> snapshot НЕ создаётся, failures пробрасываются как есть', () => {
    const result = buildReviewedSnapshot(
      [unit({ contentHash: 'DRIFTED' })],
      [entry()],
      PROVENANCE,
      '2026-08-08T00:00:00Z'
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failures.map((f) => f.code)).toContain('content_hash_changed');
  });

  it('частичное совпадение (10 из 41 units дрейфовали) — snapshot ВСЁ РАВНО не создаётся целиком, не "частичный snapshot"', () => {
    const stable = unit({ unitId: 'stable', contentHash: 'h-stable' });
    const drifted = unit({ unitId: 'drifted', contentHash: 'DRIFTED', sourceSpan: span('anchor-2', 'x') });
    const stableEntry = entry({ unitId: 'stable', reviewedContentHash: 'h-stable', reviewedUnitHash: computeReviewedUnitHash(stable) });
    const driftedEntry = entry({ unitId: 'drifted', sourceAnchor: 'anchor-2', reviewedContentHash: 'h-was', reviewedUnitHash: 'irrelevant' });

    const result = buildReviewedSnapshot([stable, drifted], [stableEntry, driftedEntry], PROVENANCE, '2026-08-08T00:00:00Z');
    expect(result.ok).toBe(false);
  });
});
