import { describe, expect, it } from 'vitest';
import { evaluateEvidenceGroupCoverage, RULE_9_EVIDENCE_GROUP, RULE_10_EVIDENCE_GROUP, type RequiredEvidenceGroup } from '../evidence-groups';
import type { PersistedKnowledgeUnit } from '@/lib/knowledge/applicability/identity-assignment';

/**
 * pre-retrieval hardening, Step 8. `case-grader.ts`'s own header comment
 * documents the confirmed gap: "Если экстракция раздробит правило 9
 * (согласие/перчатки/остановка) на несколько units и будет выбран только
 * один фрагмент, sourceRuleId всё равно засчитает правило целиком." This
 * generalizes `requiredNumerics`' per-selected-unit coverage aggregation
 * (case-grader.ts) from numeric constraints to arbitrary boolean/clause
 * coverage, via predicates over unit content — NOT unitId lists, because
 * unitId varies between extraction runs (`.claude/audits/2026-08-08-
 * extraction-stability-fragmentation-report.md`, §4: identical anchor+quote
 * gives identical unitId across run1/run2, but a fresh run isn't guaranteed
 * to reproduce the exact same evidence spans).
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
    sourceSpan: span('anchor-x', 'заполнитель'),
    evidenceByField: { statement: span('anchor-x', 'заполнитель') },
    uncertainties: [],
    sourceBlockAnchor: 'block-x',
    unitId: 'u-placeholder',
    contentHash: 'hash-placeholder',
    ...overrides,
  };
}

describe('evaluateEvidenceGroupCoverage — pure predicate-based coverage', () => {
  const GROUP: RequiredEvidenceGroup = {
    ruleId: 99,
    description: 'тестовое правило с тремя обязательными компонентами',
    requiredClauses: [
      { description: 'A', matches: (u) => u.statement.includes('A') },
      { description: 'B', matches: (u) => u.statement.includes('B') },
      { description: 'C', matches: (u) => u.statement.includes('C') },
    ],
  };

  it('все обязательные клаузы покрыты хотя бы одним selected unit каждая -> covered=true', () => {
    const result = evaluateEvidenceGroupCoverage(GROUP, [
      unit({ statement: 'содержит A' }),
      unit({ statement: 'содержит B' }),
      unit({ statement: 'содержит C' }),
    ]);
    expect(result.covered).toBe(true);
    expect(result.uncoveredClauseDescriptions).toEqual([]);
  });

  it('выбран только ОДИН фрагмент из трёх — covered=false, остальные названы', () => {
    const result = evaluateEvidenceGroupCoverage(GROUP, [unit({ statement: 'содержит A' })]);
    expect(result.covered).toBe(false);
    expect(result.uncoveredClauseDescriptions).toEqual(['B', 'C']);
  });

  it('альтернативная фрагментация одной клаузы — одна clause матчит несколько разных units, любой закрывает её', () => {
    const altGroup: RequiredEvidenceGroup = {
      ruleId: 99,
      description: 'клауза с альтернативными формулировками',
      requiredClauses: [
        { description: 'mobility', matches: (u) => /дотян|подвижн/.test(u.statement) },
      ],
    };
    const result = evaluateEvidenceGroupCoverage(altGroup, [unit({ statement: 'не может дотянуться' })]);
    expect(result.covered).toBe(true);
  });

  it('пустой selectedUnits -> covered=false, все клаузы названы', () => {
    const result = evaluateEvidenceGroupCoverage(GROUP, []);
    expect(result.covered).toBe(false);
    expect(result.uncoveredClauseDescriptions).toEqual(['A', 'B', 'C']);
  });
});

describe('RULE_9_EVIDENCE_GROUP — реальные компоненты из живого прогона (scratchpad/extraction-runs/run1, anchor fdea0ad3cb1caf58)', () => {
  // Реальные unitId/statement из подтверждённого --stage=extraction прогона на
  // учебном DOCX (не выдуманы, не из oracle): согласие, перчатки, остановка —
  // ровно три компонента, названные в шапке case-grader.ts.
  const CONSENT_UNIT = unit({
    unitId: '4997d91d73b11aa3',
    statement: 'Другой человек может выполнить почесание только после ясного согласия того, кому помогают.',
  });
  const GLOVES_UNIT = unit({
    unitId: 'c6db93b341eb1e60',
    statement: 'Помощник обязан надеть чистые одноразовые перчатки.',
  });
  const STOP_UNIT = unit({
    unitId: '4bef4675d1f027d2',
    statement: 'Помощник обязан немедленно остановиться по первой просьбе.',
  });
  const UNRELATED_UNIT = unit({
    unitId: 'd1ebb671a96e783b',
    statement: 'Помощник обязан соблюдать ограничения по силе и времени.',
  });

  it('все три компонента выбраны -> covered=true', () => {
    const result = evaluateEvidenceGroupCoverage(RULE_9_EVIDENCE_GROUP, [CONSENT_UNIT, GLOVES_UNIT, STOP_UNIT]);
    expect(result.covered).toBe(true);
  });

  it('выбран только фрагмент про согласие -> covered=false, перчатки и остановка названы', () => {
    const result = evaluateEvidenceGroupCoverage(RULE_9_EVIDENCE_GROUP, [CONSENT_UNIT]);
    expect(result.covered).toBe(false);
    expect(result.uncoveredClauseDescriptions.length).toBe(2);
  });

  it('посторонний unit того же блока (сила/время) НЕ закрывает ни одну из трёх обязательных клауз', () => {
    const result = evaluateEvidenceGroupCoverage(RULE_9_EVIDENCE_GROUP, [UNRELATED_UNIT]);
    expect(result.covered).toBe(false);
    expect(result.uncoveredClauseDescriptions.length).toBe(3);
  });
});

describe('RULE_10_EVIDENCE_GROUP — реальные компоненты (anchor aa2975a920553245)', () => {
  const REACHABILITY_UNIT = unit({
    unitId: 'bfb006458f3ec1db',
    statement:
      'Если человек не может дотянуться до участка рукой, допускается помощь ухаживающего лица либо чистая мягкая ткань, обёрнутая вокруг ладони.',
  });
  const SHARP_OBJECT_UNIT = unit({
    unitId: 'a71d3c30d52a863c',
    statement: 'Приспособление с твёрдым или острым концом применять нельзя, даже при ограниченной подвижности.',
  });
  // Тот же sourceBlockAnchor, но НЕ про подвижность — реальный пример, почему
  // "same sourceBlockAnchor" сам по себе не значит "одно логическое правило"
  // (задача явно предупреждает об этом допущении).
  const CHILD_SUPERVISION_UNIT = unit({
    unitId: 'b113efdef1c94d5e',
    statement: 'Для ребёнка продолжительность и гигиену контролирует взрослый.',
  });

  it('оба компонента подвижности выбраны -> covered=true', () => {
    const result = evaluateEvidenceGroupCoverage(RULE_10_EVIDENCE_GROUP, [REACHABILITY_UNIT, SHARP_OBJECT_UNIT]);
    expect(result.covered).toBe(true);
  });

  it('выбран только reachability-фрагмент -> covered=false', () => {
    const result = evaluateEvidenceGroupCoverage(RULE_10_EVIDENCE_GROUP, [REACHABILITY_UNIT]);
    expect(result.covered).toBe(false);
    expect(result.uncoveredClauseDescriptions.length).toBe(1);
  });

  it('unit того же anchor, но не о подвижности (child supervision) — НЕ засчитывается ни за один компонент правила 10', () => {
    const result = evaluateEvidenceGroupCoverage(RULE_10_EVIDENCE_GROUP, [CHILD_SUPERVISION_UNIT]);
    expect(result.covered).toBe(false);
    expect(result.uncoveredClauseDescriptions.length).toBe(2);
  });
});
