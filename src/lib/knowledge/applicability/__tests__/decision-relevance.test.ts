import { describe, expect, it } from 'vitest';
import { evaluateUnitEligibility } from '../eligibility';
import type { KnowledgeUnitKind } from '../kinds';
import type { EvaluatedCandidate } from '../resolution';
import { evaluateScope, type ScopeDecision } from '../scope';
import { evaluateTrigger, type TriggerCondition, type TriggerDecision } from '../trigger';
import {
  applyDecisionRelevanceGate,
  buildDecisionRelevancePromptMessages,
  decisionRelevanceResponseSchema,
  interpretDecisionRelevanceResponse,
  type GateCandidateInput,
} from '../decision-relevance';
import { buildProfile, buildQuery, buildRequestContext, buildUnit, fact, scoped } from './helpers';

/**
 * Decision Relevance Gate (architectural correction, 2026-08-09 session 3+).
 * Root defect: a retrieval top-K candidate automatically gained the right to
 * trigger HOLD/CLARIFY purely by topical adjacency. Candidates built with
 * REAL evaluators (evaluateScope/evaluateTrigger), same discipline as
 * resolution.test.ts — a suite over hand-drawn candidates would only prove
 * consistency of invented decisions.
 */

const SCENARIO = 'apostille';
const QUERY = buildQuery({ facets: { scenario: { state: 'KNOWN', include: [SCENARIO], exclude: [], evidence: [] } } });

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

function unknownTrigger(): TriggerDecision {
  // `buildQuery()` без переопределения triggerFacts уже даёт UNKNOWN_TRIGGER_FACTS
  // по умолчанию (helpers.ts) — тот же приём, что resolution.test.ts's triggerIn(null).
  return evaluateTrigger(IN_PUBLIC, buildQuery());
}

function input(overrides: Partial<GateCandidateInput> & { evaluated: EvaluatedCandidate }): GateCandidateInput {
  return { statement: 'заполнитель', quote: 'заполнитель', ...overrides };
}

describe('buildDecisionRelevancePromptMessages — pure, no network', () => {
  it('несёт вопрос и statement/quote кандидата', () => {
    const messages = buildDecisionRelevancePromptMessages('Нужно ли мыть руки?', {
      unitId: 'u1',
      statement: 'Правило про ограниченную подвижность.',
      quote: 'человек не может дотянуться',
    });
    const user = messages.find((m) => m.role === 'user')!;
    expect(user.content).toContain('Нужно ли мыть руки?');
    expect(user.content).toContain('Правило про ограниченную подвижность.');
    expect(user.content).toContain('человек не может дотянуться');
  });

  it('не содержит ничего похожего на ожидаемый ответ/oracle — только вопрос+кандидат', () => {
    const messages = buildDecisionRelevancePromptMessages('Вопрос.', { unitId: 'u1', statement: 'x', quote: 'y' });
    const full = messages.map((m) => m.content).join(' ').toLowerCase();
    expect(full).not.toContain('expected_answer');
    expect(full).not.toContain('oracle');
  });
});

describe('interpretDecisionRelevanceResponse — pure passthrough', () => {
  it('RELEVANT без potentiallyDecidingFacts -> пустой массив по умолчанию через схему, не саму функцию', () => {
    const parsed = interpretDecisionRelevanceResponse({
      verdict: 'RELEVANT',
      reason: 'прямо отвечает',
      potentiallyDecidingFacts: [],
    });
    expect(parsed).toEqual({ verdict: 'RELEVANT', reason: 'прямо отвечает', potentiallyDecidingFacts: [] });
  });

  it('CONDITIONALLY_RELEVANT сохраняет facts', () => {
    const parsed = interpretDecisionRelevanceResponse({
      verdict: 'CONDITIONALLY_RELEVANT',
      reason: 'зависит от места',
      potentiallyDecidingFacts: ['privacyContext'],
    });
    expect(parsed.potentiallyDecidingFacts).toEqual(['privacyContext']);
  });
});

