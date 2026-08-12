import { describe, expect, it } from 'vitest';

import { buildExtractionPromptMessages, type SourceBlock } from '../knowledge-unit-extractor';
import { buildFocusedRepairPromptMessages } from '../audited-extraction';
import { buildExceptionRepairPromptMessages } from '../../../../scripts/run-aurora-fixture';
import {
  CONFIRMATORY_CLAUSE_RULE,
  CYCLES_VS_TIMES_RULE,
  NUMERIC_SPLIT_IDENTITY_RULE,
  SHARED_TAXONOMY_RULES,
} from '../prompt-taxonomy-rules';
import type { ExtractedKnowledgeUnit } from '../applicability/extraction';

/**
 * Единственный тест, который ловит КЛАСС дефекта, стоивший шести платных
 * прогонов 2026-08-12: одно правило таксономии живёт в трёх промптах, а
 * чинится в одном. Каждый отдельный тест «эта строка есть в этом промпте»
 * проходил — расходились именно ПРОМПТЫ МЕЖДУ СОБОЙ, и поймать это можно
 * только сравнив все три сразу.
 *
 * Если добавляется четвёртый промпт извлечения, он обязан появиться здесь.
 */

const BLOCK: SourceBlock = { anchor: 'b0', text: 'Действие выполняют в уединённом месте. Твёрдым предметом нельзя.' };

function unit(overrides: Partial<ExtractedKnowledgeUnit> = {}): ExtractedKnowledgeUnit {
  return {
    kind: 'PROCEDURE_STEP',
    statement: 'заполнитель',
    facets: {},
    triggerCondition: null,
    numericConstraint: null,
    extractionRef: 'u1',
    parentExtractionRef: null,
    sourceSpan: { anchor: 'b0', quote: 'Твёрдым предметом нельзя.' },
    evidenceByField: { statement: { anchor: 'b0', quote: 'Твёрдым предметом нельзя.' } },
    uncertainties: [],
    ...overrides,
  };
}

const basePrompt = (): string =>
  buildExtractionPromptMessages([BLOCK]).map((m) => m.content).join('\n');

const focusedRepairPrompt = (): string =>
  buildFocusedRepairPromptMessages({
    block: BLOCK,
    findings: [{ verdict: 'AMBIGUOUS', quote: 'Твёрдым предметом нельзя.', explanation: 'x', quoteVerified: true }],
    existingUnits: [unit()],
  }).map((m) => m.content).join('\n');

const exceptionRepairPrompt = (): string =>
  buildExceptionRepairPromptMessages({
    block: { anchor: BLOCK.anchor, text: BLOCK.text },
    malformed: [{ unitId: 'x', blockAnchor: BLOCK.anchor, missingFields: ['parentRuleRef'] }],
  }).map((m) => m.content).join('\n');

describe('shared taxonomy rules are identical across every extraction prompt', () => {
  const prompts: readonly (readonly [string, () => string])[] = [
    ['base extraction', basePrompt],
    ['focused repair', focusedRepairPrompt],
    ['exception repair', exceptionRepairPrompt],
  ];

  for (const [name, build] of prompts) {
    for (const rule of SHARED_TAXONOMY_RULES) {
      const label = rule.slice(0, 48).replace(/\s+/g, ' ');
      it(`${name} carries: ${label}…`, () => {
        expect(build()).toContain(rule);
      });
    }
  }

  // b14 (2026-08-12): exception repair had NONE of the accumulated
  // counter-examples and reproduced exactly the defect the other two prompts
  // had already learned — a neighbour's condition copied onto an
  // unconditional prohibition.
  it('exception repair specifically covers the unconditional-prohibition defect that killed run 6', () => {
    const prompt = exceptionRepairPrompt();
    expect(prompt).toContain('Безусловный запрет НЕ получает условие соседнего правила');
    expect(prompt).toContain(CONFIRMATORY_CLAUSE_RULE);
  });

  // The numeric rules apply where numericConstraint can be produced. Exception
  // repair keeps its own compact numericConstraint contract, so only the two
  // prompts that own numeric splitting are asserted here.
  it('numeric identity + unit-canonicalisation rules are shared by base and focused repair', () => {
    for (const build of [basePrompt, focusedRepairPrompt]) {
      expect(build()).toContain(NUMERIC_SPLIT_IDENTITY_RULE);
      expect(build()).toContain(CYCLES_VS_TIMES_RULE);
    }
  });
});
