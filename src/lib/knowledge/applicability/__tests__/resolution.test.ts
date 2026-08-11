import { describe, expect, it } from 'vitest';
import { evaluateUnitEligibility } from '../eligibility';
import type { KnowledgeUnitKind } from '../kinds';
import { RESOLUTION_REASON_CODES } from '../reasons';
import {
  resolveKnowledgeSet,
  type EvaluatedCandidate,
  type NumericConstraint,
} from '../resolution';
import { evaluateScope, type ScopeDecision } from '../scope';
import { evaluateTrigger, type TriggerCondition, type TriggerDecision } from '../trigger';
import {
  buildProfile,
  buildQuery,
  buildRequestContext,
  buildUnit,
  fact,
  known,
  scoped,
  unknown,
} from './helpers';

/**
 * ВЛАДЕЛЕЦ РЕШЕНИЯ: `resolveKnowledgeSet`.
 * ПОКРЫВАЕТ: truth table §4 — §4.1 п.1 (приоритет специального над общим),
 * §4.1 п.2 в части ПОСЛЕДСТВИЙ активации (сама активация — владение
 * `evaluateTrigger`), §4.1 п.3 и §4.2 (числовые конфликты).
 *
 * Кандидаты собираются РЕАЛЬНЫМИ evaluator'ами, а не рисуются руками там, где
 * это возможно: иначе suite доказывала бы согласованность выдуманных решений.
 */

const SCENARIO = 'apostille';
const QUERY = buildQuery({ facets: { scenario: known([SCENARIO]) } });

function scopeOf(kind: KnowledgeUnitKind, query = QUERY): ScopeDecision {
  return evaluateScope(buildProfile(kind, { scenario: scoped([SCENARIO]) }), query);
}

function eligibleDecision() {
  return evaluateUnitEligibility(buildUnit(), buildRequestContext({ audience: 'internal' }));
}

function candidate(overrides: Partial<EvaluatedCandidate> & { unitId: string }): EvaluatedCandidate {
  const kind = overrides.kind ?? 'PROCEDURE_STEP';
  return {
    kind,
    eligibility: overrides.eligibility ?? eligibleDecision(),
    scope: overrides.scope ?? scopeOf(kind),
    trigger: overrides.trigger ?? null,
    parentRuleRef: overrides.parentRuleRef ?? null,
    supersedes: overrides.supersedes ?? [],
    numericConstraint: overrides.numericConstraint ?? null,
    ...overrides,
  };
}

const IN_PUBLIC: TriggerCondition = { all: [{ fact: 'privacyContext', equals: 'PUBLIC' }] };

function triggerIn(privacy: 'PUBLIC' | 'PRIVATE' | null): TriggerDecision {
  return evaluateTrigger(
    IN_PUBLIC,
    buildQuery({ triggerFacts: privacy === null ? {} : { privacyContext: fact(privacy) } })
  );
}

function triggerFactDecision(
  factKey: 'consentStatus' | 'reachability',
  required: 'EXPLICIT' | 'LIMITED',
  actual: 'EXPLICIT' | 'ABSENT' | 'LIMITED' | 'NORMAL' | null
): TriggerDecision {
  const condition: TriggerCondition = factKey === 'consentStatus'
    ? { all: [{ fact: 'consentStatus', equals: required as 'EXPLICIT' }] }
    : { all: [{ fact: 'reachability', equals: required as 'LIMITED' }] };
  return evaluateTrigger(
    condition,
    buildQuery({ triggerFacts: actual === null ? {} : { [factKey]: fact(actual) } })
  );
}

const seconds = (value: number): NumericConstraint => ({
  factKey: 'max_hold_seconds',
  value,
  unit: 'seconds',
});

describe('§4.1 п.1 — «применяются все»: несвязанные MATCH не конфликтуют', () => {
  it('три шага процедуры одного сценария идут в синтез вместе', () => {
    const decision = resolveKnowledgeSet(
      [candidate({ unitId: 'r1' }), candidate({ unitId: 'r2' }), candidate({ unitId: 'r3' })],
      QUERY
    );

    expect(decision.selected).toEqual(['r1', 'r2', 'r3']);
    expect(decision.disposition).toBe('ANSWER');
    expect(decision.excluded).toEqual([]);
    expect(decision.requiresHumanReview).toBe(false);
  });

  it('более специфичный сценарий сам по себе НИКОГО не вытесняет — только явные связи', () => {
    // Исправление P0 №2: «два несвязанных MATCH → CONFLICT» — неверное
    // прочтение. Специфичность выражается через parentRuleRef/supersedes.
    const general = candidate({
      unitId: 'general',
      scope: evaluateScope(
        buildProfile('PROCEDURE_STEP', { scenario: scoped(['apostille']) }),
        buildQuery({ facets: { scenario: known(['apostille.zags.spb']) } })
      ),
    });
    const specific = candidate({
      unitId: 'specific',
      scope: evaluateScope(
        buildProfile('PROCEDURE_STEP', { scenario: scoped(['apostille.zags']) }),
        buildQuery({ facets: { scenario: known(['apostille.zags.spb']) } })
      ),
    });

    const decision = resolveKnowledgeSet([general, specific], QUERY);

    expect(decision.selected).toEqual(['general', 'specific']);
    expect(decision.overridden).toEqual([]);
  });

  it('TERM_DEFINITION участвует наравне с шагами процедуры', () => {
    const decision = resolveKnowledgeSet(
      [
        candidate({ unitId: 'term', kind: 'TERM_DEFINITION', scope: scopeOf('TERM_DEFINITION') }),
        candidate({ unitId: 'step' }),
      ],
      QUERY
    );

    expect(decision.selected).toEqual(['term', 'step']);
  });
});

