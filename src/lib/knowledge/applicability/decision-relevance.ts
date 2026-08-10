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
 * TWO-TIER DESIGN (chosen over a pure LLM classifier or a bare rerank-score
 * threshold — see the architectural review this responds to):
 *
 * 1. Deterministic structural check, free, zero LLM calls, zero regression
 *    risk: a non-`EXCEPTION_RULE` candidate is relevant by construction (it
 *    already passed scope matching, which IS a relevance signal for that
 *    kind — this is not the observed failure mode). An `EXCEPTION_RULE`
 *    candidate whose trigger is already confidently `ACTIVE`/`INACTIVE` is
 *    left to `resolveKnowledgeSet`'s already-correct, already-tested
 *    handling of those cases. An `EXCEPTION_RULE` whose `parentRuleRef`
 *    points at ANOTHER candidate that is itself scope-matched is relevant
 *    by construction too — this is exactly the Q01-M1/Q05-M1 shape when the
 *    link survives extraction, and needs no LLM call to prove.
 *
 * 2. Oracle-blind LLM classifier, invoked ONLY for what's left: an
 *    `EXCEPTION_RULE` with an unresolved trigger (`UNKNOWN` verdict, OR no
 *    `triggerCondition` at all — a malformed/incomplete extraction is a
 *    relevance question too, not exempt from it: a real full-benchmark run
 *    found a malformed record with no triggerCondition that was topically
 *    irrelevant to a question, yet still reached `resolveKnowledgeSet`
 *    unconditionally, which correctly excluded it but ALSO set
 *    `requiresHumanReview = true` — poisoning that question's disposition
 *    to `HOLD` even with two other confidently-selected candidates ready to
 *    answer it. The data-quality concern doesn't disappear; it's just no
 *    longer conflated with whether THIS question can be answered) AND no
 *    structurally-proven relevant parent. This is exactly the genuinely
 *    ambiguous remainder — real judgment about THIS question's content, not
 *    a blanket score threshold (which the architectural review explicitly
 *    rejected: reranker scores are model- and query-relative, too fragile
 *    as the sole signal).
 */

import type { ChatMessage } from '@/lib/ai/chat-provider';
import type { ExtractionRunConfig } from '@/lib/ai/extraction-run';
import { structured } from '@/lib/ai/structured-output';
import { z } from 'zod';
import type { EvaluatedCandidate } from './resolution';

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

