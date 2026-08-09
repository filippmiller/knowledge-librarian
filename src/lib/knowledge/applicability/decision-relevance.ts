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
 *    `EXCEPTION_RULE` with an unresolved trigger AND no structurally-proven
 *    relevant parent. This is exactly the genuinely ambiguous remainder —
 *    real judgment about THIS question's content, not a blanket score
 *    threshold (which the architectural review explicitly rejected: reranker
 *    scores are model- and query-relative, too fragile as the sole signal).
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

Два примера для калибровки:
1. Вопрос "Нужно ли мыть руки, если они выглядят чистыми?" + правило об ограниченной подвижности и помощи другого человека -> IRRELEVANT (вопрос не о подвижности).
2. Вопрос "Можно ли это делать здесь?" + правило-исключение про общественное/приватное место -> CONDITIONALLY_RELEVANT, potentiallyDecidingFacts: ["privacyContext"] (ответ буквально зависит от места, а вопрос его не называет).

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
  classifier: DecisionRelevanceClassifier = evaluateDecisionRelevance
): Promise<DecisionRelevanceGateResult> {
  const byUnitId = new Map(candidates.map((c) => [c.evaluated.unitId, c.evaluated]));
  const trace: GatedCandidate[] = [];
  const relevant: EvaluatedCandidate[] = [];

  for (const candidate of candidates) {
    const ev = candidate.evaluated;

    let relevance: DecisionRelevance;
    if (ev.kind !== 'EXCEPTION_RULE') {
      relevance = {
        verdict: 'RELEVANT',
        reason: 'not an exception — already scope-matched by retrieval/applicability',
        potentiallyDecidingFacts: [],
      };
    } else if (ev.trigger === null) {
      // No triggerCondition at all — a malformed/incomplete extraction, not
      // a relevance question. resolveKnowledgeSet already excludes this
      // deterministically (`exception_without_trigger`) and raises
      // `requiresHumanReview` for the data-quality issue; silently filtering
      // it here as IRRELEVANT would suppress that signal instead of letting
      // the existing, correct handling run.
      relevance = {
        verdict: 'RELEVANT',
        reason: 'no trigger condition at all — resolution\'s exception_without_trigger handling applies',
        potentiallyDecidingFacts: [],
      };
    } else if (ev.trigger.verdict !== 'UNKNOWN') {
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
      relevance = await classifier({
        question,
        candidate: { unitId: ev.unitId, statement: candidate.statement, quote: candidate.quote },
        runConfig,
      });
    }

    trace.push({ unitId: ev.unitId, relevance });
    if (relevance.verdict !== 'IRRELEVANT') relevant.push(ev);
  }

  return { relevant, trace };
}