describe('trigger applicability applies to every knowledge kind', () => {
  it('privacy-conditioned PROCEDURE_STEP with unknown privacy is selected as conditional evidence', () => {
    const decision = resolveKnowledgeSet(
      [candidate({ unitId: 'base' }), candidate({ unitId: 'public-step', trigger: triggerIn(null) })],
      QUERY
    );
    expect(decision.disposition).toBe('ANSWER');
    expect(decision.selected).toContain('public-step');
    expect(decision.selectedApplicability).toContainEqual(expect.objectContaining({ unitId: 'public-step', mode: 'CONDITIONAL' }));
    expect(decision.reasons).toContain('privacyContext_unknown');
  });

  it('consent-conditioned PROCEDURE_STEP is selected as negative evidence when consent is absent', () => {
    const decision = resolveKnowledgeSet(
      [candidate({ unitId: 'consent-step', trigger: triggerFactDecision('consentStatus', 'EXPLICIT', 'ABSENT'), negativeInferenceAllowed: true })],
      QUERY
    );
    expect(decision.selected).toEqual([]);
    expect(decision.negativeEvidence).toEqual(['consent-step']);
    expect(decision.selectedApplicability).toContainEqual(expect.objectContaining({ unitId: 'consent-step', mode: 'NEGATIVE' }));
    expect(decision.reasons).toContain('consentStatus_violated');
  });

  it('unknown consent procedure remains answerable as an explicit conditional branch', () => {
    const decision = resolveKnowledgeSet(
      [candidate({ unitId: 'consent-step', trigger: triggerFactDecision('consentStatus', 'EXPLICIT', null) })],
      QUERY
    );
    expect(decision.disposition).toBe('ANSWER');
    expect(decision.selectedApplicability).toContainEqual(
      expect.objectContaining({ unitId: 'consent-step', mode: 'CONDITIONAL' })
    );
    expect(decision.reasons).toContain('consentStatus_unknown');
  });

  it('active reachability branch and unknown consent helper branch answer together', () => {
    const decision = resolveKnowledgeSet(
      [
        candidate({ unitId: 'limited-step', trigger: triggerFactDecision('reachability', 'LIMITED', 'LIMITED') }),
        candidate({ unitId: 'helper-consent', trigger: triggerFactDecision('consentStatus', 'EXPLICIT', null) }),
      ],
      QUERY
    );
    expect(decision.disposition).toBe('ANSWER');
    expect(decision.selected).toEqual(['limited-step', 'helper-consent']);
    expect(decision.selectedApplicability).toContainEqual(
      expect.objectContaining({ unitId: 'helper-consent', mode: 'CONDITIONAL' })
    );
  });

  it('semantically irrelevant inactive procedure is excluded but preserves its trigger reason', () => {
    const decision = resolveKnowledgeSet(
      [candidate({
        unitId: 'irrelevant-consent',
        trigger: triggerFactDecision('consentStatus', 'EXPLICIT', 'ABSENT'),
        semanticRelevance: 'IRRELEVANT',
      })],
      QUERY
    );
    expect(decision.selected).toEqual([]);
    expect(decision.excluded).toContainEqual({ unitId: 'irrelevant-consent', reason: 'exception_trigger_inactive' });
    expect(decision.reasons).toContain('consentStatus_violated');
  });

  it('reachability-conditioned PROCEDURE_STEP is selected only when LIMITED is active', () => {
    const active = resolveKnowledgeSet(
      [candidate({ unitId: 'reach-step', trigger: triggerFactDecision('reachability', 'LIMITED', 'LIMITED') })],
      QUERY
    );
    const inactive = resolveKnowledgeSet(
      [candidate({ unitId: 'reach-step', trigger: triggerFactDecision('reachability', 'LIMITED', 'NORMAL'), negativeInferenceAllowed: true })],
      QUERY
    );
    expect(active.selected).toEqual(['reach-step']);
    expect(active.disposition).toBe('ANSWER');
    expect(inactive.selected).toEqual([]);
    expect(inactive.negativeEvidence).toEqual(['reach-step']);
    expect(inactive.selectedApplicability).toContainEqual(expect.objectContaining({ unitId: 'reach-step', mode: 'NEGATIVE' }));
  });

  it('false generic sufficient condition is excluded and cannot prove a denial', () => {
    const decision = resolveKnowledgeSet(
      [candidate({ unitId: 'if-x-then-y', trigger: triggerFactDecision('consentStatus', 'EXPLICIT', 'ABSENT') })],
      QUERY
    );
    expect(decision.negativeEvidence).toEqual([]);
    expect(decision.excluded).toContainEqual({ unitId: 'if-x-then-y', reason: 'exception_trigger_inactive' });
    expect(decision.disposition).toBe('HOLD');
  });

  it('inactive necessary-condition evidence cannot supersede or numerically conflict with operative evidence', () => {
    const active = candidate({
      unitId: 'active',
      numericConstraint: { factKey: 'maximum', value: 5, unit: 'times' },
    });
    const inactiveNecessary = candidate({
      unitId: 'negative',
      trigger: triggerFactDecision('consentStatus', 'EXPLICIT', 'ABSENT'),
      negativeInferenceAllowed: true,
      numericConstraint: { factKey: 'maximum', value: 3, unit: 'times' },
      supersedes: ['active'],
    });
    const decision = resolveKnowledgeSet([active, inactiveNecessary], QUERY);
    expect(decision.selected).toEqual(['active']);
    expect(decision.negativeEvidence).toEqual(['negative']);
    expect(decision.numericConflicts).toEqual([]);
    expect(decision.excluded).not.toContainEqual(expect.objectContaining({ unitId: 'active' }));
  });
});

