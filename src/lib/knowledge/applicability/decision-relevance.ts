/**
 * Decision Relevance Gate (goal-shift continuation, 2026-08-09, session 3+
 * architectural correction — external review response).
 *
 * ROOT DEFECT THIS CLOSES: a retrieval/rerank top-K candidate automatically
 * gained the right to trigger HOLD/CLARIFY or override another rule inside
 * `resolveKnowledgeSet`, purely by being topically adjacent to the question.
 * Confirmed real failures on the training fixture: rule 5's public-place
 * exception blocked "how much clothing do I need to remove" (Q01); rule 10's
 * limited-reachability exception blocked "are visibly clean hands OK to
 * touch with" (Q02/Q03). Neither exception has anything to do with either
 * question — but both are `EXCEPTION_RULE` units with an unlinked (or
 * unmatched) parent and an unknown trigger fact, the exact shape
 * `resolveKnowledgeSet`'s `isDecisive()` (session 2 fix, `41cb23f`)
 * correctly treats as "must ask" — for candidates where that ambiguity is
 * REAL. Weakening `isDecisive()` itself would reintroduce the original
 * Q01-M1/Q05-M1 defect it was built to fix; the fix belongs one layer
 * earlier, before decisively-irrelevant candidates ever reach that logic.
 *
 * "Semantic similarity" is deliberately NOT the question this module asks.
 * "Can this rule directly answer, constrain, or except a rule that answers
 * THIS question" is — the same rule (rule 5's public-place exception) is
 * genuinely relevant to "can I rub through fabric if it itches" (Q01-M1) and
 * irrelevant to "how much clothing to remove" (Q01). Only content-aware
 * judgment distinguishes these, not topic/vocabulary overlap.
 *
 * All top-K candidates are judged together in one oracle-blind structured
 * call. Neither taxonomy, a resolved trigger, nor a parent link proves that
 * a candidate can affect this question: the controlled quality run found
 * counterexamples for each shortcut. Batching keeps provider call count at
 * one per question while preserving a verdict and provenance for every unit.
 * A bare rerank-score threshold remains intentionally insufficient because
 * scores are model- and query-relative rather than decision semantics.
 */

import type { ChatMessage, CompletionAttempt } from '@/lib/ai/chat-provider';
import type { ExtractionRunConfig } from '@/lib/ai/extraction-run';
import { PaidStructuredSemanticError, structured } from '@/lib/ai/structured-output';
import { z } from 'zod';
import { resolveKnowledgeSet, type EvaluatedCandidate, type ResolutionDecision } from './resolution';
import type { QueryFrame } from './query-frame';

export const DECISION_RELEVANCE_VERDICTS = ['RELEVANT', 'CONDITIONALLY_RELEVANT', 'IRRELEVANT'] as const;
export type DecisionRelevanceVerdict = (typeof DECISION_RELEVANCE_VERDICTS)[number];

export interface DecisionRelevance {
  readonly verdict: DecisionRelevanceVerdict;
  readonly reason: string;
  /** Non-empty only meaningful for `CONDITIONALLY_RELEVANT` — which fact(s)
   *  would decide whether this candidate actually applies. */
  readonly potentiallyDecidingFacts: readonly string[];
}

export interface DecisionRelevanceCandidateInfo {
  readonly unitId: string;
  readonly statement: string;
  /** Literal quote from the source — same discipline as every other
   *  prompt in this codebase that shows the model source text. */
  readonly quote: string;
}

