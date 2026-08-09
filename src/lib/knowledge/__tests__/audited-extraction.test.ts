import { describe, expect, it } from 'vitest';
import { extractKnowledgeUnitsWithCompletenessAudit } from '../audited-extraction';
import type { SourceBlock } from '../knowledge-unit-extractor';
import type { ExtractedKnowledgeUnit } from '../applicability/extraction';
import type { BlockCoverageAuditResult } from '../extraction-coverage-auditor';

/**
 * Goal-shift continuation (2026-08-09), Task 19: composes batch-extraction
 * (Task 18) with the oracle-blind coverage auditor. On a confirmed gap, ONE
 * bounded focused retry for just that block -- never a loop, never "retry
 * until the benchmark score improves" (explicitly forbidden by the task).
 */

const block = (anchor: string, text: string): SourceBlock => ({ anchor, text });

function unit(overrides: Partial<ExtractedKnowledgeUnit> = {}): ExtractedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'заполнитель',
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    extractionRef: 'u1',
    parentExtractionRef: null,
    sourceSpan: { anchor: 'a', quote: 'заполнитель' },
    evidenceByField: { statement: { anchor: 'a', quote: 'заполнитель' } },
    uncertainties: [],
    ...overrides,
  };
}

describe('extractKnowledgeUnitsWithCompletenessAudit', () => {
  it('без gap-ов -> initial units как есть, ни одного focused retry не запущено', async () => {
    const blocks = [block('b0', 'текст первого блока')];
    let extractorCalls = 0;
    const extractor = async (options: { blocks: readonly SourceBlock[] }) => {
      extractorCalls++;
      return {
        units: [unit({ sourceSpan: { anchor: options.blocks[0].anchor, quote: 'текст' } })],
        structuredResult: {} as never,
      };
    };
    const auditor = async (): Promise<BlockCoverageAuditResult> => ({
      blockAnchor: 'b0',
      findings: [{ verdict: 'COVERED', quote: '', explanation: 'x', quoteVerified: false }],
      hasGap: false,
    });

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      blocks,
      5,
      { runConfig: {} as never },
      {} as never,
      { extractor, auditor }
    );

    expect(extractorCalls).toBe(1); // только основной batch-проход, ни одного focused retry
    expect(result.units).toHaveLength(1);
    expect(result.focusedRetryLogs).toEqual([]);
  });

  it('hasGap=true на блоке -> ровно ОДИН focused retry именно для этого блока, результат добавляется к units', async () => {
    const blocks = [block('b0', 'текст первого блока'), block('b1', 'текст второго блока')];
    const extractorCallBlocks: string[][] = [];
    const extractor = async (options: { blocks: readonly SourceBlock[] }) => {
      extractorCallBlocks.push(options.blocks.map((b) => b.anchor));
      if (options.blocks.length === 1 && options.blocks[0].anchor === 'b1' && extractorCallBlocks.length > 1) {
        // focused retry for b1
        return {
          units: [unit({ extractionRef: 'found-it', sourceSpan: { anchor: 'b1', quote: 'найденный пропуск' } })],
          structuredResult: {} as never,
        };
      }
      return {
        units: options.blocks.map((b, i) => unit({ extractionRef: `u${i}`, sourceSpan: { anchor: b.anchor, quote: 'текст' } })),
        structuredResult: {} as never,
      };
    };
    const auditor = async (opts: { blockAnchor: string }): Promise<BlockCoverageAuditResult> => ({
      blockAnchor: opts.blockAnchor,
      findings:
        opts.blockAnchor === 'b1'
          ? [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'найденный пропуск', explanation: 'пропущено', quoteVerified: true }]
          : [{ verdict: 'COVERED', quote: '', explanation: 'x', quoteVerified: false }],
      hasGap: opts.blockAnchor === 'b1',
    });

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      blocks,
      5,
      { runConfig: {} as never },
      {} as never,
      { extractor, auditor }
    );

    expect(result.focusedRetryLogs).toHaveLength(1);
    expect(result.focusedRetryLogs[0].blockAnchor).toBe('b1');
    expect(result.units.some((u) => u.statement === 'заполнитель' && u.sourceSpan.quote === 'найденный пропуск')).toBe(true);
    // Focused-retry unit's extractionRef namespaced distinctly, not colliding with the original batch pass.
    const focusedUnit = result.units.find((u) => u.sourceSpan.quote === 'найденный пропуск')!;
    expect(focusedUnit.extractionRef).toContain('focused');
    expect(focusedUnit.parentExtractionRef).toBeNull();
  });

  it('auditResults покрывает КАЖДЫЙ блок ровно один раз, независимо от количества батчей', async () => {
    const blocks = [block('b0', 'x'), block('b1', 'x'), block('b2', 'x')];
    const extractor = async (options: { blocks: readonly SourceBlock[] }) => ({
      units: options.blocks.map((b, i) => unit({ extractionRef: `u${i}`, sourceSpan: { anchor: b.anchor, quote: 'x' } })),
      structuredResult: {} as never,
    });
    const auditedAnchors: string[] = [];
    const auditor = async (opts: { blockAnchor: string }): Promise<BlockCoverageAuditResult> => {
      auditedAnchors.push(opts.blockAnchor);
      return { blockAnchor: opts.blockAnchor, findings: [], hasGap: false };
    };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      blocks,
      2,
      { runConfig: {} as never },
      {} as never,
      { extractor, auditor }
    );

    expect(auditedAnchors).toEqual(['b0', 'b1', 'b2']);
    expect(result.auditResults).toHaveLength(3);
  });

  it('блок без ни одного extracted unit\'а всё равно проходит аудит (пустой extractedStatements)', async () => {
    const blocks = [block('b0', 'преамбула без содержательных правил')];
    const extractor = async () => ({ units: [], structuredResult: {} as never });
    let auditedWithEmptyStatements = false;
    const auditor = async (opts: { extractedStatements: readonly unknown[] }): Promise<BlockCoverageAuditResult> => {
      if (opts.extractedStatements.length === 0) auditedWithEmptyStatements = true;
      return { blockAnchor: 'b0', findings: [], hasGap: false };
    };

    await extractKnowledgeUnitsWithCompletenessAudit(blocks, 5, { runConfig: {} as never }, {} as never, {
      extractor,
      auditor,
    });

    expect(auditedWithEmptyStatements).toBe(true);
  });
});