describe('§4.1 п.2 — последствия активации исключения', () => {
  it('активное исключение переопределяет ТОЛЬКО своего родителя', () => {
    const decision = resolveKnowledgeSet(
      [
        candidate({ unitId: 'rule-1' }),
        candidate({ unitId: 'rule-2' }),
        candidate({
          unitId: 'rule-5',
          kind: 'EXCEPTION_RULE',
          scope: scopeOf('EXCEPTION_RULE'),
          trigger: triggerIn('PUBLIC'),
          parentRuleRef: 'rule-1',
        }),
      ],
      QUERY
    );

    expect(decision.overridden).toEqual([{ unitId: 'rule-1', byUnitId: 'rule-5' }]);
    expect(decision.selected).toEqual(['rule-2', 'rule-5']);
    expect(decision.reasons).toContain('parent_overridden_by_exception');
    expect(decision.disposition).toBe('ANSWER');
  });

  it('Q05-N1: неактивное исключение выбывает, но общее правило остаётся', () => {
    const decision = resolveKnowledgeSet(
      [
        candidate({ unitId: 'rule-1' }),
        candidate({ unitId: 'rule-3' }),
        candidate({
          unitId: 'rule-5',
          kind: 'EXCEPTION_RULE',
          scope: scopeOf('EXCEPTION_RULE'),
          trigger: triggerIn('PRIVATE'),
          parentRuleRef: 'rule-1',
        }),
      ],
      QUERY
    );

    expect(decision.selected).toEqual(['rule-1', 'rule-3']);
    expect(decision.excluded).toEqual([{ unitId: 'rule-5', reason: 'exception_trigger_inactive' }]);
    expect(decision.overridden).toEqual([]);
    expect(decision.disposition).toBe('ANSWER');
  });

  it('Q01-M1 / Q05-M1: условие неизвестно и решает между правилом и исключением → CLARIFY', () => {
    const decision = resolveKnowledgeSet(
      [
        candidate({ unitId: 'rule-1' }),
        candidate({
          unitId: 'rule-5',
          kind: 'EXCEPTION_RULE',
          scope: scopeOf('EXCEPTION_RULE'),
          trigger: triggerIn(null),
          parentRuleRef: 'rule-1',
        }),
      ],
      QUERY
    );

    expect(decision.disposition).toBe('CLARIFY');
    expect(decision.clarificationNeeds.triggerFacts).toEqual(['privacyContext']);
    expect(decision.reasons).toContain('clarification_required_missing_trigger_fact');

    // Ни угадывания, ни пустого множества кандидатов: общее правило осталось
    // выбранным, исключение — удержанным, и ни одно не выброшено.
    expect(decision.selected).toEqual(['rule-1']);
    expect(decision.undetermined).toEqual([
      { unitId: 'rule-5', reason: 'exception_trigger_unknown' },
    ]);
    expect(decision.excluded).toEqual([]);
  });

  it('Q01-M1 / Q05-M1 РЕАЛЬНЫЙ случай: условие неизвестно, а parentRuleRef ПУСТ (экстракция не связала исключение с родителем) — всё равно CLARIFY, не молчаливый ANSWER', () => {
    // Живой прогон (goal-shift benchmark, 2026-08-09): реальная экстракция
    // НЕ линкует это конкретное исключение (публичное место) ни к какому
    // родителю — parentRuleRef приходит null, не "ссылка есть, но не в
    // выдаче" (тот случай уже покрыт следующим тестом и остаётся ANSWER).
    // Старая логика isDecisive требовала candidate.parentRuleRef !== null,
    // поэтому неопределённость этого исключения тихо игнорировалась, и
    // движок отвечал общим правилом, как будто исключения не существует —
    // хотя оно РЕАЛЬНО могло изменить ответ (публично vs приватно).
    //
    // Отличие от следующего теста ("БЕЗ конкуренции") принципиально: там
    // exception явно называет родителя, которого просто нет в текущей
    // выдаче — известно, что спорить не с чем. Здесь родитель НЕИЗВЕСТЕН
    // вовсе, и любое уверенно выбранное правило МОГЛО БЫ быть тем, что это
    // исключение переопределяет — рисковать нельзя.
    const decision = resolveKnowledgeSet(
      [
        candidate({ unitId: 'rule-1' }),
        candidate({
          unitId: 'rule-5',
          kind: 'EXCEPTION_RULE',
          scope: scopeOf('EXCEPTION_RULE'),
          trigger: triggerIn(null),
          parentRuleRef: null,
        }),
      ],
      QUERY
    );

    expect(decision.disposition).toBe('CLARIFY');
    expect(decision.clarificationNeeds.triggerFacts).toEqual(['privacyContext']);
    expect(decision.selected).toEqual(['rule-1']);
    expect(decision.undetermined).toEqual([{ unitId: 'rule-5', reason: 'exception_trigger_unknown' }]);
  });

  it('неизвестное условие релевантного кандидата требует уточнения даже без явной конкуренции', () => {
    // После content-relevance gate кандидат уже признан способным менять
    // ответ; неизвестный trigger нельзя молча считать неактивным.
    const decision = resolveKnowledgeSet(
      [
        candidate({ unitId: 'rule-7' }),
        candidate({
          unitId: 'rule-5',
          kind: 'EXCEPTION_RULE',
          scope: scopeOf('EXCEPTION_RULE'),
          trigger: triggerIn(null),
          parentRuleRef: 'rule-1-отсутствует-в-выдаче',
        }),
      ],
      QUERY
    );

    expect(decision.disposition).toBe('CLARIFY');
    expect(decision.selected).toEqual(['rule-7']);
    expect(decision.undetermined).toEqual([
      { unitId: 'rule-5', reason: 'exception_trigger_unknown' },
    ]);
    expect(decision.clarificationNeeds.triggerFacts).toEqual(['privacyContext']);
  });

  it('EXCEPTION_RULE без triggerCondition — достоверный дефект данных, а не пробел', () => {
    const decision = resolveKnowledgeSet(
      [
        candidate({ unitId: 'rule-1' }),
        candidate({
          unitId: 'rule-5',
          kind: 'EXCEPTION_RULE',
          scope: scopeOf('EXCEPTION_RULE'),
          trigger: null,
          parentRuleRef: 'rule-1',
        }),
      ],
      QUERY
    );

    expect(decision.excluded).toEqual([{ unitId: 'rule-5', reason: 'exception_without_trigger' }]);
    expect(decision.requiresHumanReview).toBe(true);
    expect(decision.selected).toEqual(['rule-1']);
  });

  it('активное исключение со scope=UNKNOWN не переопределяет никого — оно само под вопросом', () => {
    const decision = resolveKnowledgeSet(
      [
        candidate({ unitId: 'rule-1' }),
        candidate({
          unitId: 'rule-5',
          kind: 'EXCEPTION_RULE',
          scope: evaluateScope(
            buildProfile('EXCEPTION_RULE', { scenario: { state: 'UNKNOWN' } }),
            QUERY
          ),
          trigger: triggerIn('PUBLIC'),
          parentRuleRef: 'rule-1',
        }),
      ],
      QUERY
    );

    expect(decision.overridden).toEqual([]);
    expect(decision.selected).toEqual(['rule-1']);
    expect(decision.undetermined).toEqual([{ unitId: 'rule-5', reason: 'scope_unknown_held' }]);
  });
});