const SYSTEM_PROMPT = `Ты определяешь РЕЛЕВАНТНОСТЬ единицы знания для конкретного вопроса — способность повлиять на ответ, а НЕ тематическое сходство.

Тебе дан вопрос пользователя и текст одной единицы знания (statement + дословная цитата из источника). Определи одно из:
- "RELEVANT": правило может НАПРЯМУЮ отвечать на вопрос или ограничивать ответ на него.
- "CONDITIONALLY_RELEVANT": разные значения неизвестного факта способны изменить ответ именно на заданный вопрос. Укажи этот факт (potentiallyDecidingFacts). Само наличие условия или связи с соседним правилом недостаточно.
- "IRRELEVANT": правило говорит о ДРУГОЙ ситуации или условии — даже если использует похожие слова (кожа, прикосновение, участок и т.п.), оно НЕ способно изменить ответ на ЭТОТ конкретный вопрос.

ПОЛНОТА ПРОЦЕДУРЫ — часть релевантности. Верни RELEVANT также для обязательного предварительного условия, контекста, ограничения безопасности или сопутствующего шага, без которого ответ по другому явно названному измерению процедуры был бы неполным либо небезопасным. Правило, которое добавляет обязательное условие к отвечающему правилу, НЕ является IRRELEVANT только потому, что пользователь спросил, например, о количестве/способе, а не повторил это условие словами. В пакетном запросе оценивай единицы совместно: несколько sibling-правил могут составлять один полный ответ. Само соседство в одном блоке, однако, релевантность не доказывает.

Два предметно-нейтральных примера для калибровки:
1. Вопрос "Можно ли отправить форму по электронной почте?" + правило об увеличенном сроке для международной доставки -> IRRELEVANT (способ отправки не зависит от срока доставки).
2. Вопрос "Можно ли применить скидку?" + исключение для некоммерческих организаций -> CONDITIONALLY_RELEVANT, potentiallyDecidingFacts: ["organizationType"] (ответ зависит от типа организации, а вопрос его не называет).
3. Вопрос "Сколько полей формы достаточно заполнить?" + правило "перед отправкой форму обязательно подписывает заявитель" -> RELEVANT: подпись — co-required prerequisite полного ответа, хотя вопрос назвал только объём заполнения.
4. Вопрос "Может ли помощник выполнить действие после разрешения?" + правило "помощник обязан использовать защитные перчатки" -> RELEVANT: это co-required safety step той же процедуры, а не другая тема.
5. Тот же вопрос о заполнении формы + соседнее в исходном блоке правило "копии хранятся семь лет" -> IRRELEVANT: совместное расположение без влияния на выполнение не делает правило частью ответа.

Не оценивай тематическое сходство слов. Оценивай: способно ли это правило изменить ответ на ДАННЫЙ вопрос.
Проверка для CONDITIONALLY_RELEVANT: мысленно подставь разные значения неизвестного факта. Если ответ на заданные пользователем варианты остаётся тем же, верни IRRELEVANT. Правило про дополнительный случай, о котором пользователь не спрашивал и которое не меняет основной ответ, также IRRELEVANT.

Ответ СТРОГО JSON: {"verdict": "...", "reason": "...", "potentiallyDecidingFacts": [...]}`;

export function buildDecisionRelevancePromptMessages(
  question: string,
  candidate: DecisionRelevanceCandidateInfo
): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        `Вопрос: "${question}"\n\n` +
        `Единица знания:\nУтверждение: ${candidate.statement}\nЦитата: "${candidate.quote}"\n\n` +
        'Определи релевантность для этого вопроса.',
    },
  ];
}

export function buildBatchDecisionRelevancePromptMessages(
  question: string,
  candidates: readonly DecisionRelevanceCandidateInfo[]
): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        SYSTEM_PROMPT +
        '\n\nДля пакетного запроса сначала мысленно собери полный безопасный ответ из ВСЕХ переданных единиц: не отбрасывай prerequisite/context/safety sibling только потому, что другая единица уже узко отвечает на формулировку вопроса. Затем верни СТРОГО JSON: {"results":[{"unitId":"...","verdict":"...","reason":"...","potentiallyDecidingFacts":[]}]}. Верни ровно один результат для каждого переданного unitId.',
    },
    {
      role: 'user',
      content:
        `Вопрос: "${question}"\n\nЕдиницы знания:\n` +
        candidates
          .map(
            (candidate) =>
              `unitId: ${candidate.unitId}\nУтверждение: ${candidate.statement}\nЦитата: "${candidate.quote}"`
          )
          .join('\n\n') +
        '\n\nОпредели релевантность каждого правила для этого вопроса.',
    },
  ];
}

interface RawDecisionRelevanceResponse {
  readonly verdict: DecisionRelevanceVerdict;
  readonly reason: string;
  readonly potentiallyDecidingFacts: readonly string[];
}

/** Pure — no network. */
export function interpretDecisionRelevanceResponse(raw: RawDecisionRelevanceResponse): DecisionRelevance {
  return {
    verdict: raw.verdict,
    reason: raw.reason,
    potentiallyDecidingFacts: raw.potentiallyDecidingFacts,
  };
}

export const decisionRelevanceResponseSchema = z.strictObject({
  verdict: z.enum(DECISION_RELEVANCE_VERDICTS),
  reason: z.string(),
  potentiallyDecidingFacts: z
    .array(z.string())
    .nullish()
    .transform((v) => v ?? []),
});

