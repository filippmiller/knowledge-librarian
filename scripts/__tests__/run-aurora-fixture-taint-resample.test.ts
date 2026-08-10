import { describe, expect, it, vi } from 'vitest';

import { assertTrustedIdentity, resolveTaintedCandidates } from '../run-aurora-fixture';
import { assignIdentity, type SourceBlockLocation } from '../../src/lib/knowledge/applicability/identity-assignment';
import type { ExtractedKnowledgeUnit } from '../../src/lib/knowledge/applicability/extraction';
import { OracleTaintError, type OracleTaintDetector } from '../../src/lib/eval/oracle-taint';

const BLOCK: SourceBlockLocation = {
  anchor: 'block-A',
  text: 'Основное правило. Обязательное исключение.',
  sectionPath: 'section.1',
  structuralPath: 'body/p[0]',
  blockStart: 0,
  blockEnd: 42,
};

function extracted(overrides: Partial<ExtractedKnowledgeUnit> = {}): ExtractedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'tainted основное правило',
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    extractionRef: 'root',
    parentExtractionRef: null,
    sourceSpan: { anchor: BLOCK.anchor, quote: 'Основное правило.' },
    evidenceByField: { statement: { anchor: BLOCK.anchor, quote: 'Основное правило.' } },
    uncertainties: [],
    ...overrides,
  };
}

const detector: OracleTaintDetector = {
  assertClean(payload) {
    if (JSON.stringify(payload).includes('tainted')) throw new OracleTaintError('tainted');
  },
  taintedShingleCount: 1,
  secretCoverage: [],
  unguardedSecretCount: 0,
};

const runConfig = {
  provider: 'openai' as const,
  model: 'test-model',
  promptVersion: 'test-prompt',
  extractionSchemaVersion: 'test-schema',
  fallbackPolicy: 'NONE' as const,
};

describe('targeted taint resample completeness gate', () => {
  it('rejects a clean-worded replacement that silently loses a source clause', async () => {
    const initial = assignIdentity([extracted()], new Map([[BLOCK.anchor, BLOCK]]), 'rev-1').units;
    const extractor = vi.fn(async () => ({
      units: [extracted({ statement: 'Основное правило', extractionRef: 'replacement' })],
      attempts: [],
      structuredResult: {} as never,
    }));
    const auditor = vi.fn(async () => ({
      blockAnchor: BLOCK.anchor,
      findings: [{
        verdict: 'UNREPRESENTED_CLAUSE' as const,
        quote: 'Обязательное исключение.',
        explanation: 'Исключение потеряно при замене.',
        quoteVerified: true,
      }],
      hasGap: true,
      unresolved: false,
    }));

    await expect(resolveTaintedCandidates(
      initial,
      new Map([[BLOCK.anchor, BLOCK]]),
      'rev-1',
      detector,
      extractor,
      auditor,
      { runConfig, maxTokens: 100 },
      1
    )).rejects.toThrow('did not pass coverage audit');

    expect(auditor).toHaveBeenCalledWith(expect.objectContaining({
      blockAnchor: BLOCK.anchor,
      blockText: BLOCK.text,
      extractedStatements: [{ statement: 'Основное правило', quote: 'Основное правило.' }],
    }));
  });

  it('rebuilds replacement identity and clears parent references to removed units', async () => {
    const oldParent = assignIdentity([extracted()], new Map([[BLOCK.anchor, BLOCK]]), 'rev-1').units[0];
    const dependent = {
      ...oldParent,
      unitId: 'unaffected-child',
      sourceSpan: { anchor: 'block-B', quote: 'Дочернее правило.' },
      parentRuleRef: oldParent.unitId,
    };
    const extractor = vi.fn(async () => ({
      units: [extracted({
        statement: 'Безопасное обязательное исключение',
        kind: 'EXCEPTION_RULE',
        extractionRef: 'replacement',
        sourceSpan: { anchor: BLOCK.anchor, quote: 'Обязательное исключение.' },
        evidenceByField: { statement: { anchor: BLOCK.anchor, quote: 'Обязательное исключение.' } },
      })],
      attempts: [],
      structuredResult: {} as never,
    }));
    const auditor = vi.fn(async () => ({
      blockAnchor: BLOCK.anchor,
      findings: [{ verdict: 'COVERED' as const, quote: '', explanation: '', quoteVerified: false }],
      hasGap: false,
      unresolved: false,
    }));

    const result = await resolveTaintedCandidates(
      [oldParent, dependent],
      new Map([[BLOCK.anchor, BLOCK]]),
      'rev-1',
      detector,
      extractor,
      auditor,
      { runConfig, maxTokens: 100 },
      1
    );

    const replacement = result.units.find((u) => u.sourceSpan.anchor === BLOCK.anchor)!;
    expect(replacement.unitId).not.toBe(oldParent.unitId);
    expect(replacement.contentHash).not.toBe(oldParent.contentHash);
    expect(result.units.find((u) => u.unitId === dependent.unitId)?.parentRuleRef).toBeNull();
    expect(result.auditResults).toHaveLength(1);
  });

  it('rejects an audited replacement whose evidence cannot be persisted', async () => {
    const initial = assignIdentity([extracted()], new Map([[BLOCK.anchor, BLOCK]]), 'rev-1').units;
    const extractor = vi.fn(async () => ({
      units: [extracted({
        statement: 'Безопасная формулировка',
        extractionRef: 'replacement',
        sourceSpan: { anchor: BLOCK.anchor, quote: 'Цитаты нет в блоке' },
        evidenceByField: { statement: { anchor: BLOCK.anchor, quote: 'Цитаты нет в блоке' } },
      })],
      structuredResult: {} as never,
    }));
    const auditor = vi.fn(async () => ({
      blockAnchor: BLOCK.anchor,
      findings: [{ verdict: 'COVERED' as const, quote: '', explanation: '', quoteVerified: false }],
      hasGap: false,
      unresolved: false,
    }));

    await expect(resolveTaintedCandidates(
      initial,
      new Map([[BLOCK.anchor, BLOCK]]),
      'rev-1',
      detector,
      extractor,
      auditor,
      { runConfig, maxTokens: 100 },
      1
    )).rejects.toThrow('1 unresolved evidence');
  });

  it('rejects ambiguous identity diagnostics on the initial extraction path', () => {
    const duplicateIdentity = assignIdentity(
      [extracted({ extractionRef: 'one' }), extracted({ extractionRef: 'two' })],
      new Map([[BLOCK.anchor, BLOCK]]),
      'rev-1'
    );

    expect(() => assertTrustedIdentity(duplicateIdentity, 'initial extraction'))
      .toThrow('1 ambiguous duplicate group');
  });
});
