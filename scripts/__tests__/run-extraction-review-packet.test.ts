import { describe, expect, it } from 'vitest';
import { buildReviewPacket } from '../run-extraction';
import type { PersistedKnowledgeUnit } from '../../src/lib/knowledge/applicability/identity-assignment';
import type { SourceBlockLocation } from '../../src/lib/knowledge/applicability/identity-assignment';

/**
 * translation-yz9 continuation, Step 5 (независимое ревью PR #76): аудит
 * полноты review-packet.json. Раннер производит EDINSTVENNYY артефакт,
 * который видит oracle-blind ревьюер (`buildReviewPacket`, docstring
 * `run-extraction.ts`) — если в нём не хватает поля, человек одобряет
 * структуру ВСЛЕПУЮ относительно того, что реально попадёт в
 * `reviewedUnitHash` (тот хэширует ВЕСЬ `PersistedKnowledgeUnit`,
 * `review-manifest.ts`). Требуемые поля (список ревью): unitId,
 * sourceBlockAnchor, structuralPath, contentHash, reviewedUnitHash inputs
 * (полностью — включая evidenceByField, не только sourceSpan.quote), exact
 * quote, block text, offsets, parentRuleRef, facets, triggerCondition,
 * numericConstraint, uncertainties, canonical source hashes. И НИ ОДНОГО
 * oracle-derived поля (sourceRuleId добавляется evaluation-слоем ПОСЛЕ
 * человеческого ревью, не раньше).
 */

const BLOCK: SourceBlockLocation = {
  anchor: 'b0',
  text: 'Раздражение кожи снимают в уединённом месте. Не более 3 дней подряд.',
  sectionPath: 'Раздел 1',
  structuralPath: 'body/p[0]',
  blockStart: 100,
  blockEnd: 170,
};

function unit(overrides: Partial<PersistedKnowledgeUnit> = {}): PersistedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'Раздражение кожи снимают в уединённом месте.',
    facets: { scenario: 'apostille.zags.spb' },
    triggerCondition: { all: [{ fact: 'helperPresent', equals: true }] },
    numericConstraint: { factKey: 'максимум суток', value: 3, unit: 'сутки' },
    parentRuleRef: null,
    sourceSpan: { anchor: 'b0', quote: 'уединённом месте' },
    evidenceByField: {
      statement: { anchor: 'b0', quote: 'уединённом месте' },
      numericConstraint: { anchor: 'b0', quote: 'Не более 3 дней подряд' },
    },
    uncertainties: [],
    sourceBlockAnchor: 'anchor-hash-16char',
    unitId: 'unit-hash-16char',
    contentHash: 'content-hash-16ch',
    ...overrides,
  };
}

const CANONICAL_SOURCE = {
  sourceRevisionHash: 'rev-hash-abc123',
  canonicalTextHash: 'text-hash-def456',
  parserVersion: '2.0.0',
};

describe('buildReviewPacket — полнота полей для oracle-blind ревьюера (Step 5, независимое ревью PR #76)', () => {
  it('пакет верхнего уровня содержит canonical source hashes — ревьюер обязан видеть, к какой ревизии источника относится ревью, не открывая отдельный файл', () => {
    const packet = buildReviewPacket([unit()], new Map([['b0', BLOCK]]), CANONICAL_SOURCE);
    expect(packet.canonicalSource).toEqual(CANONICAL_SOURCE);
  });

  it('каждый unit содержит offsets (абсолютные, в canonicalText) — не только blockText целиком', () => {
    const packet = buildReviewPacket([unit()], new Map([['b0', BLOCK]]), CANONICAL_SOURCE);
    const entry = packet.units[0];
    // "уединённом месте" начинается на индексе 27 внутри BLOCK.text, blockStart=100.
    const localStart = BLOCK.text.indexOf('уединённом месте');
    expect(entry.offsets).toEqual({
      start: BLOCK.blockStart + localStart,
      end: BLOCK.blockStart + localStart + 'уединённом месте'.length,
    });
  });

  it('каждый unit содержит evidenceByField целиком — reviewedUnitHash хэширует ВСЮ структуру unit\'а, включая evidence по facets/triggerCondition/numericConstraint, не только sourceSpan.quote', () => {
    const testUnit = unit();
    const packet = buildReviewPacket([testUnit], new Map([['b0', BLOCK]]), CANONICAL_SOURCE);
    expect(packet.units[0].evidenceByField).toEqual(testUnit.evidenceByField);
  });

  it('НИ ОДИН unit не содержит sourceRuleId или иное oracle-derived поле — sourceRuleId добавляется evaluation-слоем ПОСЛЕ человеческого ревью, не раньше', () => {
    const packet = buildReviewPacket([unit()], new Map([['b0', BLOCK]]), CANONICAL_SOURCE);
    for (const entry of packet.units) {
      expect(entry).not.toHaveProperty('sourceRuleId');
    }
    expect(JSON.stringify(packet)).not.toContain('sourceRuleId');
  });

  it('остальные ранее существовавшие поля не потеряны при добавлении новых (регрессия)', () => {
    const packet = buildReviewPacket([unit()], new Map([['b0', BLOCK]]), CANONICAL_SOURCE);
    const entry = packet.units[0];
    expect(entry.unitId).toBe('unit-hash-16char');
    expect(entry.sourceBlockAnchor).toBe('anchor-hash-16char');
    expect(entry.contentHash).toBe('content-hash-16ch');
    expect(entry.structuralPath).toBe('body/p[0]');
    expect(entry.parentRuleRef).toBeNull();
    expect(entry.facets).toEqual({ scenario: 'apostille.zags.spb' });
    expect(entry.triggerCondition).toEqual({ all: [{ fact: 'helperPresent', equals: true }] });
    expect(entry.numericConstraint).toEqual({ factKey: 'максимум суток', value: 3, unit: 'сутки' });
    expect(entry.uncertainties).toEqual([]);
    expect(entry.blockText).toBe(BLOCK.text);
  });
});
