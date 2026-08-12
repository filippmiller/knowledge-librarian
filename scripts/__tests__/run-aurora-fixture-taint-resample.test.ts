import { describe, expect, it, vi } from 'vitest';

import {
  assertTrustedIdentity,
  buildExceptionRepairPromptMessages,
  exceptionRepairResponseSchema,
  findMalformedExceptions,
  resolveMalformedExceptions,
  resolveTaintedCandidates,
} from '../run-aurora-fixture';
import { assignIdentity, type SourceBlockLocation } from '../../src/lib/knowledge/applicability/identity-assignment';
import type { ExtractedKnowledgeUnit } from '../../src/lib/knowledge/applicability/extraction';
import { OracleTaintError, type OracleTaintDetector } from '../../src/lib/eval/oracle-taint';
import {
  TRIGGER_FACT_KEYS,
  TRIGGER_FACT_REGISTRY,
} from '../../src/lib/knowledge/applicability/trigger-facts';

const BLOCK: SourceBlockLocation = {
  anchor: 'block-A',
  text: 'Основное правило. Обязательное исключение.',
  kind: 'LIST_ITEM',
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
      blockKind: 'LIST_ITEM',
      extractedStatements: [expect.objectContaining({ statement: 'Основное правило', quote: 'Основное правило.' })],
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

  // Real live-fixture bug (2026-08-12, block b8): the model correctly
  // returned an EXCEPTION_RULE linked to its sibling base rule within the
  // SAME single-block taint-retry response (parentExtractionRef: "base"),
  // but the namespacing step used to force parentExtractionRef to null
  // unconditionally for every replacement unit -- discarding a valid,
  // same-response link. Coverage audit then (correctly) flagged the
  // resulting parentless exception as malformed, and resolveTaintedCandidates
  // has no repair loop, so the whole run died on a defect the orchestration
  // code introduced, not the model. Fixed to prefix parentExtractionRef the
  // same way extractionRef is already prefixed, mirroring
  // resolveMalformedExceptions's namespacing just below.
  it('preserves a valid same-response parentExtractionRef instead of discarding it', async () => {
    const initial = assignIdentity([extracted()], new Map([[BLOCK.anchor, BLOCK]]), 'rev-1').units;
    const extractor = vi.fn(async () => ({
      units: [
        extracted({ statement: 'Основное правило', extractionRef: 'base' }),
        extracted({
          kind: 'EXCEPTION_RULE' as const,
          statement: 'Безопасное обязательное исключение',
          extractionRef: 'exception',
          parentExtractionRef: 'base',
          triggerCondition: { all: [{ fact: 'helperPresent', equals: false }] },
          sourceSpan: { anchor: BLOCK.anchor, quote: 'Обязательное исключение.' },
          evidenceByField: {
            statement: { anchor: BLOCK.anchor, quote: 'Обязательное исключение.' },
            triggerCondition: { anchor: BLOCK.anchor, quote: 'Обязательное исключение.' },
          },
        }),
      ],
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
      initial,
      new Map([[BLOCK.anchor, BLOCK]]),
      'rev-1',
      detector,
      extractor,
      auditor,
      { runConfig, maxTokens: 100 },
      1
    );

    const base = result.units.find((u) => u.statement === 'Основное правило')!;
    const exception = result.units.find((u) => u.kind === 'EXCEPTION_RULE')!;
    expect(base).toBeDefined();
    expect(exception.parentRuleRef).toBe(base.unitId);
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

describe('targeted malformed exception repair', () => {
  it('detects missing parent and trigger and sends their stable refs with explicit taxonomy', () => {
    const malformed = assignIdentity([
      extracted({ kind: 'EXCEPTION_RULE', triggerCondition: null }),
    ], new Map([[BLOCK.anchor, BLOCK]]), 'rev-1').units;
    const findings = findMalformedExceptions(malformed);
    const messages = buildExceptionRepairPromptMessages({
      block: { anchor: BLOCK.anchor, text: BLOCK.text },
      malformed: findings,
    });
    const prompt = messages.map((message) => message.content).join('\n');

    expect(findings).toEqual([expect.objectContaining({
      unitId: malformed[0].unitId,
      missingFields: ['parentRuleRef', 'triggerCondition'],
    })]);
    expect(prompt).toContain(malformed[0].unitId);
    expect(prompt).toContain('PROCEDURE_STEP');
    expect(prompt).toContain('TERM_DEFINITION');
    expect(prompt).toContain('настоящий EXCEPTION_RULE');
    expect(prompt).toContain('id, type, content и evidence ЗАПРЕЩЕНЫ');
    expect(prompt).toContain('"evidenceByField"');
    expect(prompt).toContain('resourceAvailability');
  });

  it('renders every trigger fact and enum value from the shared registry, never stale aliases', () => {
    const prompt = buildExceptionRepairPromptMessages({
      block: { anchor: BLOCK.anchor, text: BLOCK.text },
      malformed: [{
        unitId: 'malformed-unit',
        blockAnchor: BLOCK.anchor,
        missingFields: ['triggerCondition'],
      }],
    }).map((message) => message.content).join('\n');

    for (const key of TRIGGER_FACT_KEYS) {
      expect(prompt).toContain(key);
      const schema = TRIGGER_FACT_REGISTRY[key].valueSchema as { options?: readonly string[] };
      for (const value of schema.options ?? []) expect(prompt).toContain(value);
    }
    expect(prompt).toMatch(/JSON boolean true или false/);
    for (const forbidden of ['GIVEN', 'REFUSED', 'DIRECT']) {
      expect(prompt).not.toContain(forbidden);
    }
  });

  it('b4 repair keeps PUBLIC applicability when reclassifying the parentless example to PROCEDURE_STEP', () => {
    const b4 = 'Порядок толкования. Например, разрешённое краткое надавливание в общественном месте не превращается в разрешение на полноценное чесание через одежду.';
    const prompt = buildExceptionRepairPromptMessages({
      block: { anchor: 'b4', text: b4 },
      malformed: [{
        unitId: 'cdbc34701c28d991',
        blockAnchor: 'b4',
        missingFields: ['parentRuleRef'],
      }],
    }).map((message) => message.content).join('\n');

    expect(prompt).toContain('cdbc34701c28d991');
    expect(prompt).toContain('в общественном месте');
    expect(prompt).toContain('ЛЮБОГО kind, включая PROCEDURE_STEP');
    expect(prompt).toContain('privacyContext');
    expect(prompt).toContain('PUBLIC');
    expect(prompt).toContain('если X выражается закрытым каталогом, triggerCondition обязателен');
  });

  // Real live-fixture bug (2026-08-12, block b6): this prompt still carried a
  // stale explicit ban on "отсутствие воды" as a trigger, left over from
  // BEFORE resourceAvailability existed in the catalog (translation-oxu). The
  // catalog entry right above this sentence (trigger-facts.ts) already names
  // "при отсутствии воды допустим антисептик" as its canonical correct
  // example — the ban directly contradicted the catalog it sat next to in the
  // same prompt. Coverage audit correctly flagged the resulting
  // PROCEDURE_STEP+UNRECOGNIZED_TRIGGER_CONDITION as a structural gap, and
  // resolveMalformedExceptions has no further repair round, so the whole run
  // died on a self-contradiction in static prompt text, not a model mistake.
  it('classifies no-water as EXCEPTION_RULE with the catalogued resourceAvailability trigger', () => {
    const prompt = buildExceptionRepairPromptMessages({
      block: { anchor: 'b6', text: 'При отсутствии воды допустим кожный антисептик.' },
      malformed: [{
        unitId: 'water-unit',
        blockAnchor: 'b6',
        missingFields: ['triggerCondition'],
      }],
    }).map((message) => message.content).join('\n');

    expect(prompt).toContain('resourceAvailability');
    expect(prompt).toContain('UNAVAILABLE');
    expect(prompt).not.toContain('water_unavailable');
    expect(prompt).not.toContain('условие отсутствия воды не входит в закрытый каталог');
    expect(prompt).toContain('"DANGLING_PARENT_REF"');
  });

  it('rejects the stable malformed live response aliases id/type/content/evidence', () => {
    const liveMalformedShape = {
      units: [{
        id: 'u1',
        type: 'procedure',
        content: 'Основное правило.',
        evidence: { quote: 'Основное правило.' },
      }],
    };

    const parsed = exceptionRepairResponseSchema.safeParse(liveMalformedShape);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.join('.') === 'units.0.kind')).toBe(true);
      expect(parsed.error.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);
    }
  });

  it('rejects the second live response that invented water_unavailable', () => {
    const invalidException = {
      ...extracted({
        kind: 'EXCEPTION_RULE',
        statement: 'Если вода недоступна, выполнить действие.',
        extractionRef: 'exception',
        parentExtractionRef: 'parent',
        evidenceByField: {
          statement: { anchor: BLOCK.anchor, quote: 'Обязательное исключение.' },
          triggerCondition: { anchor: BLOCK.anchor, quote: 'Обязательное исключение.' },
        },
      }),
      triggerCondition: { all: [{ fact: 'water_unavailable', equals: true }] },
    } as unknown;
    const parsed = exceptionRepairResponseSchema.safeParse({
      units: [
        extracted({ extractionRef: 'parent' }),
        invalidException,
      ],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) =>
        issue.path.join('.').includes('triggerCondition')
      )).toBe(true);
    }
  });

  it('replaces only the affected block and preserves a valid parent/exception structure', async () => {
    const malformed = assignIdentity([
      extracted({
        kind: 'EXCEPTION_RULE',
        statement: 'Безопасная, но неполная оговорка',
        sourceSpan: { anchor: BLOCK.anchor, quote: 'Обязательное исключение.' },
        evidenceByField: { statement: { anchor: BLOCK.anchor, quote: 'Обязательное исключение.' } },
      }),
    ], new Map([[BLOCK.anchor, BLOCK]]), 'rev-1').units;
    const repairExtractor = vi.fn(async () => ({
      units: [
        extracted({ statement: 'Основное правило.', extractionRef: 'parent' }),
        extracted({
          kind: 'EXCEPTION_RULE',
          statement: 'Обязательное исключение.',
          extractionRef: 'exception',
          parentExtractionRef: 'parent',
          triggerCondition: { all: [{ fact: 'helperPresent', equals: true }] },
          sourceSpan: { anchor: BLOCK.anchor, quote: 'Обязательное исключение.' },
          evidenceByField: {
            statement: { anchor: BLOCK.anchor, quote: 'Обязательное исключение.' },
            triggerCondition: { anchor: BLOCK.anchor, quote: 'Обязательное исключение.' },
          },
        }),
      ],
      structuredResult: {} as never,
    }));
    const auditor = vi.fn(async () => ({
      blockAnchor: BLOCK.anchor,
      findings: [{ verdict: 'COVERED' as const, quote: '', explanation: '', quoteVerified: false }],
      hasGap: false,
      unresolved: false,
    }));

    const result = await resolveMalformedExceptions(
      malformed,
      new Map([[BLOCK.anchor, BLOCK]]),
      'rev-1',
      repairExtractor,
      auditor,
      { runConfig, maxTokens: 100 },
      2
    );

    const repairedException = result.units.find((unit) => unit.kind === 'EXCEPTION_RULE')!;
    expect(repairedException.parentRuleRef).not.toBeNull();
    expect(result.units.some((unit) => unit.unitId === repairedException.parentRuleRef)).toBe(true);
    expect(repairedException.triggerCondition).not.toBeNull();
    expect(result.repairLogs).toHaveLength(1);
    expect(result.auditResults).toHaveLength(1);
  });

  it('fails closed when bounded repair rounds keep returning a malformed exception', async () => {
    const malformed = assignIdentity([
      extracted({
        kind: 'EXCEPTION_RULE',
        statement: 'Безопасная оговорка',
        sourceSpan: { anchor: BLOCK.anchor, quote: 'Обязательное исключение.' },
        evidenceByField: { statement: { anchor: BLOCK.anchor, quote: 'Обязательное исключение.' } },
      }),
    ], new Map([[BLOCK.anchor, BLOCK]]), 'rev-1').units;
    const repairExtractor = vi.fn(async () => ({
      units: [extracted({
        kind: 'EXCEPTION_RULE',
        statement: 'Всё ещё неполная оговорка',
        sourceSpan: { anchor: BLOCK.anchor, quote: 'Обязательное исключение.' },
        evidenceByField: { statement: { anchor: BLOCK.anchor, quote: 'Обязательное исключение.' } },
      })],
      structuredResult: {} as never,
    }));
    const auditor = vi.fn(async () => ({
      blockAnchor: BLOCK.anchor,
      findings: [{ verdict: 'COVERED' as const, quote: '', explanation: '', quoteVerified: false }],
      hasGap: false,
      unresolved: false,
    }));

    await expect(resolveMalformedExceptions(
      malformed,
      new Map([[BLOCK.anchor, BLOCK]]),
      'rev-1',
      repairExtractor,
      auditor,
      { runConfig, maxTokens: 100 },
      2
    )).rejects.toThrow('did not converge after 2 round');
    expect(repairExtractor).toHaveBeenCalledTimes(2);
  });
});