describe('§4.1 п.3 / §4.2 — числовые конфликты', () => {
  const priceCandidate = (unitId: string, constraint: NumericConstraint | null) =>
    candidate({
      unitId,
      kind: 'PRICE_RULE',
      scope: evaluateScope(
        buildProfile('PRICE_RULE', {
          scenario: scoped([SCENARIO]),
          service: scoped(['apostille.zags']),
        }),
        buildQuery({ facets: { scenario: known([SCENARIO]), service: known(['apostille.zags']) } })
      ),
      numericConstraint: constraint,
    });

  it('разные значения одного факта без supersedes → человек', () => {
    const decision = resolveKnowledgeSet(
      [priceCandidate('p1', seconds(3)), priceCandidate('p2', seconds(5))],
      QUERY
    );

    expect(decision.requiresHumanReview).toBe(true);
    expect(decision.disposition).toBe('HOLD');
    expect(decision.numericConflicts).toEqual([
      {
        factKey: 'max_hold_seconds',
        reason: 'numeric_conflict_unresolved',
        entries: [
          { unitId: 'p1', value: 3, unit: 'seconds' },
          { unitId: 'p2', value: 5, unit: 'seconds' },
        ],
      },
    ]);
  });

  it('одинаковые значения одного факта конфликтом не являются', () => {
    const decision = resolveKnowledgeSet(
      [priceCandidate('p1', seconds(3)), priceCandidate('p2', seconds(3))],
      QUERY
    );

    expect(decision.numericConflicts).toEqual([]);
    expect(decision.disposition).toBe('ANSWER');
  });

  it('один факт в разных единицах — сравнивать нечего, это дефект данных', () => {
    const decision = resolveKnowledgeSet(
      [
        priceCandidate('p1', seconds(3)),
        priceCandidate('p2', { factKey: 'max_hold_seconds', value: 3, unit: 'minutes' }),
      ],
      QUERY
    );

    expect(decision.numericConflicts[0]?.reason).toBe('numeric_unit_mismatch');
    expect(decision.requiresHumanReview).toBe(true);
  });

  it('разные факты не конфликтуют между собой', () => {
    const decision = resolveKnowledgeSet(
      [
        priceCandidate('p1', seconds(3)),
        priceCandidate('p2', { factKey: 'max_cycles', value: 3, unit: 'cycles' }),
      ],
      QUERY
    );

    expect(decision.numericConflicts).toEqual([]);
    expect(decision.disposition).toBe('ANSWER');
  });

  it('явный supersedes снимает конфликт без человека', () => {
    const decision = resolveKnowledgeSet(
      [
        candidate({ ...priceCandidate('p-new', seconds(5)), supersedes: ['p-old'] }),
        priceCandidate('p-old', seconds(3)),
      ],
      QUERY
    );

    expect(decision.numericConflicts).toEqual([]);
    expect(decision.selected).toEqual(['p-new']);
    expect(decision.excluded).toEqual([
      { unitId: 'p-old', reason: 'superseded_by_newer_unit', byUnitId: 'p-new' },
    ]);
    expect(decision.disposition).toBe('ANSWER');
  });

  it('цепочка замен снимается целиком: v3 → v2 → v1 оставляет только v3', () => {
    const decision = resolveKnowledgeSet(
      [
        candidate({ ...priceCandidate('v1', seconds(1)) }),
        candidate({ ...priceCandidate('v2', seconds(2)), supersedes: ['v1'] }),
        candidate({ ...priceCandidate('v3', seconds(3)), supersedes: ['v2'] }),
      ],
      QUERY
    );

    expect(decision.selected).toEqual(['v3']);
    expect(decision.numericConflicts).toEqual([]);
    expect(decision.disposition).toBe('ANSWER');
  });

  it('результат замены не зависит от порядка кандидатов в выдаче', () => {
    const build = (order: readonly string[]) => {
      const units: Record<string, EvaluatedCandidate> = {
        v1: candidate({ ...priceCandidate('v1', seconds(1)) }),
        v2: candidate({ ...priceCandidate('v2', seconds(2)), supersedes: ['v1'] }),
        v3: candidate({ ...priceCandidate('v3', seconds(3)), supersedes: ['v2'] }),
      };
      return resolveKnowledgeSet(
        order.map((id) => units[id]),
        QUERY
      );
    };

    expect(build(['v1', 'v2', 'v3']).selected).toEqual(build(['v3', 'v2', 'v1']).selected);
    expect(build(['v2', 'v3', 'v1']).selected).toEqual(['v3']);
  });

  it('взаимная замена не схлопывает набор в пустой — она уходит человеку', () => {
    const decision = resolveKnowledgeSet(
      [
        candidate({ ...priceCandidate('a', seconds(3)), supersedes: ['b'] }),
        candidate({ ...priceCandidate('b', seconds(5)), supersedes: ['a'] }),
      ],
      QUERY
    );

    expect(decision.selected).toEqual(['a', 'b']);
    expect(decision.excluded).toEqual([]);
    expect(decision.reasons).toContain('supersedes_cycle_unresolved');
    expect(decision.requiresHumanReview).toBe(true);
    expect(decision.disposition).toBe('HOLD');
  });

  it('замена на кандидата, которого нет в выдаче, никого не трогает', () => {
    const decision = resolveKnowledgeSet(
      [candidate({ ...priceCandidate('p1', seconds(3)), supersedes: ['её-нет-в-выдаче'] })],
      QUERY
    );

    expect(decision.selected).toEqual(['p1']);
    expect(decision.excluded).toEqual([]);
  });

  it('§4.2: число в прозе (без структурного поля) governance не блокирует', () => {
    const decision = resolveKnowledgeSet(
      [priceCandidate('p1', null), priceCandidate('p2', null)],
      QUERY
    );

    expect(decision.numericConflicts).toEqual([]);
    expect(decision.disposition).toBe('ANSWER');
  });

  it('§4.2: сравнение требует структурного поля на ОБОИХ unit’ах', () => {
    const decision = resolveKnowledgeSet(
      [priceCandidate('p1', seconds(3)), priceCandidate('p2', null)],
      QUERY
    );

    expect(decision.numericConflicts).toEqual([]);
    expect(decision.requiresHumanReview).toBe(false);
  });

  it('удержанный кандидат в числовом сравнении не участвует, но заставляет уточнить', () => {
    const held = candidate({
      unitId: 'p-held',
      kind: 'PRICE_RULE',
      scope: evaluateScope(
        buildProfile('PRICE_RULE', {
          scenario: scoped([SCENARIO]),
          service: scoped(['apostille.zags']),
        }),
        buildQuery({ facets: { scenario: known([SCENARIO]), service: unknown() } })
      ),
      numericConstraint: seconds(9),
    });

    const decision = resolveKnowledgeSet([priceCandidate('p1', seconds(3)), held], QUERY);

    expect(decision.numericConflicts).toEqual([]);
    expect(decision.selected).toEqual(['p1']);
    expect(decision.disposition).toBe('CLARIFY');
    expect(decision.clarificationNeeds.facets).toEqual(['service']);
  });
});