const classifiedDecisionRelevanceSchema = decisionRelevanceResponseSchema.extend({ unitId: z.string().min(1) });
export const batchDecisionRelevanceResponseSchema = z.strictObject({
  results: z.array(classifiedDecisionRelevanceSchema),
});

export interface EvaluateDecisionRelevanceOptions {
  readonly question: string;
  readonly candidate: DecisionRelevanceCandidateInfo;
  readonly runConfig: ExtractionRunConfig;
}

export type DecisionRelevanceClassifier = (
  options: EvaluateDecisionRelevanceOptions
) => Promise<DecisionRelevance>;

export const evaluateDecisionRelevance: DecisionRelevanceClassifier = async (options) => {
  const result = await structured({
    schema: decisionRelevanceResponseSchema,
    messages: buildDecisionRelevancePromptMessages(options.question, options.candidate),
    runConfig: options.runConfig,
  });
  return interpretDecisionRelevanceResponse(result.data);
};

export interface ClassifiedDecisionRelevance extends DecisionRelevance {
  readonly unitId: string;
}

export interface EvaluateDecisionRelevanceBatchOptions {
  readonly question: string;
  readonly candidates: readonly DecisionRelevanceCandidateInfo[];
  readonly runConfig: ExtractionRunConfig;
}

export interface DecisionRelevanceBatchTelemetry {
  readonly attempts: readonly CompletionAttempt[];
  readonly requestMessages: readonly ChatMessage[];
  readonly responseText: string | null;
}

export interface DecisionRelevanceBatchEvaluation extends DecisionRelevanceBatchTelemetry {
  readonly decisions: readonly ClassifiedDecisionRelevance[];
}

/** The singular return is retained only for existing one-candidate test
 * doubles. Production always uses the batched array contract. */
export type DecisionRelevanceBatchClassifier = (
  options: EvaluateDecisionRelevanceBatchOptions
) => Promise<DecisionRelevanceBatchEvaluation | readonly ClassifiedDecisionRelevance[] | DecisionRelevance>;

export const evaluateDecisionRelevanceBatch: DecisionRelevanceBatchClassifier = async (options) => {
  const result = await structured({
    schema: batchDecisionRelevanceResponseSchema,
    messages: buildBatchDecisionRelevancePromptMessages(options.question, options.candidates),
    runConfig: options.runConfig,
  });
  return {
    decisions: result.data.results,
    attempts: result.attempts,
    requestMessages: result.requestMessages ?? [],
    responseText: result.rawText ?? null,
  };
};

// ─────────────────────────── deterministic gate ────────────────────────────

export interface GateCandidateInput {
  readonly evaluated: EvaluatedCandidate;
  readonly statement: string;
  readonly quote: string;
  /** Trusted graph provenance only. REQUIRES/CO_REQUIRED closure members are
   * part of the retrieved rule's complete meaning and cannot be removed by a
   * probabilistic relevance classifier. ALTERNATIVE members must leave this
   * false/undefined and follow the ordinary applicability path. */
  readonly trustedMandatoryDependency?: boolean;
}

export interface GatedCandidate {
  readonly unitId: string;
  readonly relevance: DecisionRelevance;
}

export interface DecisionRelevanceChallenge extends GateCandidateInput {
  readonly unitId: string;
  /** Deterministically source-backed necessary condition. A model may not
   * clear this prerequisite by merely voting COMPATIBLE. */
  readonly mandatoryPrerequisite: boolean;
}

