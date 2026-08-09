import { describe, expect, it } from 'vitest';
import { batchSourceBlocks, extractKnowledgeUnitsInBatches, type BatchExtractor } from '../batch-extraction';
import type { SourceBlock } from '../knowledge-unit-extractor';
import type { ExtractedKnowledgeUnit } from '../applicability/extraction';

/**
 * ChatGPT feedback / goal-shift continuation (2026-08-09): a single
 * whole-document extractKnowledgeUnits() call silently omitted rules 5-10
 * on a real run (28 units/10 rules -> 18 units/4 rules, same schema-valid
 * response, no retry trigger since nothing failed validation). Bounding
 * each call's responsibility to a small batch of adjacent blocks makes it
 * structurally harder for the model to "run out of steam" partway through
 * a long single generation and silently drop the tail.
 *
 * Must generalize beyond this fixture — no "10 numbered rules" special
 * casing anywhere in this module.
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

describe('batchSourceBlocks', () => {
  it('делит блоки на группы фиксированного размера, последняя группа может быть короче', () => {
    const blocks = [block('b0', 'x'), block('b1', 'x'), block('b2', 'x'), block('b3', 'x'), block('b4', 'x')];
    const batches = batchSourceBlocks(blocks, 2);
    expect(batches).toHaveLength(3);
    expect(batches[0].map((b) => b.anchor)).toEqual(['b0', 'b1']);
    expect(batches[1].map((b) => b.anchor)).toEqual(['b2', 'b3']);
    expect(batches[2].map((b) => b.anchor)).toEqual(['b4']);
  });

  it('batchSize >= общего числа блоков -> один батч со всеми блоками', () => {
    const blocks = [block('b0', 'x'), block('b1', 'x')];
    expect(batchSourceBlocks(blocks, 10)).toHaveLength(1);
  });

  it('пустой список блоков -> пустой список батчей, не исключение', () => {
    expect(batchSourceBlocks([], 3)).toEqual([]);
  });

  it('batchSize < 1 -> явная ошибка', () => {
    expect(() => batchSourceBlocks([block('b0', 'x')], 0)).toThrow();
  });
});

describe('extractKnowledgeUnitsInBatches — merge + namespacing', () => {
  it('вызывает extractor РОВНО по одному разу на батч, с блоками ИМЕННО этого батча', async () => {
    const blocks = [block('b0', 'x'), block('b1', 'x'), block('b2', 'x')];
    const calls: SourceBlock[][] = [];
    const extractor: BatchExtractor = async (options) => {
      calls.push([...options.blocks]);
      return { units: [], structuredResult: {} as never };
    };
    await extractKnowledgeUnitsInBatches(blocks, 2, { runConfig: {} as never }, extractor);
    expect(calls).toHaveLength(2);
    expect(calls[0].map((b) => b.anchor)).toEqual(['b0', 'b1']);
    expect(calls[1].map((b) => b.anchor)).toEqual(['b2']);
  });

  it('одинаковый extractionRef ("u1") в ДВУХ разных батчах -> namespaced по-разному, не коллизирует после merge', async () => {
    const blocks = [block('b0', 'x'), block('b1', 'x')];
    const extractor: BatchExtractor = async (options) => ({
      units: [unit({ extractionRef: 'u1', sourceSpan: { anchor: options.blocks[0].anchor, quote: 'x' } })],
      structuredResult: {} as never,
    });
    const result = await extractKnowledgeUnitsInBatches(blocks, 1, { runConfig: {} as never }, extractor);
    expect(result.units).toHaveLength(2);
    const refs = result.units.map((u) => u.extractionRef);
    expect(new Set(refs).size).toBe(2); // не коллизируют
  });

  it('parentExtractionRef ВНУТРИ одного батча резолвится корректно после namespacing', async () => {
    const blocks = [block('b0', 'x')];
    const extractor: BatchExtractor = async () => ({
      units: [
        unit({ extractionRef: 'parent', parentExtractionRef: null }),
        unit({ extractionRef: 'child', parentExtractionRef: 'parent' }),
      ],
      structuredResult: {} as never,
    });
    const result = await extractKnowledgeUnitsInBatches(blocks, 1, { runConfig: {} as never }, extractor);
    const child = result.units.find((u) => u.extractionRef.endsWith('child'))!;
    const parent = result.units.find((u) => u.extractionRef.endsWith('parent'))!;
    expect(child.parentExtractionRef).toBe(parent.extractionRef);
    // Ни один DANGLING_PARENT_REF не добавлен -- связь разрешилась.
    expect(child.uncertainties.some((u) => u.kind === 'DANGLING_PARENT_REF')).toBe(false);
  });

  it('parentExtractionRef, указывающий на unit ДРУГОГО батча, структурно невозможен -- модель никогда не видела чужой батч, поэтому такая ссылка попросту не может быть сгенерирована; здесь проверяем, что merge не пытается угадать связь через границу батчей', async () => {
    const blocks = [block('b0', 'x'), block('b1', 'x')];
    const extractor: BatchExtractor = async (options) => ({
      units: [unit({ extractionRef: 'u1', sourceSpan: { anchor: options.blocks[0].anchor, quote: 'x' } })],
      structuredResult: {} as never,
    });
    const result = await extractKnowledgeUnitsInBatches(blocks, 1, { runConfig: {} as never }, extractor);
    // Оба unit'а самостоятельны (parentExtractionRef null) -- ничего не связано через границу батчей.
    expect(result.units.every((u) => u.parentExtractionRef === null)).toBe(true);
  });

  it('пустой список блоков -> пустой merged результат, extractor не вызывается', async () => {
    let called = false;
    const extractor: BatchExtractor = async () => {
      called = true;
      return { units: [], structuredResult: {} as never };
    };
    const result = await extractKnowledgeUnitsInBatches([], 3, { runConfig: {} as never }, extractor);
    expect(result.units).toEqual([]);
    expect(called).toBe(false);
  });

  it('batchLogs репортит per-batch unit count и охваченные anchor -- диагностика, не догадка', async () => {
    const blocks = [block('b0', 'x'), block('b1', 'x'), block('b2', 'x')];
    const extractor: BatchExtractor = async (options) => ({
      units: options.blocks.map((b, i) => unit({ extractionRef: `u${i}`, sourceSpan: { anchor: b.anchor, quote: 'x' } })),
      structuredResult: {} as never,
    });
    const result = await extractKnowledgeUnitsInBatches(blocks, 2, { runConfig: {} as never }, extractor);
    expect(result.batchLogs).toHaveLength(2);
    expect(result.batchLogs[0]).toMatchObject({ batchIndex: 0, blockAnchors: ['b0', 'b1'], unitCount: 2 });
    expect(result.batchLogs[1]).toMatchObject({ batchIndex: 1, blockAnchors: ['b2'], unitCount: 1 });
  });
});
