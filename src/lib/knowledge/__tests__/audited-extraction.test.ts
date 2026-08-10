import { describe, expect, it, vi } from 'vitest';
import {
  buildFocusedRepairPromptMessages,
  extractKnowledgeUnitsWithCompletenessAudit,
} from '../audited-extraction';
import { buildExtractionPromptMessages, type SourceBlock } from '../knowledge-unit-extractor';
import type { ExtractedKnowledgeUnit } from '../applicability/extraction';
import type { BlockCoverageAuditResult, CoverageFinding } from '../extraction-coverage-auditor';

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

function repairUsing(extractor: (options: { blocks: readonly SourceBlock[] }) => Promise<{ units: ExtractedKnowledgeUnit[]; structuredResult: never }>) {
  return ({ block: sourceBlock }: { block: SourceBlock }) => extractor({ blocks: [sourceBlock] });
}

describe('extractKnowledgeUnitsWithCompletenessAudit', () => {
  it('focused repair prompt ограничен findings и не включает полный extraction prompt', () => {
    const source = block('b0', 'Сотрудникам можно войти, посетителям запрещено.');
    const messages = buildFocusedRepairPromptMessages({
      block: source,
      findings: [{
        verdict: 'UNREPRESENTED_CLAUSE',
        quote: 'посетителям запрещено',
        explanation: 'пропущен запрет',
        quoteVerified: true,
      }],
      existingUnits: [unit({ statement: 'Сотрудникам можно войти.', sourceSpan: { anchor: 'b0', quote: 'Сотрудникам можно войти' } })],
    });
    const compact = messages.map((message) => message.content).join('\n');
    const full = buildExtractionPromptMessages([source]).map((message) => message.content).join('\n');

    expect(compact).toContain('посетителям запрещено');
    expect(compact).toContain('Сотрудникам можно войти.');
    expect(compact).not.toContain('Каждая единица знания (unit) имеет один из видов');
    expect(compact.length).toBeLessThan(full.length / 2);
  });

  it('b2 regression: оговорка не приглашает kind=fact/disclaimer и получает точные enum/object контракты', () => {
    const messages = buildFocusedRepairPromptMessages({
      block: {
        anchor: 'b2',
        text: 'Информация носит справочный характер и не заменяет консультацию специалиста.',
      },
      findings: [{
        verdict: 'UNREPRESENTED_CLAUSE',
        quote: 'не заменяет консультацию специалиста',
        explanation: 'Пропущена существенная оговорка.',
        quoteVerified: true,
      }],
      existingUnits: [],
    });
    const prompt = messages.map((message) => message.content).join('\n');

    expect(prompt).toContain('"PROCEDURE_STEP", "EXCEPTION_RULE", "TERM_DEFINITION", "DELIVERY_RULE", "PRICE_RULE"');
    expect(prompt).toContain('Значения "fact", "disclaimer", "rule", "note" и любые другие ЗАПРЕЩЕНЫ');
    expect(prompt).toContain('"sourceSpan":{"anchor":"ДАННЫЙ_ANCHOR","quote":"ДОСЛОВНАЯ ЦИТАТА"}');
    expect(prompt).toContain('uncertainties — всегда массив объектов ТОЧНО формы');
    expect(prompt).toContain('"UNRECOGNIZED_TRIGGER_CONDITION"');
    expect(prompt).toContain('Anchor: b2');
    expect(prompt).toContain('не заменяет консультацию специалиста');
  });

  it('использует отдельный finding-scoped repair extractor, не полный batch extractor', async () => {
    let initialExtractorCalls = 0;
    let repairExtractorCalls = 0;
    let auditCalls = 0;
    const extractor = async () => {
      initialExtractorCalls++;
      return {
        units: [unit({ statement: 'Исходное правило.', sourceSpan: { anchor: 'b0', quote: 'Исходное правило' } })],
        structuredResult: {} as never,
      };
    };
    const repairExtractor = async (options: { findings: readonly CoverageFinding[]; existingUnits: readonly ExtractedKnowledgeUnit[] }) => {
      repairExtractorCalls++;
      expect(options.findings.map((finding) => finding.verdict)).toEqual(['UNREPRESENTED_CLAUSE']);
      expect(options.existingUnits.map((existing) => existing.statement)).toEqual(['Исходное правило.']);
      return {
        units: [unit({ statement: 'Пропущенное правило.', extractionRef: 'repair', sourceSpan: { anchor: 'b0', quote: 'Пропущенное правило' } })],
        structuredResult: {} as never,
      };
    };
    const auditor = async (): Promise<BlockCoverageAuditResult> =>
      ++auditCalls === 1
        ? {
            blockAnchor: 'b0',
            findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'Пропущенное правило', explanation: 'gap', quoteVerified: true }],
            hasGap: true,
          }
        : { blockAnchor: 'b0', findings: [{ verdict: 'COVERED', quote: '', explanation: 'ok', quoteVerified: false }], hasGap: false };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      [block('b0', 'Исходное правило. Пропущенное правило.')],
      5,
      { runConfig: {} as never },
      {} as never,
      { extractor, repairExtractor, auditor }
    );

    expect(initialExtractorCalls).toBe(1);
    expect(repairExtractorCalls).toBe(1);
    expect(auditCalls).toBe(2);
    expect(result.units.map((item) => item.statement)).toContain('Пропущенное правило.');
  });

  it.each([
    {
      name: 'вложенный запрет в широкой evidence-цитате',
      text: 'Сотрудникам вход разрешён, но посетителям вход запрещён.',
      initial: 'Сотрудникам вход разрешён.',
      recovered: 'Посетителям вход запрещён.',
      quote: 'посетителям вход запрещён',
    },
    {
      name: 'отдельное числовое ограничение',
      text: 'Подайте заявление. Срок — не более трёх дней.',
      initial: 'Необходимо подать заявление.',
      recovered: 'Срок подачи ограничен тремя днями.',
      quote: 'не более трёх дней',
    },
    {
      name: 'исключение из общего правила',
      text: 'Нужен оригинал. Для электронного документа допустима распечатка.',
      initial: 'Нужен оригинал.',
      recovered: 'Для электронного документа допустима распечатка.',
      quote: 'Для электронного документа допустима распечатка',
    },
  ])('seeded omission: $name восстанавливается compact repair и проходит merge re-audit', async ({ text, initial, recovered, quote }) => {
    const initialExtractor = async () => ({
      units: [unit({ statement: initial, sourceSpan: { anchor: 'b0', quote: text } })],
      structuredResult: {} as never,
    });
    const repairExtractor = async () => ({
      units: [unit({ statement: recovered, extractionRef: 'repair', sourceSpan: { anchor: 'b0', quote } })],
      structuredResult: {} as never,
    });
    let auditCalls = 0;
    const auditor = async (input: { extractedStatements: readonly { statement: string }[] }): Promise<BlockCoverageAuditResult> => {
      auditCalls++;
      if (auditCalls === 1) {
        return {
          blockAnchor: 'b0',
          findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote, explanation: 'seeded omission', quoteVerified: true }],
          hasGap: true,
        };
      }
      expect(input.extractedStatements.map((statement) => statement.statement)).toEqual([initial, recovered]);
      return {
        blockAnchor: 'b0',
        findings: [{ verdict: 'COVERED', quote: '', explanation: 'recovery complete', quoteVerified: false }],
        hasGap: false,
      };
    };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      [block('b0', text)],
      5,
      { runConfig: {} as never },
      {} as never,
      { extractor: initialExtractor, repairExtractor, auditor }
    );

    expect(result.units.map((item) => item.statement)).toEqual([initial, recovered]);
    expect(result.auditResults).toHaveLength(1);
    expect(result.auditResults[0].findings[0].verdict).toBe('COVERED');
    expect(auditCalls).toBe(2);
  });

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
      { extractor, repairExtractor: repairUsing(extractor), auditor }
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
    let b1Audits = 0;
    const auditor = async (opts: { blockAnchor: string }): Promise<BlockCoverageAuditResult> => {
      if (opts.blockAnchor !== 'b1' || ++b1Audits > 1) {
        return {
          blockAnchor: opts.blockAnchor,
          findings: [{ verdict: 'COVERED', quote: '', explanation: 'x', quoteVerified: false }],
          hasGap: false,
        };
      }
      return {
        blockAnchor: opts.blockAnchor,
        findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'найденный пропуск', explanation: 'пропущено', quoteVerified: true }],
        hasGap: true,
      };
    };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      blocks,
      5,
      { runConfig: {} as never },
      {} as never,
      { extractor, repairExtractor: repairUsing(extractor), auditor }
    );

    expect(result.focusedRetryLogs).toHaveLength(1);
    expect(result.focusedRetryLogs[0].blockAnchor).toBe('b1');
    expect(result.units.some((u) => u.statement === 'заполнитель' && u.sourceSpan.quote === 'найденный пропуск')).toBe(true);
    // Focused-retry unit's extractionRef namespaced distinctly, not colliding with the original batch pass.
    const focusedUnit = result.units.find((u) => u.sourceSpan.quote === 'найденный пропуск')!;
    expect(focusedUnit.extractionRef).toContain('focused');
    expect(focusedUnit.parentExtractionRef).toBeNull();
    expect(b1Audits).toBe(2);
    expect(result.auditResults[1].findings[0].verdict).toBe('COVERED');
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
      return {
        blockAnchor: opts.blockAnchor,
        findings: [{ verdict: 'COVERED', quote: '', explanation: 'покрыто', quoteVerified: false }],
        hasGap: false,
      };
    };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      blocks,
      2,
      { runConfig: {} as never },
      {} as never,
      { extractor, repairExtractor: repairUsing(extractor), auditor }
    );

    expect(auditedAnchors).toEqual(['b0', 'b1', 'b2']);
    expect(result.auditResults).toHaveLength(3);
  });

  it('focused retry, чей quote является ПОДСТРОКОЙ уже покрытого исходного quote -- не добавляется дубликатом', async () => {
    const text = 'Правило: разрешено один раз прижать ладонь через чистую одежду не более чем на три секунды.';
    const blocks = [block('b0', text)];
    let extractorCalls = 0;
    const extractor = async (_options: { blocks: readonly SourceBlock[] }) => {
      extractorCalls++;
      if (extractorCalls === 1) {
        return {
          units: [
            unit({
              extractionRef: 'orig',
              sourceSpan: { anchor: 'b0', quote: 'разрешено один раз прижать ладонь через чистую одежду не более чем на три секунды' },
            }),
          ],
          structuredResult: {} as never,
        };
      }
      // focused retry: re-derives the SAME content, just a shorter (tail) quote window.
      return {
        units: [unit({ extractionRef: 'dup', sourceSpan: { anchor: 'b0', quote: 'не более чем на три секунды' } })],
        structuredResult: {} as never,
      };
    };
    let auditCalls = 0;
    const auditor = async (): Promise<BlockCoverageAuditResult> =>
      ++auditCalls === 1
        ? {
            blockAnchor: 'b0',
            findings: [{ verdict: 'POSSIBLE_OMISSION', quote: 'не более чем на три секунды', explanation: 'x', quoteVerified: true }],
            hasGap: true,
          }
        : { blockAnchor: 'b0', findings: [{ verdict: 'COVERED', quote: '', explanation: 'x', quoteVerified: false }], hasGap: false };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      blocks,
      5,
      { runConfig: {} as never },
      {} as never,
      { extractor, repairExtractor: repairUsing(extractor), auditor }
    );

    expect(result.units).toHaveLength(1);
    expect(result.units[0].extractionRef).toBe('b0-orig');
    expect(result.focusedRetryLogs[0].additionalUnitCount).toBe(0);
  });

  it('focused retry, чей quote СОДЕРЖИТ уже покрытый исходный quote целиком -- тоже не добавляется дубликатом', async () => {
    const text = 'Правило: разрешено один раз прижать ладонь через чистую одежду не более чем на три секунды.';
    const blocks = [block('b0', text)];
    let extractorCalls = 0;
    const extractor = async (_options: { blocks: readonly SourceBlock[] }) => {
      extractorCalls++;
      if (extractorCalls === 1) {
        return {
          units: [
            unit({
              extractionRef: 'orig',
              sourceSpan: { anchor: 'b0', quote: 'разрешено один раз прижать ладонь через чистую одежду не более чем на три секунды' },
            }),
          ],
          structuredResult: {} as never,
        };
      }
      // focused retry: re-derives the SAME content, wrapped in a WIDER quote window.
      return {
        units: [
          unit({
            extractionRef: 'dup-superset',
            sourceSpan: {
              anchor: 'b0',
              quote: 'Правило: разрешено один раз прижать ладонь через чистую одежду не более чем на три секунды.',
            },
          }),
        ],
        structuredResult: {} as never,
      };
    };
    let auditCalls = 0;
    const auditorWithGap = async (): Promise<BlockCoverageAuditResult> =>
      ++auditCalls === 1
        ? {
            blockAnchor: 'b0',
            findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'разрешено', explanation: 'x', quoteVerified: true }],
            hasGap: true,
          }
        : { blockAnchor: 'b0', findings: [{ verdict: 'COVERED', quote: '', explanation: 'x', quoteVerified: false }], hasGap: false };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      blocks,
      5,
      { runConfig: {} as never },
      {} as never,
      { extractor, repairExtractor: repairUsing(extractor), auditor: auditorWithGap }
    );

    expect(result.units).toHaveLength(1);
    expect(result.units[0].extractionRef).toBe('b0-orig');
  });

  it('focused retry, чей quote ПЕРЕСЕКАЕТСЯ (но не вложен) с уже покрытым -- всё равно не добавляется дубликатом', async () => {
    const text = 'Раздел один. Разрешено прижать ладонь через одежду не более трёх секунд, повторно нельзя.';
    const blocks = [block('b0', text)];
    let extractorCalls = 0;
    const extractor = async (_options: { blocks: readonly SourceBlock[] }) => {
      extractorCalls++;
      if (extractorCalls === 1) {
        return {
          units: [
            unit({
              extractionRef: 'orig',
              sourceSpan: { anchor: 'b0', quote: 'Разрешено прижать ладонь через одежду не более трёх секунд' },
            }),
          ],
          structuredResult: {} as never,
        };
      }
      // Overlapping window shifted right: shares "не более трёх секунд, повторно нельзя" territory with `orig`.
      return {
        units: [
          unit({ extractionRef: 'dup-shifted', sourceSpan: { anchor: 'b0', quote: 'не более трёх секунд, повторно нельзя' } }),
        ],
        structuredResult: {} as never,
      };
    };
    let auditCalls = 0;
    const auditor = async (): Promise<BlockCoverageAuditResult> =>
      ++auditCalls === 1
        ? {
            blockAnchor: 'b0',
            findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'повторно нельзя', explanation: 'x', quoteVerified: true }],
            hasGap: true,
          }
        : { blockAnchor: 'b0', findings: [{ verdict: 'COVERED', quote: '', explanation: 'x', quoteVerified: false }], hasGap: false };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      blocks,
      5,
      { runConfig: {} as never },
      {} as never,
      { extractor, repairExtractor: repairUsing(extractor), auditor }
    );

    expect(result.units).toHaveLength(1);
    expect(result.units[0].extractionRef).toBe('b0-orig');
  });

  it('сохраняет repair-unit с новой семантикой, даже если его evidence вложен в уже покрытую широкую цитату', async () => {
    const text = 'Разрешено войти сотрудникам, но посетителям вход запрещён.';
    let extractorCalls = 0;
    const extractor = async () => {
      extractorCalls++;
      return {
        units:
          extractorCalls === 1
            ? [unit({ statement: 'Сотрудникам разрешено войти.', extractionRef: 'allow', sourceSpan: { anchor: 'b0', quote: text } })]
            : [unit({ statement: 'Посетителям вход запрещён.', extractionRef: 'deny', sourceSpan: { anchor: 'b0', quote: 'посетителям вход запрещён' } })],
        structuredResult: {} as never,
      };
    };
    let auditCalls = 0;
    const auditor = async (): Promise<BlockCoverageAuditResult> =>
      ++auditCalls === 1
        ? {
            blockAnchor: 'b0',
            findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'посетителям вход запрещён', explanation: 'запрет пропущен', quoteVerified: true }],
            hasGap: true,
          }
        : {
            blockAnchor: 'b0',
            findings: [{ verdict: 'COVERED', quote: '', explanation: 'всё покрыто', quoteVerified: false }],
            hasGap: false,
          };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      [block('b0', text)], 5, { runConfig: {} as never }, {} as never, {
        extractor,
        repairExtractor: repairUsing(extractor),
        auditor,
      }
    );

    expect(result.units.map((u) => u.statement)).toEqual(['Сотрудникам разрешено войти.', 'Посетителям вход запрещён.']);
    expect(result.focusedRetryLogs[0].additionalUnitCount).toBe(1);
  });

  it.each([
    [[{ verdict: 'AMBIGUOUS' as const, quote: 'спорный текст', explanation: 'не уверен', quoteVerified: true }]],
    [[]],
  ])('не выпускает блок без явного COVERED: findings=%j', async (findings) => {
    const extractor = async () => ({ units: [], structuredResult: {} as never });
    const auditor = async (): Promise<BlockCoverageAuditResult> => ({ blockAnchor: 'b0', findings, hasGap: false });

    await expect(
      extractKnowledgeUnitsWithCompletenessAudit(
        [block('b0', 'спорный текст')], 5, { runConfig: {} as never }, {} as never, { extractor, auditor }
      )
    ).rejects.toThrow(/coverage audit did not clear block b0/i);
  });

  it('не выпускает блок, если focused repair не прошёл повторный аудит', async () => {
    let auditCalls = 0;
    const extractor = async () => ({
      units: [unit({ sourceSpan: { anchor: 'b0', quote: 'правило' } })],
      structuredResult: {} as never,
    });
    const auditor = async (): Promise<BlockCoverageAuditResult> => {
      auditCalls++;
      return {
        blockAnchor: 'b0',
        findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'правило', explanation: 'всё ещё пропущено', quoteVerified: true }],
        hasGap: true,
      };
    };

    await expect(
      extractKnowledgeUnitsWithCompletenessAudit(
        [block('b0', 'правило')], 5, { runConfig: {} as never }, {} as never, {
          extractor,
          repairExtractor: repairUsing(extractor),
          auditor,
        }
      )
    ).rejects.toThrow(/focused repair did not clear block b0/i);
    expect(auditCalls).toBe(2);
  });

  it('блок без ни одного extracted unit\'а всё равно проходит аудит (пустой extractedStatements)', async () => {
    const blocks = [block('b0', 'преамбула без содержательных правил')];
    const extractor = async () => ({ units: [], structuredResult: {} as never });
    let auditedWithEmptyStatements = false;
    const auditor = async (opts: { extractedStatements: readonly unknown[] }): Promise<BlockCoverageAuditResult> => {
      if (opts.extractedStatements.length === 0) auditedWithEmptyStatements = true;
      return {
        blockAnchor: 'b0',
        findings: [{ verdict: 'COVERED', quote: '', explanation: 'покрыто', quoteVerified: false }],
        hasGap: false,
      };
    };

    await extractKnowledgeUnitsWithCompletenessAudit(blocks, 5, { runConfig: {} as never }, {} as never, {
      extractor,
      auditor,
    });

    expect(auditedWithEmptyStatements).toBe(true);
  });

  it('передаёт canonical kind аудитору, не исключая HEADING из проверки', async () => {
    const heading: SourceBlock = {
      anchor: 'b1',
      text: 'Порядок безопасного устранения зуда в ягодичной области',
      kind: 'HEADING',
    };
    const extractor = async () => ({ units: [], structuredResult: {} as never });
    const auditor = vi.fn(async (): Promise<BlockCoverageAuditResult> => ({
      blockAnchor: 'b1',
      findings: [{ verdict: 'COVERED', quote: '', explanation: 'тематический заголовок', quoteVerified: false }],
      hasGap: false,
    }));

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      [heading], 5, { runConfig: {} as never }, {} as never, { extractor, auditor }
    );

    expect(auditor).toHaveBeenCalledWith(expect.objectContaining({ blockKind: 'HEADING' }));
    expect(result.auditResults).toHaveLength(1);
    expect(result.auditResults[0]).toMatchObject({
      blockAnchor: 'b1',
      hasGap: false,
      findings: [{ verdict: 'COVERED' }],
    });
  });
});