describe('жёсткая фильтрация не убивает recall', () => {
  it('явный CONFLICT — единственное основание выбросить кандидата', () => {
    const conflicting = candidate({
      unitId: 'other-branch',
      scope: evaluateScope(
        buildProfile('PROCEDURE_STEP', { scenario: scoped(['apostille.min_justice']) }),
        buildQuery({ facets: { scenario: known(['apostille.zags.spb']) } })
      ),
    });

    const decision = resolveKnowledgeSet([candidate({ unitId: 'ok' }), conflicting], QUERY);

    expect(decision.excluded).toEqual([{ unitId: 'other-branch', reason: 'scope_conflict' }]);
    expect(decision.selected).toEqual(['ok']);
  });

  it('UNKNOWN кандидата не выбрасывает — он удержан и виден', () => {
    const held = candidate({
      unitId: 'held',
      scope: evaluateScope(buildProfile('PROCEDURE_STEP', { scenario: { state: 'UNKNOWN' } }), QUERY),
    });

    const decision = resolveKnowledgeSet([candidate({ unitId: 'ok' }), held], QUERY);

    expect(decision.excluded).toEqual([]);
    expect(decision.undetermined).toEqual([{ unitId: 'held', reason: 'scope_unknown_held' }]);
    expect(decision.selected).toEqual(['ok']);
  });

  it('негодный кандидат выбывает по достоверному основанию', () => {
    const decision = resolveKnowledgeSet(
      [
        candidate({
          unitId: 'archived',
          eligibility: evaluateUnitEligibility(
            buildUnit({ status: 'DEPRECATED' }),
            buildRequestContext()
          ),
        }),
      ],
      QUERY
    );

    expect(decision.excluded).toEqual([{ unitId: 'archived', reason: 'candidate_ineligible' }]);
    expect(decision.disposition).toBe('HOLD');
    expect(decision.reasons).toContain('no_selected_candidates');
  });

  it('недостающая фасета при отсутствии выбора даёт CLARIFY, а не пустоту и не выбор наугад', () => {
    const held = candidate({
      unitId: 'delivery',
      kind: 'DELIVERY_RULE',
      scope: evaluateScope(
        buildProfile('DELIVERY_RULE', {
          scenario: scoped([SCENARIO]),
          deliveryCity: scoped(['spb']),
        }),
        buildQuery({ facets: { scenario: known([SCENARIO]), deliveryCity: unknown() } })
      ),
    });

    const decision = resolveKnowledgeSet([held], QUERY);

    expect(decision.disposition).toBe('CLARIFY');
    expect(decision.clarificationNeeds.facets).toEqual(['deliveryCity']);
    expect(decision.reasons).toContain('clarification_required_missing_facet');
    expect(decision.undetermined).toHaveLength(1);
    expect(decision.excluded).toEqual([]);
  });

  it('единственный кандидат-потомок → CLARIFY «какая именно процедура», а не немой HOLD', () => {
    // Находка кросс-ревью. Раньше `missingFacets` был пуст (в запросе сценарий
    // ЕСТЬ, просто он грубее профиля), поэтому уточнять было «нечем», и
    // система молчала, хотя вопрос «какая именно?» очевиден.
    const leaf = candidate({
      unitId: 'leaf',
      scope: evaluateScope(
        buildProfile('PROCEDURE_STEP', { scenario: scoped(['apostille.zags.spb']) }),
        buildQuery({ facets: { scenario: known(['apostille']) } })
      ),
    });

    const decision = resolveKnowledgeSet([leaf], buildQuery({ facets: { scenario: known(['apostille']) } }));

    expect(decision.disposition).toBe('CLARIFY');
    expect(decision.clarificationNeeds.facets).toEqual(['scenario']);
    expect(decision.undetermined).toHaveLength(1);
  });

  it('запрос только с отрицанием → CLARIFY, а не немой HOLD', () => {
    const query = buildQuery({ facets: { scenario: known([], ['apostille.min_justice']) } });
    const held = candidate({
      unitId: 'x',
      scope: evaluateScope(
        buildProfile('PROCEDURE_STEP', { scenario: scoped(['apostille.zags']) }),
        query
      ),
    });

    const decision = resolveKnowledgeSet([held], query);

    expect(decision.disposition).toBe('CLARIFY');
    expect(decision.clarificationNeeds.facets).toEqual(['scenario']);
  });

  it('неизвестность, которую нельзя снять вопросом, уходит человеку, а не в уверенный ответ', () => {
    // Профиль не размечен — спрашивать пользователя бессмысленно, правит
    // человек в базе. HOLD с отдельным кодом, не CLARIFY и не ANSWER.
    const unmarked = candidate({
      unitId: 'unmarked',
      scope: evaluateScope(buildProfile('PROCEDURE_STEP', { scenario: { state: 'UNKNOWN' } }), QUERY),
    });

    const decision = resolveKnowledgeSet([unmarked], QUERY);

    expect(decision.disposition).toBe('HOLD');
    expect(decision.requiresHumanReview).toBe(true);
    expect(decision.reasons).toContain('knowledge_gap_requires_human_review');
    expect(decision.clarificationNeeds.facets).toEqual([]);
    expect(decision.undetermined).toHaveLength(1);
  });

  it('исключение не отвечает в одиночку, пока его родитель не определён', () => {
    // Находка кросс-ревью (P0). Исключение прошло §3 и активировалось, а
    // правило, которое оно ПЕРЕОПРЕДЕЛЯЕТ, осталось неопределённым — раньше
    // это давало ANSWER одним исключением, то есть поправку без правила.
    const decision = resolveKnowledgeSet(
      [
        candidate({
          unitId: 'rule-1',
          scope: evaluateScope(
            buildProfile('PROCEDURE_STEP', { scenario: { state: 'UNKNOWN' } }),
            QUERY
          ),
        }),
        candidate({
          unitId: 'rule-5',
          kind: 'EXCEPTION_RULE',
          scope: scopeOf('EXCEPTION_RULE'),
          trigger: triggerIn('PUBLIC'),
          parentRuleRef: 'rule-1',
        }),
      ],
      QUERY
    );

    expect(decision.disposition).not.toBe('ANSWER');
    expect(decision.disposition).toBe('HOLD');
    expect(decision.requiresHumanReview).toBe(true);
    expect(decision.reasons).toContain('exception_parent_undetermined');
    // Родитель по-прежнему виден, а не выброшен.
    expect(decision.undetermined).toEqual([{ unitId: 'rule-1', reason: 'scope_unknown_held' }]);
  });

  it('исключение БЕЗ родителя не отвечает как самостоятельное правило', () => {
    const decision = resolveKnowledgeSet(
      [
        candidate({
          unitId: 'orphan-exception',
          kind: 'EXCEPTION_RULE',
          scope: scopeOf('EXCEPTION_RULE'),
          trigger: triggerIn('PUBLIC'),
          parentRuleRef: null,
        }),
      ],
      QUERY
    );

    expect(decision.disposition).not.toBe('ANSWER');
    expect(decision.requiresHumanReview).toBe(true);
    expect(decision.reasons).toContain('exception_without_parent');
  });

  it('исключение не отвечает в одиночку, когда родителя вообще нет среди кандидатов', () => {
    // Находка Codex. `null` и «родитель удержан» ловились, а «ссылка есть, но
    // родителя в выборке нет» — нет: шаг переопределения просто ничего не делал,
    // и исключение оставалось единственным выбранным, то есть отвечало.
    const decision = resolveKnowledgeSet(
      [
        candidate({
          unitId: 'rule-5',
          kind: 'EXCEPTION_RULE',
          scope: scopeOf('EXCEPTION_RULE'),
          trigger: triggerIn('PUBLIC'),
          parentRuleRef: 'rule-1-которого-нет',
        }),
      ],
      QUERY
    );

    expect(decision.disposition).not.toBe('ANSWER');
    expect(decision.requiresHumanReview).toBe(true);
    expect(decision.reasons).toContain('exception_parent_unavailable');
  });

  it('неизвестный кандидат, ЗАМЕНЯЮЩИЙ выбранного, решающий — уверенного ответа нет', () => {
    // Находка Codex: isDecisive не смотрел на supersedes вообще. Если бы U
    // разрешился в MATCH, он снял бы A; ответить сейчас из A значило бы
    // уверенно ответить правилом, про которое известно, что оно под заменой.
    const decision = resolveKnowledgeSet(
      [
        candidate({ unitId: 'rule-A' }),
        candidate({
          unitId: 'rule-U',
          scope: evaluateScope(
            buildProfile('PROCEDURE_STEP', { scenario: { state: 'UNKNOWN' } }),
            QUERY
          ),
          supersedes: ['rule-A'],
        }),
      ],
      QUERY
    );

    expect(decision.disposition).not.toBe('ANSWER');
  });

  it('цикл замен из ТРЁХ узлов не опустошает набор кандидатов', () => {
    // Находка Codex: проверка ловила только прямую пару A↔B. У тройки
    // A→B→C→A каждая дуга выглядит законной, все три попадали в supersededBy
    // и удалялись — выборка схлопывалась в пустую.
    const decision = resolveKnowledgeSet(
      [
        candidate({ unitId: 'A', supersedes: ['B'] }),
        candidate({ unitId: 'B', supersedes: ['C'] }),
        candidate({ unitId: 'C', supersedes: ['A'] }),
      ],
      QUERY
    );

    expect(decision.selected).toHaveLength(3);
    expect(decision.requiresHumanReview).toBe(true);
    expect(decision.reasons).toContain('supersedes_cycle_unresolved');
  });

  it('пустой вход — HOLD с явной причиной, а не тихий «ответ ни на чём»', () => {
    const decision = resolveKnowledgeSet([], QUERY);

    expect(decision.disposition).toBe('HOLD');
    expect(decision.selected).toEqual([]);
    expect(decision.undetermined).toEqual([]);
    expect(decision.reasons).toEqual(['no_selected_candidates']);
  });

  it('выбранный кандидат, требующий человека, не даёт автоответа', () => {
    const decision = resolveKnowledgeSet(
      [
        candidate({
          unitId: 'unclassified',
          eligibility: evaluateUnitEligibility(
            buildUnit({ review: { reviewStatus: 'UNCLASSIFIED', reviewedBy: null, reviewedAt: null } }),
            buildRequestContext({ audience: 'internal' })
          ),
        }),
      ],
      QUERY
    );

    expect(decision.selected).toEqual(['unclassified']);
    expect(decision.requiresHumanReview).toBe(true);
    expect(decision.disposition).toBe('HOLD');
    expect(decision.reasons).toContain('candidate_requires_human_review');
  });

  it('неоднозначность, помеченная построителем фрейма, не игнорируется', () => {
    const decision = resolveKnowledgeSet(
      [candidate({ unitId: 'r1' })],
      buildQuery({
        facets: { scenario: known([SCENARIO]) },
        ambiguities: ['текущее сообщение противоречит истории по городу'],
      })
    );

    expect(decision.disposition).toBe('CLARIFY');
    expect(decision.clarificationNeeds.ambiguities).toHaveLength(1);
    expect(decision.reasons).toContain('clarification_required_query_ambiguity');
  });
});

