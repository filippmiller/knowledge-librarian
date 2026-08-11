import { describe, expect, it, vi } from 'vitest';
import {
  buildFocusedRepairPromptMessages,
  extractKnowledgeUnitsWithCompletenessAudit,
  focusedReplacementChangesExistingUnit,
  normalizeMalformedExceptionAmbiguities,
  normalizeExtractedNumericUnits,
  refineCoextensiveEvidence,
} from '../audited-extraction';
import { buildExtractionPromptMessages, type SourceBlock } from '../knowledge-unit-extractor';
import type { ExtractedKnowledgeUnit } from '../applicability/extraction';
import { assignIdentity } from '../applicability/identity-assignment';
import { validateParentRefs } from '../applicability/extraction-parent-refs';
import type { AuditBlockCoverageOptions, BlockCoverageAuditResult, CoverageFinding } from '../extraction-coverage-auditor';

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
  it('full replacement comparison detects semantic-only changes and treats an identical unit as no-op', () => {
    const existing = unit({ extractionRef: 'stable', statement: 'Исходная формулировка.' });
    expect(focusedReplacementChangesExistingUnit(existing, { ...existing })).toBe(false);
    expect(focusedReplacementChangesExistingUnit(existing, {
      ...existing, statement: 'Уточнённая формулировка.',
    })).toBe(true);
    expect(focusedReplacementChangesExistingUnit(existing, {
      ...existing,
      evidenceByField: { statement: { anchor: 'a', quote: 'точное доказательство' } },
    })).toBe(true);
    expect(focusedReplacementChangesExistingUnit(existing, {
      ...existing,
      uncertainties: [{ kind: 'UNRECOGNIZED_TRIGGER_CONDITION', description: 'Возраст вне каталога.', quote: 'Для ребёнка' }],
    })).toBe(true);
  });

  it('b6 normalizes overlapping ambiguity on malformed exception into actionable gap', () => {
    const text = 'При отсутствии воды допустим кожный антисептик.';
    const result = normalizeMalformedExceptionAmbiguities({
      blockAnchor: 'b6',
      findings: [{ verdict: 'AMBIGUOUS', quote: text, explanation: 'неясно, является ли это исключением', quoteVerified: true }],
      hasGap: false, unresolved: true,
    }, block('b6', text), [unit({
      kind: 'EXCEPTION_RULE', extractionRef: 'exception', statement: text,
      sourceSpan: { anchor: 'b6', quote: text }, parentExtractionRef: null, triggerCondition: null,
    })]);
    expect(result.findings[0].verdict).toBe('UNREPRESENTED_CLAUSE');
    expect(result.hasGap).toBe(true);
    expect(result.unresolved).toBe(false);
  });

  it('does not normalize unrelated, empty, or non-overlapping ambiguity', () => {
    const text = 'Базовое правило. При условии допускается исключение. Другой спорный текст.';
    const malformed = unit({
      kind: 'EXCEPTION_RULE', extractionRef: 'exception', statement: 'Допускается исключение.',
      sourceSpan: { anchor: 'b', quote: 'При условии допускается исключение' }, parentExtractionRef: null,
    });
    for (const quote of ['', 'Другой спорный текст']) {
      const normalized = normalizeMalformedExceptionAmbiguities({
        blockAnchor: 'b', findings: [{ verdict: 'AMBIGUOUS', quote, explanation: 'unrelated', quoteVerified: quote !== '' }],
        hasGap: false, unresolved: true,
      }, block('b', text), [malformed]);
      expect(normalized.findings[0].verdict).toBe('AMBIGUOUS');
      expect(normalized.hasGap).toBe(false);
      expect(normalized.unresolved).toBe(true);
    }
  });

  it.each([
    { name: 'b6 grounded malformed exception reclassification clears parent', trigger: null, findingQuote: 'При отсутствии воды допустим антисептик', expectedParent: null },
    { name: 'unrelated actionable finding preserves parent', trigger: null, findingQuote: 'Отдельное правило', expectedParent: 'b0-base' },
    { name: 'valid exception preserves parent even for overlapping finding', trigger: { all: [{ fact: 'privacyContext' as const, equals: 'PUBLIC' as const }] }, findingQuote: 'При отсутствии воды допустим антисептик', expectedParent: 'b0-base' },
  ])('$name', async ({ trigger, findingQuote, expectedParent }) => {
    const text = 'Базовое правило. При отсутствии воды допустим антисептик. Отдельное правило.';
    const exceptionQuote = 'При отсутствии воды допустим антисептик';
    const extractor = async () => ({ units: [
      unit({ extractionRef: 'base', statement: 'Базовое правило.', sourceSpan: { anchor: 'b6', quote: 'Базовое правило' } }),
      unit({ kind: 'EXCEPTION_RULE', extractionRef: 'exception', parentExtractionRef: 'base', triggerCondition: trigger, statement: `${exceptionQuote}.`, sourceSpan: { anchor: 'b6', quote: exceptionQuote } }),
    ], structuredResult: {} as never });
    const repairExtractor = async () => ({ units: [
      unit({ kind: 'PROCEDURE_STEP', extractionRef: 'b0-exception', parentExtractionRef: null, statement: `${exceptionQuote}.`, sourceSpan: { anchor: 'b6', quote: exceptionQuote } }),
    ], structuredResult: {} as never });
    let audits = 0;
    const auditor = async (): Promise<BlockCoverageAuditResult> => ++audits === 1
      ? { blockAnchor: 'b6', findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: findingQuote, explanation: 'reclassify', quoteVerified: true }], hasGap: true }
      : { blockAnchor: 'b6', findings: [{ verdict: 'COVERED', quote: '', explanation: 'clean', quoteVerified: false }], hasGap: false };
    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      [block('b6', text)], 5, { runConfig: {} as never }, {} as never, { extractor, repairExtractor, auditor }
    );
    const repaired = result.units.find((item) => item.extractionRef === 'b0-exception')!;
    expect(repaired.kind).toBe('PROCEDURE_STEP');
    expect(repaired.parentExtractionRef).toBe(expectedParent);
    expect(result.auditResults[0].findings[0].verdict).toBe('COVERED');
  });

  // b4 (fresh-extraction run, 2026-08-11): a repair response can legitimately
  // SPLIT one existing rule into (1) a replacement for the existing ref and
  // (2) a brand-new sibling/child unit parented back to that same existing
  // ref. When that happens, the replacement's explicit triggerCondition:null
  // is a deliberate hand-off, not an omission -- the child now carries the
  // trigger. The observed bug: `preserveTrigger` could not tell this apart
  // from an ordinary "repair forgot to restate the field" response and
  // resurrected the stale trigger onto the (now general) parent, so the
  // re-audit saw the exact defect it had just rejected and the block
  // hard-aborted after exhausting repair rounds.
  it('b4 shape: genuine split lets the null triggerCondition win instead of resurrecting the stale value', async () => {
    const text = 'Правило приоритета применяется всегда. Например, в общественном месте разрешено узкое послабление.';
    const extractor = async () => ({
      units: [
        unit({
          kind: 'EXCEPTION_RULE',
          extractionRef: 'u1',
          statement: 'Правило приоритета применяется всегда, включая случай в общественном месте.',
          triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] },
          parentExtractionRef: null,
          sourceSpan: { anchor: 'b1', quote: 'Правило приоритета применяется всегда.' },
        }),
      ],
      structuredResult: {} as never,
    });
    // The SAME repair response both (a) reuses the existing ref with an
    // explicit null trigger and (b) introduces a genuinely new child unit
    // whose parentExtractionRef is that same existing (namespaced) ref --
    // exactly the "one existing rule repaired into several units" shape the
    // repair contract documents (FOCUSED_REPAIR_SYSTEM_PROMPT).
    const repairExtractor = async () => ({
      units: [
        unit({
          kind: 'PROCEDURE_STEP',
          extractionRef: 'b0-u1',
          statement: 'Правило приоритета применяется всегда.',
          triggerCondition: null,
          parentExtractionRef: null,
          sourceSpan: { anchor: 'b1', quote: 'Правило приоритета применяется всегда.' },
        }),
        unit({
          kind: 'EXCEPTION_RULE',
          extractionRef: 'u2',
          statement: 'В общественном месте разрешено узкое послабление.',
          triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] },
          parentExtractionRef: 'b0-u1',
          sourceSpan: { anchor: 'b1', quote: 'в общественном месте разрешено узкое послабление.' },
        }),
      ],
      structuredResult: {} as never,
    });
    let audits = 0;
    const auditor = async (): Promise<BlockCoverageAuditResult> => ++audits === 1
      ? { blockAnchor: 'b1', findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: text, explanation: 'trigger misplaced on the general rule', quoteVerified: true }], hasGap: true }
      : { blockAnchor: 'b1', findings: [{ verdict: 'COVERED', quote: '', explanation: 'clean', quoteVerified: false }], hasGap: false };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      [block('b1', text)], 5, { runConfig: {} as never }, {} as never, { extractor, repairExtractor, auditor }
    );

    const parent = result.units.find((item) => item.extractionRef === 'b0-u1')!;
    expect(parent.triggerCondition).toBeNull();
    const child = result.units.find((item) => item.statement.includes('послабление'))!;
    expect(child.triggerCondition).toEqual({ all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] });
    expect(child.parentExtractionRef).toBe('b0-u1');
    expect(result.auditResults[0].findings[0].verdict).toBe('COVERED');
  });

  // Companion to the split test above: the SAME repair response shape but
  // WITHOUT a second unit parented to the replaced ref. This is the ordinary
  // "repair forgot to restate a populated field" case the original guard
  // exists for, and it must keep resurrecting the existing value -- a split
  // must be genuinely evidenced by another unit in the same response, not
  // assumed.
  it('ordinary (non-split) repair still preserves the existing triggerCondition when the candidate returns null', async () => {
    const text = 'Правило приоритета применяется всегда, включая случай в общественном месте.';
    const extractor = async () => ({
      units: [
        unit({
          kind: 'EXCEPTION_RULE',
          extractionRef: 'u1',
          statement: 'Правило приоритета применяется всегда, включая случай в общественном месте.',
          triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] },
          parentExtractionRef: null,
          sourceSpan: { anchor: 'b1', quote: text },
        }),
      ],
      structuredResult: {} as never,
    });
    const repairExtractor = async () => ({
      units: [
        unit({
          kind: 'EXCEPTION_RULE',
          extractionRef: 'b0-u1',
          statement: 'Правило приоритета применяется всегда, включая случай в общественном месте (уточнено).',
          triggerCondition: null,
          parentExtractionRef: null,
          sourceSpan: { anchor: 'b1', quote: text },
        }),
      ],
      structuredResult: {} as never,
    });
    let audits = 0;
    const auditor = async (): Promise<BlockCoverageAuditResult> => ++audits === 1
      ? { blockAnchor: 'b1', findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: text, explanation: 'needs clarification', quoteVerified: true }], hasGap: true }
      : { blockAnchor: 'b1', findings: [{ verdict: 'COVERED', quote: '', explanation: 'clean', quoteVerified: false }], hasGap: false };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      [block('b1', text)], 5, { runConfig: {} as never }, {} as never, { extractor, repairExtractor, auditor }
    );

    const repaired = result.units.find((item) => item.extractionRef === 'b0-u1')!;
    expect(repaired.triggerCondition).toEqual({ all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] });
  });

  it('quality-v2 b13: разделяет широкую составную evidence-цитату на три доказуемые clause spans', () => {
    const quote = 'Помощник обязан надеть чистые одноразовые перчатки, соблюдать ограничения по силе и времени и немедленно остановиться по первой просьбе.';
    const refined = refineCoextensiveEvidence([
      unit({ statement: 'Помощник обязан надеть чистые одноразовые перчатки перед выполнением почесания.', extractionRef: 'u4', sourceSpan: { anchor: 'b13', quote } }),
      unit({ statement: 'Помощник обязан соблюдать ограничения по силе воздействия и по времени выполнения почесания.', extractionRef: 'u5', sourceSpan: { anchor: 'b13', quote } }),
      unit({ statement: 'Помощник обязан немедленно остановиться по первой просьбе того, кому помогает.', extractionRef: 'u6', sourceSpan: { anchor: 'b13', quote } }),
    ]);

    expect(refined.map((item) => item.sourceSpan.quote)).toEqual([
      'Помощник обязан надеть чистые одноразовые перчатки',
      'соблюдать ограничения по силе',
      'немедленно остановиться по первой просьбе',
    ]);
    expect(new Set(refined.map((item) => item.sourceSpan.quote)).size).toBe(3);
    const identity = assignIdentity(refined, new Map([['b13', {
      anchor: 'b13',
      text: quote,
      sectionPath: '13',
      structuralPath: 'body/p[13]',
      blockStart: 100,
      blockEnd: 100 + quote.length,
    }]]), 'quality-v2-revision');
    expect(identity.unresolvedEvidence).toEqual([]);
    expect(identity.ambiguousDuplicates).toEqual([]);
    expect(identity.units).toHaveLength(3);
  });

  it('не угадывает разделение coextensive units без трёхсловных дословных clause matches', () => {
    const quote = 'Общее широкое доказательство для нескольких утверждений.';
    const original = [
      unit({ statement: 'Формулировка А.', extractionRef: 'a', sourceSpan: { anchor: 'b', quote } }),
      unit({ statement: 'Формулировка Б.', extractionRef: 'b', sourceSpan: { anchor: 'b', quote } }),
    ];

    expect(refineCoextensiveEvidence(original)).toEqual(original);
  });

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

  it('b7 prompt forbids the observed min/max shape and specifies split numeric units', () => {
    const messages = buildFocusedRepairPromptMessages({
      block: block('b7', 'Почесание выполняют подушечками двух или трёх пальцев.'),
      findings: [{
        verdict: 'POSSIBLE_OMISSION', quote: 'двух или трёх пальцев',
        explanation: 'числа отсутствуют в numericConstraint', quoteVerified: true,
      }],
      existingUnits: [unit({ statement: 'Почесание выполняют подушечками двух или трёх пальцев.' })],
    });
    const prompt = messages.map((message) => message.content).join('\n');

    expect(prompt).toContain('{"factKey":"что измеряется","value":2,"unit":"fingers"}');
    expect(prompt).toContain('Ключи min/max/from/to/range/values ЗАПРЕЩЕНЫ');
    expect(prompt).toContain('{"min":2,"max":3,"unit":"..."}');
    expect(prompt).toContain('один с value=2 и один с value=3');
    expect(prompt).toContain('«двух» и «трёх»');
  });

  it('compact prompt exposes full existing structure and protects unaffected populated fields', () => {
    const existing = unit({
      extractionRef: 'exception', parentExtractionRef: 'base',
      facets: { scenario: 'apostille' },
      triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] },
      numericConstraint: { factKey: 'duration', value: 3, unit: 'seconds' },
      evidenceByField: {
        statement: { anchor: 'b9', quote: 'три секунды' },
        triggerCondition: { anchor: 'b9', quote: 'вне дома' },
        numericConstraint: { anchor: 'b9', quote: 'три секунды' },
      },
    });
    const prompt = buildFocusedRepairPromptMessages({
      block: block('b9', 'Вне дома разрешено не более трёх секунд.'),
      findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'вне дома', explanation: 'x', quoteVerified: true }],
      existingUnits: [existing],
    }).map((message) => message.content).join('\n');
    expect(prompt).toContain('"parentExtractionRef":"base"');
    expect(prompt).toContain('"numericConstraint":{"factKey":"duration","value":3,"unit":"seconds"}');
    expect(prompt).toContain('"evidenceByField"');
    expect(prompt).toContain('скопируй без изменений каждый уже заполненный field');
    expect(prompt).toContain('«прижать один раз») имеет unit="times"');
  });

  it('mixed TERM_DEFINITION repair requests a sibling PROCEDURE_STEP without a fabricated prohibition kind', () => {
    const prompt = buildFocusedRepairPromptMessages({
      block: block('b3', '«Расчёсывание» означает чрезмерное воздействие и не допускается.'),
      findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'не допускается', explanation: 'missing normative sibling', quoteVerified: true }],
      existingUnits: [unit({ kind: 'TERM_DEFINITION', extractionRef: 'term', statement: 'Расчёсывание означает чрезмерное воздействие.' })],
    }).map((message) => message.content).join('\n');
    expect(prompt).toContain('отдельный sibling kind="PROCEDURE_STEP"');
    expect(prompt).toContain('искусственный parent к нему не создавай');
    expect(prompt).not.toContain('kind="PROHIBITION"');
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

  it('focused exception repair сохраняет parent на существующий base и structured trigger', async () => {
    const extractor = async () => ({
      units: [unit({ extractionRef: 'base', statement: 'Применяется общий порядок.', sourceSpan: { anchor: 'b9', quote: 'Общий порядок.' } })],
      structuredResult: {} as never,
    });
    const repairExtractor = async (options: { existingUnits: readonly ExtractedKnowledgeUnit[] }) => {
      const parent = options.existingUnits.find((item) => item.statement === 'Применяется общий порядок.')!;
      expect(parent.extractionRef).toBe('b0-base');
      return {
        units: [unit({
          kind: 'EXCEPTION_RULE',
          extractionRef: 'exception',
          parentExtractionRef: parent.extractionRef,
          statement: 'В общественном месте разрешено краткое прижатие.',
          triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] },
          sourceSpan: { anchor: 'b9', quote: 'В общественном месте разрешено краткое прижатие.' },
          evidenceByField: {
            statement: { anchor: 'b9', quote: 'В общественном месте разрешено краткое прижатие.' },
            triggerCondition: { anchor: 'b9', quote: 'В общественном месте' },
          },
        })],
        structuredResult: {} as never,
      };
    };
    let auditCalls = 0;
    const auditor = async (): Promise<BlockCoverageAuditResult> => ++auditCalls === 1
      ? {
          blockAnchor: 'b9',
          findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'В общественном месте', explanation: 'missing trigger', quoteVerified: true }],
          hasGap: true,
        }
      : { blockAnchor: 'b9', findings: [{ verdict: 'COVERED', quote: '', explanation: 'ok', quoteVerified: false }], hasGap: false };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      [block('b9', 'Общий порядок. В общественном месте разрешено краткое прижатие.')],
      5,
      { runConfig: {} as never },
      {} as never,
      { extractor, repairExtractor, auditor }
    );
    const exception = result.units.find((item) => item.kind === 'EXCEPTION_RULE')!;
    expect(exception.parentExtractionRef).toBe('b0-base');
    expect(exception.triggerCondition).toEqual({ all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] });
  });

  it('Q04 canonicalizes cycle count unit times -> cycles without changing unrelated counts', () => {
    const cycle = normalizeExtractedNumericUnits(unit({
      statement: 'За эпизод разрешено не более трёх циклов.',
      numericConstraint: { factKey: 'максимальное число циклов', value: 3, unit: 'times' },
    }));
    const visits = normalizeExtractedNumericUnits(unit({
      statement: 'Допускается три посещения.',
      numericConstraint: { factKey: 'максимум посещений', value: 3, unit: 'times' },
    }));

    expect(cycle.numericConstraint?.unit).toBe('cycles');
    expect(visits.numericConstraint?.unit).toBe('times');
  });

  it('b13 explicit ref replaces a paraphrased null-trigger unit and leaves identity clean', async () => {
    const text = 'Другой человек может выполнить почесание только после ясного согласия того, кому помогают.';
    const extractor = async () => ({
      units: [unit({ extractionRef: 'consent', statement: 'Другой человек может выполнить почесание только после того, как тот, кому помогают, дал ясное согласие.', sourceSpan: { anchor: 'b13', quote: text } })],
      structuredResult: {} as never,
    });
    const repairExtractor = async () => ({
      units: [unit({
        extractionRef: 'b0-consent',
        statement: text,
        sourceSpan: { anchor: 'b13', quote: text },
        triggerCondition: { all: [{ fact: 'consentStatus', equals: 'EXPLICIT' }] },
        evidenceByField: {
          statement: { anchor: 'b13', quote: text },
          triggerCondition: { anchor: 'b13', quote: 'только после ясного согласия' },
        },
      })],
      structuredResult: {} as never,
    });
    let audits = 0;
    const auditor = async (): Promise<BlockCoverageAuditResult> => ++audits === 1
      ? { blockAnchor: 'b13', findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'только после ясного согласия', explanation: 'trigger missing', quoteVerified: true }], hasGap: true }
      : { blockAnchor: 'b13', findings: [{ verdict: 'COVERED', quote: '', explanation: 'fixed', quoteVerified: false }], hasGap: false };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      [block('b13', text)], 5, { runConfig: {} as never }, {} as never, { extractor, repairExtractor, auditor }
    );
    expect(result.units).toHaveLength(1);
    expect(result.units[0].extractionRef).toBe('b0-consent');
    expect(result.units[0].triggerCondition).toEqual({ all: [{ fact: 'consentStatus', equals: 'EXPLICIT' }] });
    const identity = assignIdentity(result.units, new Map([['b13', {
      anchor: 'b13', text, sectionPath: '13', structuralPath: 'body/p[13]', blockStart: 0, blockEnd: text.length,
    }]]), 'explicit-ref-revision');
    expect(identity.ambiguousDuplicates).toEqual([]);
    expect(identity.units).toHaveLength(1);
  });

  it('fails closed when an existing extractionRef is reused with non-overlapping evidence', async () => {
    const text = 'Первое правило. Совсем другое правило.';
    const extractor = async () => ({ units: [unit({ extractionRef: 'stable', statement: 'Первое правило.', sourceSpan: { anchor: 'b', quote: 'Первое правило' } })], structuredResult: {} as never });
    const repairExtractor = async () => ({ units: [unit({ extractionRef: 'b0-stable', statement: 'Совсем другое правило.', sourceSpan: { anchor: 'b', quote: 'Совсем другое правило' } })], structuredResult: {} as never });
    const auditor = async (): Promise<BlockCoverageAuditResult> => ({ blockAnchor: 'b', findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'Совсем другое правило', explanation: 'repair', quoteVerified: true }], hasGap: true });
    await expect(extractKnowledgeUnitsWithCompletenessAudit(
      [block('b', text)], 5, { runConfig: {} as never }, {} as never, { extractor, repairExtractor, auditor }
    )).rejects.toThrow(/reused extractionRef b0-stable without overlapping evidence/);
  });

  it('structural repair заменяет numeric unit times -> cycles с сохранением identity ref', async () => {
    const text = 'За эпизод разрешено не более трёх циклов.';
    const extractor = async () => ({
      units: [unit({ extractionRef: 'cycles', statement: text, sourceSpan: { anchor: 'b8', quote: text }, numericConstraint: { factKey: 'max cycles', value: 3, unit: 'times' } })],
      structuredResult: {} as never,
    });
    const repairExtractor = async () => ({
      units: [unit({ extractionRef: 'repair', statement: text, sourceSpan: { anchor: 'b8', quote: text }, numericConstraint: { factKey: 'max cycles', value: 3, unit: 'cycles' } })],
      structuredResult: {} as never,
    });
    let audits = 0;
    const auditor = async (): Promise<BlockCoverageAuditResult> => ++audits === 1
      ? { blockAnchor: 'b8', findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'не более трёх циклов', explanation: 'unit mismatch', quoteVerified: true }], hasGap: true }
      : { blockAnchor: 'b8', findings: [{ verdict: 'COVERED', quote: '', explanation: 'fixed', quoteVerified: false }], hasGap: false };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      [block('b8', text)], 5, { runConfig: {} as never }, {} as never, { extractor, repairExtractor, auditor }
    );
    expect(result.units).toHaveLength(1);
    expect(result.units[0].extractionRef).toBe('b0-cycles');
    expect(result.units[0].numericConstraint?.unit).toBe('cycles');
  });

  it('b7 one-to-many numeric repair replaces one unit, appends the alternative, and keeps identity unambiguous', async () => {
    const text = 'Почесание выполняют подушечками двух или трёх пальцев короткими плавными движениями.';
    const originalStatement = text;
    const extractor = async () => ({
      units: [unit({ extractionRef: 'fingers', statement: originalStatement, sourceSpan: { anchor: 'b7', quote: text }, evidenceByField: { statement: { anchor: 'b7', quote: text } } })],
      structuredResult: {} as never,
    });
    const repairExtractor = async () => ({
      units: [
        unit({
          extractionRef: 'two', statement: originalStatement,
          sourceSpan: { anchor: 'b7', quote: 'двух' },
          numericConstraint: { factKey: 'число пальцев', value: 2, unit: 'fingers' },
          evidenceByField: { statement: { anchor: 'b7', quote: text }, numericConstraint: { anchor: 'b7', quote: 'двух' } },
        }),
        unit({
          extractionRef: 'three', statement: 'Допустимый альтернативный способ использует три пальца.',
          sourceSpan: { anchor: 'b7', quote: 'трёх' },
          numericConstraint: { factKey: 'число пальцев', value: 3, unit: 'fingers' },
          evidenceByField: { statement: { anchor: 'b7', quote: text }, numericConstraint: { anchor: 'b7', quote: 'трёх' } },
        }),
      ],
      structuredResult: {} as never,
    });
    let audits = 0;
    const auditor = async (): Promise<BlockCoverageAuditResult> => ++audits === 1
      ? { blockAnchor: 'b7', findings: [{ verdict: 'POSSIBLE_OMISSION', quote: 'двух или трёх пальцев', explanation: 'numeric missing', quoteVerified: true }], hasGap: true }
      : { blockAnchor: 'b7', findings: [{ verdict: 'COVERED', quote: '', explanation: 'fixed', quoteVerified: false }], hasGap: false };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      [block('b7', text)], 5, { runConfig: {} as never }, {} as never, { extractor, repairExtractor, auditor }
    );
    expect(result.units.map((item) => item.numericConstraint?.value)).toEqual([2, 3]);
    expect(result.units[0].extractionRef).toBe('b0-fingers');
    expect(result.units[1].extractionRef).toBe('focused-b7-three');
    expect(result.units.map((item) => item.sourceSpan.quote)).toEqual(['двух', 'трёх']);

    const identity = assignIdentity(result.units, new Map([['b7', {
      anchor: 'b7', text, sectionPath: '7', structuralPath: 'body/p[7]',
      blockStart: 0, blockEnd: text.length,
    }]]), 'quality-v3-revision');
    expect(identity.unresolvedEvidence).toEqual([]);
    expect(identity.ambiguousDuplicates).toEqual([]);
    expect(identity.units).toHaveLength(2);
  });

  it('b9 repair is non-lossy, remaps parents, and accepts one action as times', async () => {
    const text = '5. Ситуация вне дома. Нельзя открывать одежду. При внезапном зуде разрешено один раз прижать ладонь не более чем на три секунды.';
    const baseStatement = 'Вне дома нельзя открывать одежду.';
    const exceptionStatement = 'При внезапном зуде разрешено один раз прижать ладонь не более чем на три секунды.';
    const extractor = async () => ({ units: [
      unit({ extractionRef: 'base', statement: baseStatement, sourceSpan: { anchor: 'b9', quote: 'Нельзя открывать одежду' }, evidenceByField: { statement: { anchor: 'b9', quote: 'Нельзя открывать одежду' } } }),
      unit({
        kind: 'EXCEPTION_RULE', extractionRef: 'exception', parentExtractionRef: 'base',
        statement: exceptionStatement, sourceSpan: { anchor: 'b9', quote: exceptionStatement },
        numericConstraint: { factKey: 'maximum press duration', value: 3, unit: 'seconds' },
        evidenceByField: { statement: { anchor: 'b9', quote: exceptionStatement }, numericConstraint: { anchor: 'b9', quote: 'три секунды' } },
      }),
    ], structuredResult: {} as never });
    const repairExtractor = async () => ({ units: [
      unit({ extractionRef: 'r1', statement: baseStatement, sourceSpan: { anchor: 'b9', quote: 'Нельзя открывать одежду' }, triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] }, evidenceByField: { statement: { anchor: 'b9', quote: 'Нельзя открывать одежду' }, triggerCondition: { anchor: 'b9', quote: 'Ситуация вне дома' } } }),
      unit({ kind: 'EXCEPTION_RULE', extractionRef: 'r2', parentExtractionRef: 'r1', statement: exceptionStatement, sourceSpan: { anchor: 'b9', quote: exceptionStatement }, triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] }, evidenceByField: { statement: { anchor: 'b9', quote: exceptionStatement }, triggerCondition: { anchor: 'b9', quote: 'Ситуация вне дома' } } }),
      unit({ kind: 'EXCEPTION_RULE', extractionRef: 'r3', parentExtractionRef: 'r1', statement: 'Одно прижатие является максимальным количеством действий.', sourceSpan: { anchor: 'b9', quote: 'один раз' }, triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] }, numericConstraint: { factKey: 'press occurrence count', value: 1, unit: 'times' }, evidenceByField: { statement: { anchor: 'b9', quote: 'один раз' }, triggerCondition: { anchor: 'b9', quote: 'Ситуация вне дома' }, numericConstraint: { anchor: 'b9', quote: 'один раз' } } }),
    ], structuredResult: {} as never });
    let audits = 0;
    const auditor = async (): Promise<BlockCoverageAuditResult> => ++audits === 1
      ? { blockAnchor: 'b9', findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'Ситуация вне дома', explanation: 'trigger/count missing', quoteVerified: true }], hasGap: true }
      : { blockAnchor: 'b9', findings: [{ verdict: 'COVERED', quote: '', explanation: 'all represented', quoteVerified: false }], hasGap: false };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      [block('b9', text)], 5, { runConfig: {} as never }, {} as never, { extractor, repairExtractor, auditor }
    );
    const base = result.units.find((item) => item.extractionRef === 'b0-base')!;
    const exception = result.units.find((item) => item.extractionRef === 'b0-exception')!;
    const count = result.units.find((item) => item.numericConstraint?.value === 1)!;
    expect(base.triggerCondition).toEqual({ all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] });
    expect(exception.numericConstraint).toEqual({ factKey: 'maximum press duration', value: 3, unit: 'seconds' });
    expect(exception.triggerCondition).toEqual({ all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] });
    expect(exception.parentExtractionRef).toBe('b0-base');
    expect(count.numericConstraint?.unit).toBe('times');
    expect(count.parentExtractionRef).toBe('b0-base');
    expect(result.auditResults[0].findings[0].verdict).toBe('COVERED');
  });

  it('b9 accepts repair units that directly reuse stable replacement refs and stable parent', async () => {
    const text = 'Вне дома нельзя открывать одежду. При внезапном зуде разрешено прижатие.';
    const baseStatement = 'Вне дома нельзя открывать одежду.';
    const exceptionStatement = 'При внезапном зуде разрешено прижатие.';
    const extractor = async () => ({ units: [
      unit({ extractionRef: 'base', statement: baseStatement, sourceSpan: { anchor: 'b9', quote: baseStatement } }),
      unit({ kind: 'EXCEPTION_RULE', extractionRef: 'exception', parentExtractionRef: 'base', statement: exceptionStatement, sourceSpan: { anchor: 'b9', quote: exceptionStatement } }),
    ], structuredResult: {} as never });
    // Batch extraction namespaces these refs to b0-base / b0-exception. A
    // provider may correctly copy those stable refs verbatim in its repair.
    const repairExtractor = async () => ({ units: [
      unit({ extractionRef: 'b0-base', statement: baseStatement, sourceSpan: { anchor: 'b9', quote: baseStatement }, triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] }, evidenceByField: { statement: { anchor: 'b9', quote: baseStatement }, triggerCondition: { anchor: 'b9', quote: 'Вне дома' } } }),
      unit({ kind: 'EXCEPTION_RULE', extractionRef: 'b0-exception', parentExtractionRef: 'b0-base', statement: exceptionStatement, sourceSpan: { anchor: 'b9', quote: exceptionStatement }, triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] }, evidenceByField: { statement: { anchor: 'b9', quote: exceptionStatement }, triggerCondition: { anchor: 'b9', quote: 'Вне дома' } } }),
    ], structuredResult: {} as never });
    let audits = 0;
    const auditor = async (): Promise<BlockCoverageAuditResult> => ++audits === 1
      ? { blockAnchor: 'b9', findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'Вне дома', explanation: 'trigger missing', quoteVerified: true }], hasGap: true }
      : { blockAnchor: 'b9', findings: [{ verdict: 'COVERED', quote: '', explanation: 'fixed', quoteVerified: false }], hasGap: false };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      [block('b9', text)], 5, { runConfig: {} as never }, {} as never, { extractor, repairExtractor, auditor }
    );
    expect(result.units.map((item) => item.extractionRef)).toEqual(['b0-base', 'b0-exception']);
    expect(result.units[1].parentExtractionRef).toBe('b0-base');
    expect(result.units.every((item) => item.triggerCondition !== null)).toBe(true);
  });

  it('b9 converges in three focused rounds with four audits and three repairs', async () => {
    const text = 'Вне дома разрешено один раз прижать ладонь на три секунды.';
    const statement = 'Вне дома разрешено прижать ладонь.';
    const extractor = async () => ({ units: [unit({ extractionRef: 'press', statement, sourceSpan: { anchor: 'b9', quote: text } })], structuredResult: {} as never });
    let repairs = 0;
    const repairExtractor = async () => {
      repairs += 1;
      if (repairs === 1) {
        return { units: [unit({ extractionRef: 'b0-press', statement, sourceSpan: { anchor: 'b9', quote: text }, triggerCondition: { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] }, evidenceByField: { statement: { anchor: 'b9', quote: text }, triggerCondition: { anchor: 'b9', quote: 'Вне дома' } } })], structuredResult: {} as never };
      }
      if (repairs === 2) {
        return { units: [unit({ extractionRef: 'count', statement: 'Разрешено ровно одно прижатие.', sourceSpan: { anchor: 'b9', quote: 'один раз' }, numericConstraint: { factKey: 'press count', value: 1, unit: 'times' }, evidenceByField: { statement: { anchor: 'b9', quote: 'один раз' }, numericConstraint: { anchor: 'b9', quote: 'один раз' } } })], structuredResult: {} as never };
      }
      return { units: [unit({ extractionRef: 'duration', statement: 'Прижатие длится три секунды.', sourceSpan: { anchor: 'b9', quote: 'три секунды' }, numericConstraint: { factKey: 'press duration', value: 3, unit: 'seconds' }, evidenceByField: { statement: { anchor: 'b9', quote: 'три секунды' }, numericConstraint: { anchor: 'b9', quote: 'три секунды' } } })], structuredResult: {} as never };
    };
    let audits = 0;
    const auditor = async (): Promise<BlockCoverageAuditResult> => {
      audits += 1;
      if (audits === 1) return { blockAnchor: 'b9', findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'Вне дома', explanation: 'trigger missing', quoteVerified: true }], hasGap: true };
      if (audits === 2) return { blockAnchor: 'b9', findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'один раз', explanation: 'count missing', quoteVerified: true }], hasGap: true };
      if (audits === 3) return { blockAnchor: 'b9', findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'три секунды', explanation: 'duration missing', quoteVerified: true }], hasGap: true };
      return { blockAnchor: 'b9', findings: [{ verdict: 'COVERED', quote: '', explanation: 'clean', quoteVerified: false }], hasGap: false };
    };
    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      [block('b9', text)], 5, { runConfig: {} as never }, {} as never, { extractor, repairExtractor, auditor }
    );
    expect(audits).toBe(4);
    expect(repairs).toBe(3);
    expect(result.auditResults).toHaveLength(1);
    expect(result.auditResults[0].findings[0].verdict).toBe('COVERED');
    expect(result.units.some((item) => item.numericConstraint?.value === 1)).toBe(true);
    expect(result.units.some((item) => item.numericConstraint?.value === 3)).toBe(true);
  });

  it('b14 uncertainty-only round3 replacement changes final audit input and reaches COVERED', async () => {
    const reachabilityText = 'Если человек не может дотянуться до участка рукой, допускается мягкая ткань.';
    const prohibitionText = 'Приспособление с твёрдым или острым концом применять нельзя.';
    const childText = 'Для ребёнка продолжительность и гигиену контролирует взрослый.';
    const text = `${reachabilityText} ${prohibitionText} ${childText}`;
    const extractor = async () => ({
      units: [
        unit({ extractionRef: 'u8', statement: reachabilityText, sourceSpan: { anchor: 'b14', quote: reachabilityText } }),
        unit({ extractionRef: 'u9', parentExtractionRef: 'u8', statement: prohibitionText, sourceSpan: { anchor: 'b14', quote: prohibitionText } }),
        unit({ extractionRef: 'u10', statement: childText, sourceSpan: { anchor: 'b14', quote: childText } }),
      ],
      structuredResult: {} as never,
    });
    let repairs = 0;
    const repairExtractor = async () => {
      repairs += 1;
      if (repairs === 1) return {
        units: [unit({
          extractionRef: 'b0-u8', statement: reachabilityText, sourceSpan: { anchor: 'b14', quote: reachabilityText },
          triggerCondition: { all: [{ fact: 'reachability', equals: 'LIMITED' }] },
          evidenceByField: { statement: { anchor: 'b14', quote: reachabilityText }, triggerCondition: { anchor: 'b14', quote: 'не может дотянуться' } },
        })], structuredResult: {} as never,
      };
      if (repairs === 2) return {
        units: [unit({
          extractionRef: 'b0-u9', parentExtractionRef: 'b0-u8', statement: prohibitionText,
          sourceSpan: { anchor: 'b14', quote: prohibitionText },
          triggerCondition: { all: [{ fact: 'reachability', equals: 'LIMITED' }] },
          evidenceByField: { statement: { anchor: 'b14', quote: prohibitionText }, triggerCondition: { anchor: 'b14', quote: reachabilityText } },
        })], structuredResult: {} as never,
      };
      return {
        units: [unit({
          extractionRef: 'b0-u10', statement: childText, sourceSpan: { anchor: 'b14', quote: childText },
          uncertainties: [{ kind: 'UNRECOGNIZED_TRIGGER_CONDITION', description: 'Возраст вне закрытого trigger-каталога.', quote: 'Для ребёнка' }],
        })], structuredResult: {} as never,
      };
    };
    const auditInputs: AuditBlockCoverageOptions[] = [];
    const auditor = async (options: AuditBlockCoverageOptions): Promise<BlockCoverageAuditResult> => {
      auditInputs.push(options);
      if (auditInputs.length === 1) return { blockAnchor: 'b14', findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'не может дотянуться', explanation: 'reachability missing', quoteVerified: true }], hasGap: true };
      if (auditInputs.length === 2) return { blockAnchor: 'b14', findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: prohibitionText, explanation: 'child condition missing', quoteVerified: true }], hasGap: true };
      if (auditInputs.length === 3) return { blockAnchor: 'b14', findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: childText, explanation: 'uncertainty missing', quoteVerified: true }], hasGap: true };
      return { blockAnchor: 'b14', findings: [{ verdict: 'COVERED', quote: '', explanation: 'clean', quoteVerified: false }], hasGap: false };
    };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      [block('b14', text)], 5, { runConfig: {} as never }, {} as never,
      { extractor, repairExtractor, auditor }
    );

    expect(repairs).toBe(3);
    expect(auditInputs).toHaveLength(4);
    expect(JSON.stringify(auditInputs[3].extractedStatements)).not.toBe(JSON.stringify(auditInputs[2].extractedStatements));
    expect(auditInputs[3].extractedStatements.find((item) => item.extractionRef === 'b0-u10')?.uncertainties)
      .toEqual([expect.objectContaining({ kind: 'UNRECOGNIZED_TRIGGER_CONDITION', quote: 'Для ребёнка' })]);
    expect(result.auditResults[0].findings[0].verdict).toBe('COVERED');
    expect(result.units.find((item) => item.extractionRef === 'b0-u10')?.uncertainties)
      .toEqual([expect.objectContaining({ kind: 'UNRECOGNIZED_TRIGGER_CONDITION' })]);
  });

  it('round2 focused child preserves a parent ref supplied by existingUnits', () => {
    const child = unit({
      kind: 'EXCEPTION_RULE', extractionRef: 'count', parentExtractionRef: 'b2-u6',
      statement: 'Разрешено одно прижатие.', sourceSpan: { anchor: 'b9', quote: 'одно прижатие' },
      numericConstraint: { factKey: 'press count', value: 1, unit: 'times' },
    });
    const [validated] = validateParentRefs([child], new Set(['b2-u6']));
    expect(validated.parentExtractionRef).toBe('b2-u6');
    expect(validated.uncertainties).toEqual([]);
  });

  it('round2 focused child still fails closed for an unknown external parent ref', () => {
    const child = unit({
      kind: 'EXCEPTION_RULE', extractionRef: 'count', parentExtractionRef: 'missing-base',
      statement: 'Разрешено одно прижатие.', sourceSpan: { anchor: 'b9', quote: 'одно прижатие' },
    });
    const [validated] = validateParentRefs([child], new Set(['b2-u6']));
    expect(validated.parentExtractionRef).toBeNull();
    expect(validated.uncertainties.at(-1)?.kind).toBe('DANGLING_PARENT_REF');
  });

  it('fails closed when a repair parent still names an unknown transient ref', async () => {
    const text = 'Базовое правило. Исключение.';
    const extractor = async () => ({ units: [unit({ extractionRef: 'base', statement: 'Базовое правило.', sourceSpan: { anchor: 'b', quote: 'Базовое правило' } })], structuredResult: {} as never });
    const repairExtractor = async () => ({ units: [unit({ extractionRef: 'child', parentExtractionRef: 'missing-repair-ref', statement: 'Исключение.', sourceSpan: { anchor: 'b', quote: 'Исключение' } })], structuredResult: {} as never });
    let audits = 0;
    const auditor = async (): Promise<BlockCoverageAuditResult> => ++audits === 1
      ? { blockAnchor: 'b', findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'Исключение', explanation: 'missing', quoteVerified: true }], hasGap: true }
      : { blockAnchor: 'b', findings: [{ verdict: 'COVERED', quote: '', explanation: 'x', quoteVerified: false }], hasGap: false };
    await expect(extractKnowledgeUnitsWithCompletenessAudit(
      [block('b', text)], 5, { runConfig: {} as never }, {} as never, { extractor, repairExtractor, auditor }
    )).rejects.toThrow(/parent/i);
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

  it('не выпускает блок без явного COVERED: аудитор не вернул ни одной находки', async () => {
    const extractor = async () => ({ units: [], structuredResult: {} as never });
    const auditor = async (): Promise<BlockCoverageAuditResult> => ({ blockAnchor: 'b0', findings: [], hasGap: false });

    await expect(
      extractKnowledgeUnitsWithCompletenessAudit(
        [block('b0', 'спорный текст')], 5, { runConfig: {} as never }, {} as never, { extractor, auditor }
      )
    ).rejects.toThrow(/coverage audit did not clear block b0/i);
  });

  // Previously AMBIGUOUS-only was grouped with the empty-findings case above
  // and instant-failed identically -- no repair attempt at all. That was the
  // structural flaw: "I'm not sure whether something is missing" is not the
  // same claim as "nothing is missing", and it is not the same as "the
  // auditor returned nothing at all" either -- it is exactly the situation a
  // focused repair round exists to resolve. Live evidence: block b4
  // (fresh-extraction run, 2026-08-11) aborted the whole run on a single
  // AMBIGUOUS verdict asking "does this need its own unit, or is it already
  // covered by unit 4?".
  it('AMBIGUOUS-only initial audit enters focused repair instead of failing immediately, and repair receives that finding', async () => {
    const text = 'разрешённое краткое действие в общественном месте не превращается в разрешение на большее.';
    const extractor = async () => ({
      units: [unit({ sourceSpan: { anchor: 'b4', quote: text } })],
      structuredResult: {} as never,
    });
    let repairExtractorCalls = 0;
    const repairExtractor = async (options: { findings: readonly CoverageFinding[]; existingUnits: readonly ExtractedKnowledgeUnit[] }) => {
      repairExtractorCalls += 1;
      // Repair must receive the AMBIGUOUS finding itself, not an empty list
      // -- an empty list is exactly what the OLD filter (POSSIBLE_OMISSION |
      // UNREPRESENTED_CLAUSE only) would have produced here, which would
      // have hit the "no actionable findings" guard instead of this call.
      expect(options.findings).toHaveLength(1);
      expect(options.findings[0].verdict).toBe('AMBIGUOUS');
      expect(options.findings[0].explanation).toBe('не уверен, нужен ли отдельный unit');
      return {
        units: [unit({ extractionRef: 'clarified', sourceSpan: { anchor: 'b4', quote: text } })],
        structuredResult: {} as never,
      };
    };
    let auditCalls = 0;
    const auditor = async (): Promise<BlockCoverageAuditResult> =>
      ++auditCalls === 1
        ? {
            blockAnchor: 'b4',
            findings: [{ verdict: 'AMBIGUOUS', quote: text, explanation: 'не уверен, нужен ли отдельный unit', quoteVerified: true }],
            hasGap: false,
          }
        : { blockAnchor: 'b4', findings: [{ verdict: 'COVERED', quote: '', explanation: 'clean', quoteVerified: false }], hasGap: false };

    const result = await extractKnowledgeUnitsWithCompletenessAudit(
      [block('b4', text)], 5, { runConfig: {} as never }, {} as never, { extractor, repairExtractor, auditor }
    );

    expect(repairExtractorCalls).toBe(1);
    expect(auditCalls).toBe(2);
    expect(result.auditResults).toHaveLength(1);
    expect(result.auditResults[0].findings[0].verdict).toBe('COVERED');
  });

  it('не выпускает блок, если focused repair не прошёл повторный аудит', async () => {
    let auditCalls = 0;
    let repairCalls = 0;
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
          repairExtractor: async (options) => {
            repairCalls += 1;
            return repairUsing(extractor)(options);
          },
          auditor,
        }
      )
    ).rejects.toThrow(/focused repair did not clear block b0: 3-round limit exhausted/i);
    expect(auditCalls).toBe(4);
    expect(repairCalls).toBe(3);
  });

  // Same shape as the gap-round-exhaustion test above, but the auditor keeps
  // returning AMBIGUOUS (never a confirmed gap, never COVERED) every round,
  // including when repair itself proposes no changes at all -- a legitimate
  // "I looked, existing coverage already handles it" response, since the
  // repair schema never required a non-empty units array. The run must still
  // fail loudly after FOCUSED_REPAIR_MAX_ROUNDS (the round cap is NOT
  // raised), and the failure must say so was an unresolved AMBIGUITY, not
  // silently pass and not misreport a gap that was never actually found.
  it('AMBIGUOUS finding surviving every repair round still fails the run, labeled as an unresolved ambiguity', async () => {
    let auditCalls = 0;
    let repairCalls = 0;
    const extractor = async () => ({
      units: [unit({ sourceSpan: { anchor: 'b4', quote: 'спорное правило' } })],
      structuredResult: {} as never,
    });
    const repairExtractor = async () => {
      repairCalls += 1;
      return { units: [], structuredResult: {} as never };
    };
    const auditor = async (): Promise<BlockCoverageAuditResult> => {
      auditCalls++;
      return {
        blockAnchor: 'b4',
        findings: [{ verdict: 'AMBIGUOUS', quote: 'спорное правило', explanation: 'по-прежнему не уверен', quoteVerified: true }],
        hasGap: false,
      };
    };

    await expect(
      extractKnowledgeUnitsWithCompletenessAudit(
        [block('b4', 'спорное правило')], 5, { runConfig: {} as never }, {} as never,
        { extractor, repairExtractor, auditor }
      )
    ).rejects.toThrow(/focused repair did not clear block b4: 3-round limit exhausted \(unresolved ambiguity\)/i);
    expect(auditCalls).toBe(4);
    expect(repairCalls).toBe(3);
  });

  // Differentiation check in the other direction: a genuine gap (never
  // AMBIGUOUS) that survives every round must still be labeled a gap, not an
  // ambiguity -- proving the new reason text actually inspects the surviving
  // verdict rather than defaulting to one label regardless of cause. This is
  // the "no regression in the existing path" guarantee made explicit: same
  // scenario as the pre-existing test above, same round/repair counts implied,
  // now additionally pinning the exact reason suffix.
  it('genuine gap surviving every repair round is labeled a gap, not an ambiguity, in the failure message', async () => {
    const extractor = async () => ({
      units: [unit({ sourceSpan: { anchor: 'b0', quote: 'правило' } })],
      structuredResult: {} as never,
    });
    const auditor = async (): Promise<BlockCoverageAuditResult> => ({
      blockAnchor: 'b0',
      findings: [{ verdict: 'UNREPRESENTED_CLAUSE', quote: 'правило', explanation: 'всё ещё пропущено', quoteVerified: true }],
      hasGap: true,
    });

    await expect(
      extractKnowledgeUnitsWithCompletenessAudit(
        [block('b0', 'правило')], 5, { runConfig: {} as never }, {} as never,
        { extractor, repairExtractor: repairUsing(extractor), auditor }
      )
    ).rejects.toThrow(/focused repair did not clear block b0: 3-round limit exhausted \(unresolved gap\)/i);
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