describe('decisionRelevanceResponseSchema — ключ potentiallyDecidingFacts пропущен целиком, тот же класс LLM-выдачи, что нормализован elsewhere', () => {
  it('ответ без ключа potentiallyDecidingFacts -> валиден, становится []', () => {
    const parsed = decisionRelevanceResponseSchema.safeParse({ verdict: 'IRRELEVANT', reason: 'другая тема' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.potentiallyDecidingFacts).toEqual([]);
  });

  it('ответ с potentiallyDecidingFacts: null -> тоже валиден, становится []', () => {
    const parsed = decisionRelevanceResponseSchema.safeParse({
      verdict: 'RELEVANT',
      reason: 'x',
      potentiallyDecidingFacts: null,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.potentiallyDecidingFacts).toEqual([]);
  });
});

describe('applyDecisionRelevanceGate — детерминированный слой (без сети)', () => {
  it('не-EXCEPTION_RULE кандидат -> RELEVANT, классификатор НЕ вызывается', async () => {
    let classifierCalls = 0;
    const c = candidate({ unitId: 'r1', kind: 'PROCEDURE_STEP' });
    const result = await applyDecisionRelevanceGate(
      [input({ evaluated: c })],
      'Вопрос?',
      {} as never,
      async () => {
        classifierCalls++;
        return { verdict: 'IRRELEVANT', reason: 'x', potentiallyDecidingFacts: [] };
      }
    );
    expect(classifierCalls).toBe(0);
    expect(result.trace[0].relevance.verdict).toBe('RELEVANT');
    expect(result.relevant.map((r) => r.unitId)).toEqual(['r1']);
  });

  it('EXCEPTION_RULE с trigger ACTIVE -> RELEVANT, классификатор НЕ вызывается (resolution уже верно это обрабатывает)', async () => {
    let classifierCalls = 0;
    const c = candidate({ unitId: 'e1', kind: 'EXCEPTION_RULE', parentRuleRef: null, trigger: triggerIn('PUBLIC') });
    const result = await applyDecisionRelevanceGate([input({ evaluated: c })], 'Вопрос?', {} as never, async () => {
      classifierCalls++;
      return { verdict: 'IRRELEVANT', reason: 'x', potentiallyDecidingFacts: [] };
    });
    expect(classifierCalls).toBe(0);
    expect(result.trace[0].relevance.verdict).toBe('RELEVANT');
  });

  it('EXCEPTION_RULE с trigger UNKNOWN и parentRuleRef на scope-MATCH кандидата в этом же пуле -> CONDITIONALLY_RELEVANT, классификатор НЕ вызывается (структурная пропагация — случай Q01-M1/Q05-M1, когда связь сохранилась)', async () => {
    let classifierCalls = 0;
    const parent = candidate({ unitId: 'base', kind: 'PROCEDURE_STEP' });
    const exception = candidate({
      unitId: 'exc',
      kind: 'EXCEPTION_RULE',
      parentRuleRef: 'base',
      trigger: unknownTrigger(),
    });
    const result = await applyDecisionRelevanceGate(
      [input({ evaluated: parent }), input({ evaluated: exception })],
      'Вопрос?',
      {} as never,
      async () => {
        classifierCalls++;
        return { verdict: 'IRRELEVANT', reason: 'x', potentiallyDecidingFacts: [] };
      }
    );
    expect(classifierCalls).toBe(0);
    const exceptionVerdict = result.trace.find((t) => t.unitId === 'exc')!.relevance;
    expect(exceptionVerdict.verdict).toBe('CONDITIONALLY_RELEVANT');
    expect(result.relevant.map((r) => r.unitId)).toContain('exc');
  });

  it('EXCEPTION_RULE с trigger UNKNOWN, parentRuleRef=null -> классификатор ВЫЗЫВАЕТСЯ (реальная неоднозначность)', async () => {
    let classifierCalls = 0;
    const exception = candidate({
      unitId: 'exc',
      kind: 'EXCEPTION_RULE',
      parentRuleRef: null,
      trigger: unknownTrigger(),
    });
    await applyDecisionRelevanceGate([input({ evaluated: exception })], 'Вопрос?', {} as never, async () => {
      classifierCalls++;
      return { verdict: 'IRRELEVANT', reason: 'x', potentiallyDecidingFacts: [] };
    });
    expect(classifierCalls).toBe(1);
  });

  it('EXCEPTION_RULE с parentRuleRef на unitId, которого НЕТ в пуле -> классификатор вызывается (родитель не пришёл кандидатом, структурного доказательства нет)', async () => {
    let classifierCalls = 0;
    const exception = candidate({
      unitId: 'exc',
      kind: 'EXCEPTION_RULE',
      parentRuleRef: 'ghost-parent-not-in-pool',
      trigger: unknownTrigger(),
    });
    await applyDecisionRelevanceGate([input({ evaluated: exception })], 'Вопрос?', {} as never, async () => {
      classifierCalls++;
      return { verdict: 'CONDITIONALLY_RELEVANT', reason: 'x', potentiallyDecidingFacts: ['privacyContext'] };
    });
    expect(classifierCalls).toBe(1);
  });

  it('классификатор возвращает IRRELEVANT -> кандидат исключён из relevant, но остаётся в trace (реальный кейс: rule 10 reachability для вопроса про чистые руки)', async () => {
    const exception = candidate({
      unitId: 'rule10-exc',
      kind: 'EXCEPTION_RULE',
      parentRuleRef: null,
      trigger: unknownTrigger(),
    });
    const result = await applyDecisionRelevanceGate(
      [input({ evaluated: exception })],
      'Можно ли трогать кожу сразу, если ладони на вид не грязные?',
      {} as never,
      async () => ({
        verdict: 'IRRELEVANT',
        reason: 'правило про ограниченную подвижность не относится к чистоте рук',
        potentiallyDecidingFacts: [],
      })
    );
    expect(result.relevant).toEqual([]);
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0].relevance.verdict).toBe('IRRELEVANT');
  });

  it('классификатор возвращает CONDITIONALLY_RELEVANT -> кандидат остаётся в relevant (реальный кейс: rule 5 для Q01-M1, связь с родителем не сохранилась)', async () => {
    const exception = candidate({
      unitId: 'rule5-exc',
      kind: 'EXCEPTION_RULE',
      parentRuleRef: null,
      trigger: unknownTrigger(),
    });
    const result = await applyDecisionRelevanceGate(
      [input({ evaluated: exception })],
      'Можно ли просто потереть через ткань, если сильно чешется?',
      {} as never,
      async () => ({
        verdict: 'CONDITIONALLY_RELEVANT',
        reason: 'вопрос буквально про трение через ткань',
        potentiallyDecidingFacts: ['privacyContext'],
      })
    );
    expect(result.relevant.map((r) => r.unitId)).toEqual(['rule5-exc']);
  });

  it('EXCEPTION_RULE с trigger=null (без triggerCondition вовсе) -> RELEVANT, классификатор НЕ вызывается — resolveKnowledgeSet сам корректно исключает такой кандидат (exception_without_trigger) и поднимает requiresHumanReview; гейт не должен молча гасить этот сигнал качества данных фильтрацией как IRRELEVANT', async () => {
    let classifierCalls = 0;
    const exception = candidate({ unitId: 'malformed', kind: 'EXCEPTION_RULE', parentRuleRef: null, trigger: null });
    const result = await applyDecisionRelevanceGate(
      [input({ evaluated: exception })],
      'Вопрос?',
      {} as never,
      async () => {
        classifierCalls++;
        return { verdict: 'IRRELEVANT', reason: 'x', potentiallyDecidingFacts: [] };
      }
    );
    expect(classifierCalls).toBe(0);
    expect(result.trace[0].relevance.verdict).toBe('RELEVANT');
    expect(result.relevant.map((r) => r.unitId)).toEqual(['malformed']);
  });

  it('trace содержит ВСЕ кандидаты независимо от вердикта, в исходном порядке', async () => {
    const relevantCand = candidate({ unitId: 'r1', kind: 'PROCEDURE_STEP' });
    const irrelevantCand = candidate({
      unitId: 'e1',
      kind: 'EXCEPTION_RULE',
      parentRuleRef: null,
      trigger: unknownTrigger(),
    });
    const result = await applyDecisionRelevanceGate(
      [input({ evaluated: relevantCand }), input({ evaluated: irrelevantCand })],
      'Вопрос?',
      {} as never,
      async () => ({ verdict: 'IRRELEVANT', reason: 'x', potentiallyDecidingFacts: [] })
    );
    expect(result.trace.map((t) => t.unitId)).toEqual(['r1', 'e1']);
  });
});