const SYSTEM_PROMPT = `Ты определяешь РЕЛЕВАНТНОСТЬ правила-исключения для конкретного вопроса — способность повлиять на ответ, а НЕ тематическое сходство.

Тебе дан вопрос пользователя и текст одного правила-исключения (statement + дословная цитата из источника). Определи одно из:
- "RELEVANT": правило может НАПРЯМУЮ отвечать на вопрос или ограничивать ответ на него.
- "CONDITIONALLY_RELEVANT": правило — законное исключение к тому, что отвечает на вопрос, и его применимость зависит от факта, которого вопрос не сообщает. Укажи этот факт (potentiallyDecidingFacts).
- "IRRELEVANT": правило говорит о ДРУГОЙ ситуации или условии — даже если использует похожие слова (кожа, прикосновение, участок и т.п.), оно НЕ способно изменить ответ на ЭТОТ конкретный вопрос.

Два предметно-нейтральных примера для калибровки:
1. Вопрос "Можно ли отправить форму по электронной почте?" + правило об увеличенном сроке для международной доставки -> IRRELEVANT (способ отправки не зависит от срока доставки).
2. Вопрос "Можно ли применить скидку?" + исключение для некоммерческих организаций -> CONDITIONALLY_RELEVANT, potentiallyDecidingFacts: ["organizationType"] (ответ зависит от типа организации, а вопрос его не называет).

Не оценивай тематическое сходство слов. Оценивай: способно ли это правило изменить ответ на ДАННЫЙ вопрос.

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
        `Правило-исключение:\nУтверждение: ${candidate.statement}\nЦитата: "${candidate.quote}"\n\n` +
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
        '\n\nДля пакетного запроса верни СТРОГО JSON: {"results":[{"unitId":"...","verdict":"...","reason":"...","potentiallyDecidingFacts":[]}]}. Верни ровно один результат для каждого переданного unitId.',
    },
    {
      role: 'user',
      content:
        `Вопрос: "${question}"\n\nПравила-исключения:\n` +
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

/** The singular return is retained only for existing one-candidate test
 * doubles. Production always uses the batched array contract. */
export type DecisionRelevanceBatchClassifier = (
  options: EvaluateDecisionRelevanceBatchOptions
) => Promise<readonly ClassifiedDecisionRelevance[] | DecisionRelevance>;

export const evaluateDecisionRelevanceBatch: DecisionRelevanceBatchClassifier = async (options) => {
  const result = await structured({
    schema: batchDecisionRelevanceResponseSchema,
    messages: buildBatchDecisionRelevancePromptMessages(options.question, options.candidates),
    runConfig: options.runConfig,
  });
  return result.data.results;
};

// ─────────────────────────── deterministic gate ────────────────────────────

export interface GateCandidateInput {
  readonly evaluated: EvaluatedCandidate;
  readonly statement: string;
  readonly quote: string;
}

export interface GatedCandidate {
  readonly unitId: string;
  readonly relevance: DecisionRelevance;
}

export interface DecisionRelevanceGateResult {
  readonly relevant: readonly EvaluatedCandidate[];
  /** EVERY candidate with its verdict, relevant or not — full trace for
   *  debugging real company documents later (architectural review §6). */
  readonly trace: readonly GatedCandidate[];
  /**
   * unitId исключений, снятых ИСКЛЮЧИТЕЛЬНО вердиктом LLM-классификатора —
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
}

/** True iff `parentRef` names ANOTHER candidate in this same pool that is
 *  itself scope-matched — structural proof the parent is in play for this
 *  query, so the exception referencing it is too. No LLM call needed. */
function hasScopeMatchedParent(
  parentRef: string | null,
  byUnitId: ReadonlyMap<string, EvaluatedCandidate>
): boolean {
  if (parentRef === null) return false;
  const parent = byUnitId.get(parentRef);
  return parent !== undefined && parent.scope.verdict === 'MATCH';
}

export async function applyDecisionRelevanceGate(
  candidates: readonly GateCandidateInput[],
  question: string,
  runConfig: ExtractionRunConfig,
  classifier: DecisionRelevanceBatchClassifier = evaluateDecisionRelevanceBatch
): Promise<DecisionRelevanceGateResult> {
  const byUnitId = new Map(candidates.map((c) => [c.evaluated.unitId, c.evaluated]));
  const trace: GatedCandidate[] = [];
  const relevant: EvaluatedCandidate[] = [];
  const droppedByClassifier: string[] = [];

  const unresolved = candidates.filter((candidate) => {
    const ev = candidate.evaluated;
    return (
      ev.kind === 'EXCEPTION_RULE' &&
      (ev.trigger === null || ev.trigger.verdict === 'UNKNOWN') &&
      !hasScopeMatchedParent(ev.parentRuleRef, byUnitId)
    );
  });
  const classifiedByUnitId = new Map<string, DecisionRelevance>();
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
    const normalized: readonly ClassifiedDecisionRelevance[] = Array.isArray(classified)
      ? classified
      : unresolved.length === 1
        ? [{ unitId: unresolved[0].evaluated.unitId, ...classified }]
        : (() => {
            throw new Error('Batched decision-relevance classifier returned a singular result for multiple candidates');
          })();
    for (const decision of normalized) {
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
    if (classifiedByUnitId.size !== unresolved.length) {
      throw new Error('Batched decision-relevance classifier returned an unexpected unitId');
    }
  }

  for (const candidate of candidates) {
    const ev = candidate.evaluated;

    let relevance: DecisionRelevance;
    let decidedByClassifier = false;
    if (ev.kind !== 'EXCEPTION_RULE') {
      relevance = {
        verdict: 'RELEVANT',
        reason: 'not an exception — already scope-matched by retrieval/applicability',
        potentiallyDecidingFacts: [],
      };
    } else if (ev.trigger !== null && ev.trigger.verdict !== 'UNKNOWN') {
      relevance = {
        verdict: 'RELEVANT',
        reason: `trigger already confidently ${ev.trigger.verdict} — resolution handles this deterministically`,
        potentiallyDecidingFacts: [],
      };
    } else if (hasScopeMatchedParent(ev.parentRuleRef, byUnitId)) {
      relevance = {
        verdict: 'CONDITIONALLY_RELEVANT',
        reason: 'parent/base rule is itself a relevant candidate for this question',
        potentiallyDecidingFacts: ev.trigger?.missingFacts ?? [],
      };
    } else {
      relevance = classifiedByUnitId.get(ev.unitId)!;

      // Вердикт классификатора здесь — ЕДИНСТВЕННОЕ основание отбросить
      // кандидата (см. `droppedByClassifier` и разбор ниже).
      decidedByClassifier = true;
    }

    trace.push({ unitId: ev.unitId, relevance });
    if (relevance.verdict === 'IRRELEVANT') {
      if (decidedByClassifier) droppedByClassifier.push(ev.unitId);
    } else {
      relevant.push(ev);
    }
  }

  return {
    relevant,
    trace,
    droppedByClassifier,
    answerDependsOnProbabilisticExclusion: droppedByClassifier.length > 0,
  };
}