describe('решение объясняет себя', () => {
  it('у каждого выбывшего и удержанного кандидата есть код из реестра', () => {
    const decision = resolveKnowledgeSet(
      [
        candidate({ unitId: 'ok' }),
        candidate({
          unitId: 'conflicting',
          scope: evaluateScope(
            buildProfile('PROCEDURE_STEP', { scenario: scoped(['apostille.min_justice']) }),
            buildQuery({ facets: { scenario: known(['apostille.zags.spb']) } })
          ),
        }),
        candidate({
          unitId: 'held',
          scope: evaluateScope(
            buildProfile('PROCEDURE_STEP', { scenario: { state: 'UNKNOWN' } }),
            QUERY
          ),
        }),
      ],
      QUERY
    );

    for (const entry of [...decision.excluded, ...decision.undetermined]) {
      expect(RESOLUTION_REASON_CODES).toContain(entry.reason);
      expect(decision.reasons).toContain(entry.reason);
    }
  });

  it('коды не повторяются: reasons — множество причин, а не журнал', () => {
    const decision = resolveKnowledgeSet(
      [
        candidate({ unitId: 'a', eligibility: evaluateUnitEligibility(buildUnit({ status: 'DEPRECATED' }), buildRequestContext()) }),
        candidate({ unitId: 'b', eligibility: evaluateUnitEligibility(buildUnit({ status: 'SUPERSEDED' }), buildRequestContext()) }),
      ],
      QUERY
    );

    expect(decision.reasons).toEqual([...new Set(decision.reasons)]);
    expect(decision.excluded).toHaveLength(2);
  });

  it('три исхода различимы, а не сведены к boolean', () => {
    const answer = resolveKnowledgeSet([candidate({ unitId: 'r1' })], QUERY);
    const clarify = resolveKnowledgeSet(
      [
        candidate({ unitId: 'r1' }),
        candidate({
          unitId: 'r5',
          kind: 'EXCEPTION_RULE',
          scope: scopeOf('EXCEPTION_RULE'),
          trigger: triggerIn(null),
          parentRuleRef: 'r1',
        }),
      ],
      QUERY
    );
    const hold = resolveKnowledgeSet([], QUERY);

    expect([answer.disposition, clarify.disposition, hold.disposition]).toEqual([
      'ANSWER',
      'CLARIFY',
      'HOLD',
    ]);
  });
});
