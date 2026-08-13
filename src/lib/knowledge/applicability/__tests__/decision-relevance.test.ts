import { describe, expect, it } from 'vitest';
import { PaidStructuredSemanticError } from '@/lib/ai/structured-output';
import { evaluateUnitEligibility } from '../eligibility';
import type { KnowledgeUnitKind } from '../kinds';
import type { EvaluatedCandidate } from '../resolution';
import { evaluateScope, type ScopeDecision } from '../scope';
import { evaluateTrigger, type TriggerCondition, type TriggerDecision } from '../trigger';
import {
  applyDecisionRelevanceGate,
  buildBatchDecisionRelevancePromptMessages,
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

  it('Q01-like: clothing extent does not make the private-place prerequisite IRRELEVANT', () => {
    const messages = buildBatchDecisionRelevancePromptMessages(
      'Нужно ли снимать одежду полностью или достаточно немного ослабить?',
      [
        { unitId: 'extent', statement: 'Достаточно открыть только нужный участок.', quote: 'открыть нужный участок' },
        { unitId: 'privacy', statement: 'Перед началом нужно перейти в закрытое место.', quote: 'перейти в закрытое место' },
      ]
    );
    const system = messages.find((message) => message.role === 'system')!.content;
    const user = messages.find((message) => message.role === 'user')!.content;
    expect(system).toContain('обязательного предварительного условия');
    expect(system).toContain('НЕ является IRRELEVANT');
    expect(system).toContain('собери полный безопасный ответ из ВСЕХ переданных единиц');
    expect(user).toContain('Достаточно открыть только нужный участок');
    expect(user).toContain('Перед началом нужно перейти в закрытое место');
  });

  it('Q09-like: consent and gloves are co-required, even when question names consent only', () => {
    const system = buildBatchDecisionRelevancePromptMessages(
      'Может ли помощник выполнить действие, если человек согласен?',
      [
        { unitId: 'consent', statement: 'Нужно текущее явное согласие.', quote: 'явное согласие' },
        { unitId: 'gloves', statement: 'Помощник обязан надеть чистые перчатки.', quote: 'надеть чистые перчатки' },
      ]
    ).find((message) => message.role === 'system')!.content;
    expect(system).toContain('co-required safety step');
    expect(system).toContain('prerequisite/context/safety sibling');
  });

  it('truly unrelated same-block material remains IRRELEVANT', () => {
    const system = buildBatchDecisionRelevancePromptMessages(
      'Сколько полей формы заполнить?',
      [
        { unitId: 'fields', statement: 'Заполните три поля.', quote: 'три поля' },
        { unitId: 'retention', statement: 'Копии хранятся семь лет.', quote: 'семь лет' },
      ]
    ).find((message) => message.role === 'system')!.content;
    expect(system).toContain('совместное расположение без влияния на выполнение');
    expect(system).toContain('не делает правило частью ответа');
    expect(system).toContain('Само соседство в одном блоке');
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
  it('trusted REQUIRES/CO_REQUIRED dependency cannot be classifier-dropped', async () => {
    let classifierCalls = 0;
    const required = candidate({ unitId: 'required', kind: 'PROCEDURE_STEP' });
    const result = await applyDecisionRelevanceGate(
      [input({ evaluated: required, trustedMandatoryDependency: true })],
      'Вопрос?',
      {} as never,
      async () => {
        classifierCalls++;
        return { verdict: 'IRRELEVANT', reason: 'must not be used', potentiallyDecidingFacts: [] };
      }
    );

    expect(classifierCalls).toBe(0);
    expect(result.trace).toEqual([
      expect.objectContaining({ unitId: 'required', relevance: expect.objectContaining({ verdict: 'RELEVANT' }) }),
    ]);
    expect(result.relevant.map((unit) => unit.unitId)).toEqual(['required']);
    expect(result.droppedByClassifier).toEqual([]);
    expect(result.answerDependsOnProbabilisticExclusion).toBe(false);
    expect(result.classifierTelemetry).toBeNull();
  });

  it('classifies ordinary/ALTERNATIVE candidates while bypassing trusted mandatory dependencies', async () => {
    const required = candidate({ unitId: 'required', kind: 'PROCEDURE_STEP' });
    const alternative = candidate({ unitId: 'alternative', kind: 'PROCEDURE_STEP' });
    const result = await applyDecisionRelevanceGate(
      [
        input({ evaluated: required, trustedMandatoryDependency: true }),
        input({ evaluated: alternative }),
      ],
      'Вопрос?',
      {} as never,
      async ({ candidates }) => {
        expect(candidates.map((candidate) => candidate.unitId)).toEqual(['alternative']);
        return [{ unitId: 'alternative', verdict: 'IRRELEVANT', reason: 'not applicable', potentiallyDecidingFacts: [] }];
      }
    );

    expect(result.relevant.map((unit) => unit.unitId)).toEqual(['required']);
    expect(result.droppedByClassifier).toEqual(['alternative']);
    expect(result.trace.find((item) => item.unitId === 'required')?.relevance.verdict).toBe('RELEVANT');
    expect(result.trace.find((item) => item.unitId === 'alternative')?.relevance.verdict).toBe('IRRELEVANT');
  });

  it('не-EXCEPTION_RULE тоже проходит content relevance: taxonomy не доказывает релевантность', async () => {
    let classifierCalls = 0;
    const c = candidate({ unitId: 'r1', kind: 'PROCEDURE_STEP' });
    const result = await applyDecisionRelevanceGate(
      [input({ evaluated: c })],
      'Вопрос?',
      {} as never,
      async () => {
        classifierCalls++;
        return { verdict: 'RELEVANT', reason: 'x', potentiallyDecidingFacts: [] };
      }
    );
    expect(classifierCalls).toBe(1);
    expect(result.trace[0].relevance.verdict).toBe('RELEVANT');
    expect(result.relevant.map((r) => r.unitId)).toEqual(['r1']);
  });

  it('EXCEPTION_RULE с trigger ACTIVE, но без parent, не получает relevance автоматически', async () => {
    let classifierCalls = 0;
    const c = candidate({ unitId: 'e1', kind: 'EXCEPTION_RULE', parentRuleRef: null, trigger: triggerIn('PUBLIC') });
    const result = await applyDecisionRelevanceGate([input({ evaluated: c })], 'Вопрос?', {} as never, async () => {
      classifierCalls++;
      return { verdict: 'IRRELEVANT', reason: 'x', potentiallyDecidingFacts: [] };
    });
    expect(classifierCalls).toBe(1);
    expect(result.trace[0].relevance.verdict).toBe('IRRELEVANT');
  });

  it('counterfactual provenance: classifier drop не считается причиной ответа, если resolution всё равно исключил бы INACTIVE trigger', async () => {
    const inactive = candidate({
      unitId: 'inactive',
      kind: 'EXCEPTION_RULE',
      parentRuleRef: null,
      trigger: triggerIn('PRIVATE'),
    });
    const result = await applyDecisionRelevanceGate(
      [input({ evaluated: inactive })],
      'Вопрос?',
      {} as never,
      async () => ({ verdict: 'IRRELEVANT', reason: 'не влияет', potentiallyDecidingFacts: [] })
    );
    expect(result.relevant).toEqual([expect.objectContaining({ unitId: 'inactive', semanticRelevance: 'IRRELEVANT' })]);
    expect(result.droppedByClassifier).toEqual([]);
    expect(result.answerDependsOnProbabilisticExclusion).toBe(false);
  });

  it('INACTIVE conditional PROCEDURE_STEP is neither provenance nor challenge when classifier also drops it', async () => {
    const inactive = candidate({
      unitId: 'inactive-step',
      kind: 'PROCEDURE_STEP',
      trigger: triggerIn('PRIVATE'),
    });
    const result = await applyDecisionRelevanceGate(
      [input({ evaluated: inactive })],
      'Вопрос?',
      {} as never,
      async () => ({ verdict: 'IRRELEVANT', reason: 'не влияет', potentiallyDecidingFacts: [] })
    );
    expect(result.droppedByClassifier).toEqual([]);
    expect(result.challengeCandidates).toEqual([]);
    expect(result.answerDependsOnProbabilisticExclusion).toBe(false);
  });

  it('child classifier veto cannot sever an explicit link to a semantically RELEVANT parent', async () => {
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
        return [
          { unitId: 'base', verdict: 'RELEVANT', reason: 'base', potentiallyDecidingFacts: [] },
          { unitId: 'exc', verdict: 'IRRELEVANT', reason: 'x', potentiallyDecidingFacts: [] },
        ];
      }
    );
    expect(classifierCalls).toBe(1);
    const exceptionVerdict = result.trace.find((t) => t.unitId === 'exc')!.relevance;
    expect(exceptionVerdict.verdict).toBe('RELEVANT');
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

  // Real bug found running the full fixture (drg1, 2026-08-09): a malformed
  // EXCEPTION_RULE (trigger=null — extraction never attached a
  // triggerCondition) that was topically irrelevant to Q02 still reached
  // resolveKnowledgeSet unconditionally, which correctly excludes it
  // (exception_without_trigger) but ALSO sets requiresHumanReview=true —
  // and THAT flag alone forced the whole question to HOLD even though two
  // good, confidently-selected candidates already answered it. Marking
  // trigger=null candidates unconditionally RELEVANT (the original design)
  // let a record irrelevant to THIS question poison its disposition anyway
  // — the exact "one component, two jobs" problem the gate exists to fix,
  // recurring one layer downstream. Fix: trigger=null goes through the same
  // classifier path as trigger=UNKNOWN, not an
  // automatic pass-through. The data-quality concern itself doesn't
  // disappear — it's just no longer conflated with per-question answering.
  it('malformed child of semantically relevant parent is retained so resolution can fail closed on missing trigger', async () => {
    let classifierCalls = 0;
    const parent = candidate({ unitId: 'base', kind: 'PROCEDURE_STEP' });
    const malformed = candidate({ unitId: 'malformed', kind: 'EXCEPTION_RULE', parentRuleRef: 'base', trigger: null });
    const result = await applyDecisionRelevanceGate(
      [input({ evaluated: parent }), input({ evaluated: malformed })],
      'Вопрос?',
      {} as never,
      async () => {
        classifierCalls++;
        return [
          { unitId: 'base', verdict: 'RELEVANT', reason: 'base', potentiallyDecidingFacts: [] },
          { unitId: 'malformed', verdict: 'IRRELEVANT', reason: 'x', potentiallyDecidingFacts: [] },
        ];
      }
    );
    expect(classifierCalls).toBe(1);
    expect(result.trace.find((t) => t.unitId === 'malformed')!.relevance.verdict).toBe('RELEVANT');
  });

  it('EXCEPTION_RULE с trigger=null, без доказанного релевантного родителя, классификатор говорит IRRELEVANT -> кандидат отфильтрован, НЕ доходит до resolveKnowledgeSet и не может испортить requiresHumanReview для несвязанного вопроса (реальный кейс Q02)', async () => {
    const malformed = candidate({ unitId: 'malformed', kind: 'EXCEPTION_RULE', parentRuleRef: null, trigger: null });
    const result = await applyDecisionRelevanceGate(
      [input({ evaluated: malformed })],
      'Можно ли трогать кожу сразу, если ладони на вид не грязные?',
      {} as never,
      async () => ({ verdict: 'IRRELEVANT', reason: 'другая ситуация', potentiallyDecidingFacts: [] })
    );
    expect(result.relevant).toEqual([]);
    expect(result.trace[0].relevance.verdict).toBe('IRRELEVANT');
  });

  it('EXCEPTION_RULE с trigger=null, классификатор говорит RELEVANT (запись реально спорна для ЭТОГО вопроса) -> кандидат проходит гейт, resolveKnowledgeSet сам корректно применит exception_without_trigger/requiresHumanReview к genuine-релевантной записи', async () => {
    const malformed = candidate({ unitId: 'malformed', kind: 'EXCEPTION_RULE', parentRuleRef: null, trigger: null });
    const result = await applyDecisionRelevanceGate(
      [input({ evaluated: malformed })],
      'Вопрос про то, о чём именно эта запись.',
      {} as never,
      async () => ({ verdict: 'RELEVANT', reason: 'прямо по теме', potentiallyDecidingFacts: [] })
    );
    expect(result.relevant.map((r) => r.unitId)).toEqual(['malformed']);
  });

  // Кросс-аудит 2026-08-10 (gpt-5.6-sol), подтверждено чтением кода: вердикт
  // LLM `IRRELEVANT` единолично снимает кандидата ДО детерминированного
  // resolveKnowledgeSet, а классификатор вызывается РОВНО для исключений с
  // неразрешённым триггером — самого рискованного класса. Один false-negative
  // превращает «здесь может быть исключение, надо уточнить» в «исключения
  // нет» и выпускает ответ.
  //
  // Полный запрет на снятие ПРОВЕРЯЛСЯ и отвергнут: тест ниже (rule 10,
  // ограниченная подвижность vs вопрос про чистые руки) — реальный кейс, где
  // снятие ВЕРНО, а удержание заставило бы систему спрашивать у клиента
  // бессмыслицу. Поэтому политика остаётся, но перестаёт быть невидимой:
  // `droppedByClassifier` даёт вызывающему и постфактум-анализу точный
  // список снятых по мнению модели исключений.
  it('снятые ИСКЛЮЧИТЕЛЬНО вердиктом классификатора попадают в droppedByClassifier — ответ, состоявшийся только из-за такого снятия, перестаёт быть неотличимым от честного', async () => {
    const exception = candidate({
      unitId: 'exc',
      kind: 'EXCEPTION_RULE',
      parentRuleRef: null,
      trigger: unknownTrigger(),
    });
    const result = await applyDecisionRelevanceGate(
      [input({ evaluated: exception })],
      'Вопрос?',
      {} as never,
      async () => ({ verdict: 'IRRELEVANT', reason: 'другая ситуация', potentiallyDecidingFacts: [] })
    );
    expect(result.droppedByClassifier).toEqual(['exc']);
    expect(result.answerDependsOnProbabilisticExclusion).toBe(true);
    expect(result.relevant).toEqual([]);
  });

  it('классификатор говорит RELEVANT -> droppedByClassifier пуст', async () => {
    const exception = candidate({
      unitId: 'exc',
      kind: 'EXCEPTION_RULE',
      parentRuleRef: null,
      trigger: unknownTrigger(),
    });
    const result = await applyDecisionRelevanceGate(
      [input({ evaluated: exception })],
      'Вопрос?',
      {} as never,
      async () => ({ verdict: 'RELEVANT', reason: 'по теме', potentiallyDecidingFacts: [] })
    );
    expect(result.droppedByClassifier).toEqual([]);
    expect(result.answerDependsOnProbabilisticExclusion).toBe(false);
  });

  it('IRRELEVANT non-exception сохраняет probabilistic provenance так же, как исключение', async () => {
    const c = candidate({ unitId: 'r1', kind: 'PROCEDURE_STEP' });
    const result = await applyDecisionRelevanceGate([input({ evaluated: c })], 'Вопрос?', {} as never, async () => ({
      verdict: 'IRRELEVANT',
      reason: 'x',
      potentiallyDecidingFacts: [],
    }));
    expect(result.droppedByClassifier).toEqual(['r1']);
    expect(result.relevant).toEqual([]);
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
      async () => [
        { unitId: 'r1', verdict: 'RELEVANT', reason: 'x', potentiallyDecidingFacts: [] },
        { unitId: 'e1', verdict: 'IRRELEVANT', reason: 'x', potentiallyDecidingFacts: [] },
      ]
    );
    expect(result.trace.map((t) => t.unitId)).toEqual(['r1', 'e1']);
  });

  it('batch-классифицирует все unresolved исключения вопроса одним вызовом, сохраняя порядок trace', async () => {
    const first = candidate({ unitId: 'e1', kind: 'EXCEPTION_RULE', parentRuleRef: null, trigger: unknownTrigger() });
    const deterministic = candidate({ unitId: 'r1', kind: 'PROCEDURE_STEP' });
    const second = candidate({ unitId: 'e2', kind: 'EXCEPTION_RULE', parentRuleRef: null, trigger: null });
    let calls = 0;
    const result = await applyDecisionRelevanceGate(
      [input({ evaluated: first }), input({ evaluated: deterministic }), input({ evaluated: second })],
      'Вопрос?',
      {} as never,
      async ({ candidates }) => {
        calls++;
        expect(candidates.map((candidate) => candidate.unitId)).toEqual(['e1', 'r1', 'e2']);
        return {
          decisions: [
            { unitId: 'e2', verdict: 'RELEVANT', reason: 'влияет', potentiallyDecidingFacts: [] },
            { unitId: 'e1', verdict: 'IRRELEVANT', reason: 'не влияет', potentiallyDecidingFacts: [] },
            { unitId: 'r1', verdict: 'RELEVANT', reason: 'влияет', potentiallyDecidingFacts: [] },
          ],
          attempts: [],
          requestMessages: [{ role: 'user', content: 'batch request' }],
          responseText: '{"results":[]}',
        };
      }
    );
    expect(calls).toBe(1);
    expect(result.trace.map((entry) => entry.unitId)).toEqual(['e1', 'r1', 'e2']);
    expect(result.relevant.map((entry) => entry.unitId)).toEqual(['r1', 'e2']);
    expect(result.droppedByClassifier).toEqual(['e1']);
    expect(result.answerDependsOnProbabilisticExclusion).toBe(true);
    expect(result.classifierTelemetry).toEqual({
      attempts: [],
      requestMessages: [{ role: 'user', content: 'batch request' }],
      responseText: '{"results":[]}',
    });
  });

  it('fail-closed: неполный batch-ответ не позволяет молча потерять unresolved исключение', async () => {
    const first = candidate({ unitId: 'e1', kind: 'EXCEPTION_RULE', parentRuleRef: null, trigger: unknownTrigger() });
    const second = candidate({ unitId: 'e2', kind: 'EXCEPTION_RULE', parentRuleRef: null, trigger: unknownTrigger() });
    await expect(
      applyDecisionRelevanceGate(
        [input({ evaluated: first }), input({ evaluated: second })],
        'Вопрос?',
        {} as never,
        async () => [{ unitId: 'e1', verdict: 'IRRELEVANT', reason: 'x', potentiallyDecidingFacts: [] }]
      )
    ).rejects.toThrow('omitted unitId: e2');
  });

  it('paid batch telemetry survives omitted-ID semantic validation failure', async () => {
    const first = candidate({ unitId: 'e1' });
    const second = candidate({ unitId: 'e2' });
    const attempt = {
      provider: 'openai' as const, model: 'gpt-4o-mini', startedAt: '2026-08-10T00:00:00Z',
      latencyMs: 1, outcome: 'SUCCESS' as const, usage: { inputTokens: 100, outputTokens: 10 },
    };
    const error = await applyDecisionRelevanceGate(
      [input({ evaluated: first }), input({ evaluated: second })],
      'Вопрос?',
      {} as never,
      async () => ({
        decisions: [{ unitId: 'e1', verdict: 'RELEVANT', reason: 'x', potentiallyDecidingFacts: [] }],
        attempts: [attempt], requestMessages: [{ role: 'user', content: 'batch' }], responseText: '{}',
      })
    ).then(() => null, (caught: unknown) => caught);

    expect(error).toBeInstanceOf(PaidStructuredSemanticError);
    expect((error as PaidStructuredSemanticError).attempts).toEqual([attempt]);
  });

  it('explicit children inherit relevance from a semantically RELEVANT parent despite fragment-level classifier veto', async () => {
    const parent = candidate({ unitId: 'parent', kind: 'PROCEDURE_STEP' });
    const duration = candidate({ unitId: 'duration', kind: 'PROCEDURE_STEP', parentRuleRef: 'parent' });
    const pause = candidate({ unitId: 'pause', kind: 'PROCEDURE_STEP', parentRuleRef: 'parent' });
    const result = await applyDecisionRelevanceGate(
      [input({ evaluated: parent }), input({ evaluated: duration }), input({ evaluated: pause })],
      'How many repetitions and how long?',
      {} as never,
      async () => [
        { unitId: 'parent', verdict: 'RELEVANT', reason: 'answers regimen', potentiallyDecidingFacts: [] },
        { unitId: 'duration', verdict: 'IRRELEVANT', reason: 'fragment alone', potentiallyDecidingFacts: [] },
        { unitId: 'pause', verdict: 'IRRELEVANT', reason: 'fragment alone', potentiallyDecidingFacts: [] },
      ]
    );
    expect(result.relevant.map((item) => item.unitId)).toEqual(['parent', 'duration', 'pause']);
    expect(result.trace.map((item) => item.relevance.verdict)).toEqual(['RELEVANT', 'RELEVANT', 'RELEVANT']);
    expect(result.droppedByClassifier).toEqual([]);
    expect(result.challengeCandidates).toEqual([]);
  });

  it('explicit relevance inheritance is transitive and independent of candidate order', async () => {
    const grandchild = candidate({ unitId: 'grandchild', kind: 'PROCEDURE_STEP', parentRuleRef: 'child' });
    const child = candidate({ unitId: 'child', kind: 'PROCEDURE_STEP', parentRuleRef: 'parent' });
    const parent = candidate({ unitId: 'parent', kind: 'PROCEDURE_STEP' });
    const result = await applyDecisionRelevanceGate(
      [input({ evaluated: grandchild }), input({ evaluated: child }), input({ evaluated: parent })],
      'Question?',
      {} as never,
      async () => [
        { unitId: 'grandchild', verdict: 'IRRELEVANT', reason: 'fragment', potentiallyDecidingFacts: [] },
        { unitId: 'child', verdict: 'IRRELEVANT', reason: 'fragment', potentiallyDecidingFacts: [] },
        { unitId: 'parent', verdict: 'RELEVANT', reason: 'answers', potentiallyDecidingFacts: [] },
      ]
    );
    expect(result.relevant.map((item) => item.unitId)).toEqual(['grandchild', 'child', 'parent']);
    expect(result.trace.every((item) => item.relevance.verdict === 'RELEVANT')).toBe(true);
    expect(result.droppedByClassifier).toEqual([]);
  });
});