export interface DecisionRelevanceGateResult {
  readonly relevant: readonly EvaluatedCandidate[];
  /** EVERY candidate with its verdict, relevant or not — full trace for
   *  debugging real company documents later (architectural review §6). */
  readonly trace: readonly GatedCandidate[];
  /**
   * unitId кандидатов, снятых ИСКЛЮЧИТЕЛЬНО вердиктом LLM-классификатора —
   * без единого детерминированного основания (кросс-аудит 2026-08-10).
   *
   * Зачем отдельно от `trace`: по трейсу видно, что вердикт был IRRELEVANT,
   * но не видно, был ли он единственной причиной снятия. А это как раз тот
   * класс решений, где стохастическая ошибка стоит дорого: снятое здесь
   * исключение никогда не доходит до детерминированного
   * `resolveKnowledgeSet`, и вопрос, который должен был уйти в уточнение,
   * может получить ответ. Список позволяет вызывающему увидеть, что ответ
   * состоялся ТОЛЬКО потому, что кандидаты были сняты по мнению модели, и
   * посчитать частоту этого по сохранённым прогонам — без повторного
   * платного запуска.
   *
   * Политика «не снимать вовсе» рассматривалась и отвергнута на данных:
   * она возвращает документированный сбой (исключение про ограниченную
   * подвижность снова блокировало бы вопрос про чистые руки и заставляло
   * систему спрашивать у клиента бессмыслицу). Чем заменить нынешнюю
   * политику — открытое решение владельца, и этот список даёт цифры, на
   * которых его можно принять.
   */
  readonly droppedByClassifier: readonly string[];
  /** Fail-closed provenance bit for answer-delivery policy. This is derived
   *  rather than inferred later from a human-readable trace so callers cannot
   *  accidentally treat a classifier-dependent path as deterministic. */
  readonly answerDependsOnProbabilisticExclusion: boolean;
  /** Exact metadata for the single batched provider call, or null when every
   * candidate followed a deterministic fast path/test-double path. */
  readonly classifierTelemetry: DecisionRelevanceBatchTelemetry | null;
  /** Classifier-dropped ordinary rules retained for counterfactual and final
   * compatibility checks. They are not primary evidence, but are never hidden
   * from the safety path. Exceptions remain fail-closed via provenance. */
  readonly challengeCandidates: readonly DecisionRelevanceChallenge[];
}

export async function applyDecisionRelevanceGate(
  candidates: readonly GateCandidateInput[],
  question: string,
  runConfig: ExtractionRunConfig,
  classifier: DecisionRelevanceBatchClassifier = evaluateDecisionRelevanceBatch
): Promise<DecisionRelevanceGateResult> {
  const trace: GatedCandidate[] = [];
  const relevant: EvaluatedCandidate[] = [];
  const droppedByClassifier: string[] = [];
  const challengeCandidates: DecisionRelevanceChallenge[] = [];
  let classifierTelemetry: DecisionRelevanceBatchTelemetry | null = null;

  const unresolved = candidates.filter((candidate) => candidate.trustedMandatoryDependency !== true);
  const classifiedByUnitId = new Map<string, DecisionRelevance>();
  const classifierUnitIds = new Set(unresolved.map((candidate) => candidate.evaluated.unitId));
  for (const candidate of candidates) {
    if (candidate.trustedMandatoryDependency !== true) continue;
    classifiedByUnitId.set(candidate.evaluated.unitId, {
      verdict: 'RELEVANT',
      reason: 'trusted REQUIRES/CO_REQUIRED dependency closure',
      potentiallyDecidingFacts: [],
    });
  }
  if (unresolved.length > 0) {
    const classified = await classifier({
      question,
      candidates: unresolved.map((candidate) => ({
        unitId: candidate.evaluated.unitId,
        statement: candidate.statement,
        quote: candidate.quote,
      })),
      runConfig,
    });
    const batchEvaluation =
      !Array.isArray(classified) && 'decisions' in classified ? classified : null;
    if (batchEvaluation !== null) {
      classifierTelemetry = {
        attempts: batchEvaluation.attempts,
        requestMessages: batchEvaluation.requestMessages,
        responseText: batchEvaluation.responseText,
      };
    }
    const rawDecisions = batchEvaluation?.decisions ?? classified;
    try {
      const normalized: readonly ClassifiedDecisionRelevance[] = Array.isArray(rawDecisions)
        ? rawDecisions
        : unresolved.length === 1
          ? [{ unitId: unresolved[0].evaluated.unitId, ...rawDecisions }]
          : (() => {
              throw new Error('Batched decision-relevance classifier returned a singular result for multiple candidates');
            })();
      for (const decision of normalized) {
        if (!classifierUnitIds.has(decision.unitId)) {
          throw new Error(`Batched decision-relevance classifier returned unexpected unitId: ${decision.unitId}`);
        }
        if (classifiedByUnitId.has(decision.unitId)) {
          throw new Error(`Batched decision-relevance classifier returned duplicate unitId: ${decision.unitId}`);
        }
        classifiedByUnitId.set(decision.unitId, decision);
      }
      for (const candidate of unresolved) {
        if (!classifiedByUnitId.has(candidate.evaluated.unitId)) {
          throw new Error(`Batched decision-relevance classifier omitted unitId: ${candidate.evaluated.unitId}`);
        }
      }
      if (classifiedByUnitId.size !== candidates.length) {
        throw new Error('Batched decision-relevance classifier returned an unexpected unitId');
      }
    } catch (error) {
      if (classifierTelemetry !== null) {
        throw new PaidStructuredSemanticError(
          error instanceof Error ? error.message : String(error),
          classifierTelemetry,
          { cause: error }
        );
      }
      throw error;
    }

    // Explicit extraction identity outranks a fragment-level semantic veto:
    // once a parent is judged relevant, every linked child in this same top-K
    // is part of that rule's structured meaning. This preserves split numeric
    // clauses and other fragments that are incomplete when read alone.
    let inheritedAny = true;
    while (inheritedAny) {
      inheritedAny = false;
      for (const candidate of candidates) {
        const parentRef = candidate.evaluated.parentRuleRef;
        if (parentRef === null) continue;
        if (classifiedByUnitId.get(parentRef)?.verdict !== 'RELEVANT') continue;
        if (classifiedByUnitId.get(candidate.evaluated.unitId)?.verdict === 'RELEVANT') continue;
        classifiedByUnitId.set(candidate.evaluated.unitId, {
          verdict: 'RELEVANT',
          reason: `explicit child of relevant parent ${parentRef}`,
          potentiallyDecidingFacts: [],
        });
        inheritedAny = true;
      }
    }
  }

  for (const candidate of candidates) {
    const ev = candidate.evaluated;

    let relevance: DecisionRelevance;
    let decidedByClassifier = false;
    if (classifiedByUnitId.has(ev.unitId)) {
      relevance = classifiedByUnitId.get(ev.unitId)!;
      decidedByClassifier = classifierUnitIds.has(ev.unitId);
    } else {
      throw new Error(`Decision-relevance result missing after validated batch: ${ev.unitId}`);
    }

    trace.push({ unitId: ev.unitId, relevance });
    if (relevance.verdict === 'IRRELEVANT') {
      const resolutionWouldExcludeAnyway =
        !ev.eligibility.eligible ||
        ev.scope.verdict === 'CONFLICT' ||
        ev.trigger?.verdict === 'INACTIVE';
      if (decidedByClassifier && !resolutionWouldExcludeAnyway) {
        droppedByClassifier.push(ev.unitId);
        if (ev.kind !== 'EXCEPTION_RULE') {
          challengeCandidates.push({
            ...candidate,
            unitId: ev.unitId,
            mandatoryPrerequisite:
              candidate.trustedMandatoryDependency === true || ev.negativeInferenceAllowed === true,
          });
        }
      }
      // Keep structured INACTIVE candidates visible to resolution even when
      // semantically irrelevant. They cannot be selected, but their exact
      // trigger reason (for example consentStatus_violated) is required for
      // an auditable denial trace.
      if (ev.trigger?.verdict === 'INACTIVE') {
        relevant.push({ ...ev, semanticRelevance: 'IRRELEVANT' });
      }
    } else {
      relevant.push({ ...ev, semanticRelevance: 'RELEVANT' });
    }
  }

  return {
    relevant,
    trace,
    droppedByClassifier,
    answerDependsOnProbabilisticExclusion: droppedByClassifier.length > 0,
    classifierTelemetry,
    challengeCandidates,
  };
}

export interface ChallengeCounterfactualResult {
  readonly restoredDispositionByUnitId: Readonly<Record<string, ResolutionDecision['disposition']>>;
  readonly blockingUnitIds: readonly string[];
}

/** Restores each challenge independently. A candidate that turns ANSWER into
 * CLARIFY/HOLD is structurally decisive regardless of a later semantic vote. */
export function evaluateChallengeCounterfactuals(
  gate: DecisionRelevanceGateResult,
  query: QueryFrame
): ChallengeCounterfactualResult {
  const restoredDispositionByUnitId: Record<string, ResolutionDecision['disposition']> = {};
  const blockingUnitIds: string[] = [];
  for (const challenge of gate.challengeCandidates) {
    const disposition = resolveKnowledgeSet([...gate.relevant, challenge.evaluated], query).disposition;
    restoredDispositionByUnitId[challenge.unitId] = disposition;
    if (disposition !== 'ANSWER') blockingUnitIds.push(challenge.unitId);
  }
  return { restoredDispositionByUnitId, blockingUnitIds };
}
