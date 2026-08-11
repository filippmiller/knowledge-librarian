import type { ChatMessage, CompletionAttempt } from '@/lib/ai/chat-provider';
import type { ExtractionRunConfig } from '@/lib/ai/extraction-run';
import { PaidStructuredSemanticError, structured } from '@/lib/ai/structured-output';
import { z } from 'zod';
import type {
  ChallengeCounterfactualResult,
  DecisionRelevanceChallenge,
  DecisionRelevanceGateResult,
} from '../applicability/decision-relevance';
import type { DraftAnswer } from './draft-answer';
import type { EvidencePack } from './evidence-pack';
import type { ResolutionDecision } from '../applicability/resolution';

export const CHALLENGE_COMPATIBILITY_VERDICTS = ['COMPATIBLE', 'CONFLICTS', 'AMBIGUOUS'] as const;
export type ChallengeCompatibilityVerdict = (typeof CHALLENGE_COMPATIBILITY_VERDICTS)[number];

export interface ChallengeCompatibilityDecision {
  readonly unitId: string;
  readonly verdict: ChallengeCompatibilityVerdict;
  readonly reason: string;
  readonly contradiction: 'NO' | 'YES' | 'UNKNOWN';
  readonly missingRequiredContent: 'NO' | 'YES' | 'UNKNOWN';
}

export interface ChallengeCompatibilityResult {
  readonly decisions: readonly ChallengeCompatibilityDecision[];
  readonly blockingUnitIds: readonly string[];
  readonly attempts: readonly CompletionAttempt[];
  readonly requestMessages: readonly ChatMessage[];
  readonly responseText: string | null;
}

export const challengeCompatibilityResponseSchema = z.strictObject({
  results: z.array(
    z.strictObject({
      unitId: z.string().min(1),
      verdict: z.enum(CHALLENGE_COMPATIBILITY_VERDICTS),
      reason: z.string().min(1),
      contradiction: z.enum(['NO', 'YES', 'UNKNOWN']),
      missingRequiredContent: z.enum(['NO', 'YES', 'UNKNOWN']),
    })
  ),
});

export function buildChallengeCompatibilityMessages(
  question: string,
  draft: DraftAnswer,
  challenges: readonly DecisionRelevanceChallenge[],
  pack: EvidencePack,
  resolution: ResolutionDecision,
  counterfactuals: ChallengeCounterfactualResult
): ChatMessage[] {
  return [
    {
      role: 'system',
      content:
        'Проверь готовый ответ против каждого дополнительного правила В КОНТЕКСТЕ уже выбранных доказательств и явных override-связей. ' +
        'COMPATIBLE — дополнительное правило не противоречит ответу И не добавляет обязательного содержания, которое в ответе отсутствует; ' +
        'CONFLICTS — правило опровергает ответ или требует оговорку; AMBIGUOUS — без неизвестного факта нельзя доказать совместимость. ' +
        'Сходство темы не достаточно. Различай действия буквально: разрешение узкого действия не является разрешением другого, более общего действия. ' +
        'Выбранное активное узкое исключение может сделать общее правило совместимым, если оно действительно разрешает описанное в ответе узкое действие. ' +
        'Верни COMPATIBLE только при явном доказательстве одновременно двух пунктов: нет противоречия и нет пропущенного обязательного содержания. ' +
        'Для каждого результата отдельно заполни contradiction и missingRequiredContent значением NO|YES|UNKNOWN. ' +
        'COMPATIBLE допустим только при NO+NO; CONFLICTS — когда хотя бы одно YES; AMBIGUOUS — когда YES нет, но хотя бы одно UNKNOWN. ' +
        'Ответ строго JSON: {"results":[{"unitId":"...","verdict":"COMPATIBLE|CONFLICTS|AMBIGUOUS","contradiction":"NO|YES|UNKNOWN","missingRequiredContent":"NO|YES|UNKNOWN","reason":"..."}]}.',
    },
    {
      role: 'user',
      content:
        `Вопрос: "${question}"\nОтвет: "${draft.text}"\n\n` +
        `Выбранные доказательства:\n${pack.items.map((item) =>
          `[${item.unitId}] ${item.statement}` +
          `${(item.presentationConditions?.length ?? 0) > 0 ? `\nУсловия: ${item.presentationConditions!.join('; ')}` : ''}` +
          `${item.applicabilityMode && item.applicabilityMode !== 'NORMAL' ? `\nРежим: ${item.applicabilityMode}` : ''}`
        ).join('\n\n')}\n\n` +
        `Resolution selected: ${resolution.selected.join(', ') || '(none)'}\n` +
        `Resolution overridden: ${resolution.overridden.map((item) => `${item.unitId} -> ${item.byUnitId}`).join(', ') || '(none)'}\n` +
        `Counterfactual restoration: ${Object.entries(counterfactuals.restoredDispositionByUnitId).map(([id, disposition]) => `${id}=${disposition}`).join(', ') || '(none)'}\n\n` +
        'Дополнительные правила:\n' +
        challenges
          .map((challenge) =>
            `unitId: ${challenge.unitId}\nУтверждение: ${challenge.statement}\nЦитата: "${challenge.quote}"`
          )
          .join('\n\n'),
    },
  ];
}

export interface VerifyChallengeCompatibilityOptions {
  readonly question: string;
  readonly draft: DraftAnswer;
  readonly challenges: readonly DecisionRelevanceChallenge[];
  readonly pack: EvidencePack;
  readonly resolution: ResolutionDecision;
  readonly counterfactuals: ChallengeCounterfactualResult;
  readonly runConfig: ExtractionRunConfig;
}

export function validateChallengeCompatibilityDecisions(
  expectedUnitIds: readonly string[],
  decisions: readonly ChallengeCompatibilityDecision[],
  telemetry: { attempts: readonly CompletionAttempt[]; requestMessages: readonly ChatMessage[]; responseText: string | null }
): void {
  try {
    const expected = new Set(expectedUnitIds);
    const seen = new Set<string>();
    for (const decision of decisions) {
      if (!expected.has(decision.unitId)) throw new Error(`Challenge verifier returned unexpected unitId: ${decision.unitId}`);
      if (seen.has(decision.unitId)) throw new Error(`Challenge verifier returned duplicate unitId: ${decision.unitId}`);
      const hasYes = decision.contradiction === 'YES' || decision.missingRequiredContent === 'YES';
      const hasUnknown = decision.contradiction === 'UNKNOWN' || decision.missingRequiredContent === 'UNKNOWN';
      const expectedVerdict = hasYes ? 'CONFLICTS' : hasUnknown ? 'AMBIGUOUS' : 'COMPATIBLE';
      if (decision.verdict !== expectedVerdict) {
        throw new Error(`Challenge verifier returned inconsistent verdict for ${decision.unitId}: ${decision.verdict} but checks require ${expectedVerdict}`);
      }
      seen.add(decision.unitId);
    }
    for (const unitId of expected) if (!seen.has(unitId)) throw new Error(`Challenge verifier omitted unitId: ${unitId}`);
  } catch (error) {
    throw new PaidStructuredSemanticError(error instanceof Error ? error.message : String(error), telemetry, { cause: error });
  }
}

export async function verifyChallengeCompatibility(
  options: VerifyChallengeCompatibilityOptions
): Promise<ChallengeCompatibilityResult> {
  if (options.challenges.length === 0) {
    return { decisions: [], blockingUnitIds: [], attempts: [], requestMessages: [], responseText: null };
  }
  const messages = buildChallengeCompatibilityMessages(
    options.question,
    options.draft,
    options.challenges,
    options.pack,
    options.resolution,
    options.counterfactuals
  );
  const result = await structured({ schema: challengeCompatibilityResponseSchema, messages, runConfig: options.runConfig });
  validateChallengeCompatibilityDecisions(
    options.challenges.map((challenge) => challenge.unitId),
    result.data.results,
    { attempts: result.attempts, requestMessages: result.requestMessages ?? messages, responseText: result.rawText ?? null }
  );
  const blockingUnitIds = result.data.results
    .filter((decision) => decision.verdict !== 'COMPATIBLE')
    .map((decision) => decision.unitId);
  return {
    decisions: result.data.results,
    blockingUnitIds,
    attempts: result.attempts,
    requestMessages: result.requestMessages ?? messages,
    responseText: result.rawText ?? null,
  };
}

export type ChallengeCompatibilityVerifier = (
  options: VerifyChallengeCompatibilityOptions
) => Promise<ChallengeCompatibilityResult>;

/** A draft that already failed deterministic grounding cannot become direct,
 * so spending another provider call cannot change delivery. Returning null
 * deliberately leaves challenge safety fail-closed. */
export async function verifyChallengesAfterBasicVerification(
  basicVerified: boolean,
  options: VerifyChallengeCompatibilityOptions,
  verifier: ChallengeCompatibilityVerifier = verifyChallengeCompatibility
): Promise<ChallengeCompatibilityResult | null> {
  if (!basicVerified) return null;
  return verifier(options);
}

export interface ProbabilisticExclusionSafety {
  readonly answerDependsOnProbabilisticExclusion: boolean;
  readonly blockingUnitIds: readonly string[];
}

/** Exactly one recovery round may promote only deterministic prerequisites
 * or provider-proven omissions (not contradictions) from ordinary rules. */
export function selectChallengeRecoveryCandidates(
  gate: DecisionRelevanceGateResult,
  compatibility: Pick<ChallengeCompatibilityResult, 'decisions'> | null
): readonly DecisionRelevanceChallenge[] {
  if (compatibility === null) return [];
  const decisions = new Map(compatibility.decisions.map((decision) => [decision.unitId, decision]));
  return gate.challengeCandidates.filter((challenge) => {
    if (challenge.evaluated.kind === 'EXCEPTION_RULE') return false;
    if (challenge.mandatoryPrerequisite) return true;
    const decision = decisions.get(challenge.unitId);
    return decision?.verdict === 'CONFLICTS' &&
      decision.contradiction === 'NO' &&
      decision.missingRequiredContent === 'YES';
  });
}

/** Fail closed: classifier-dropped exceptions always block. For an ordinary
 * rule an exact-ID COMPATIBLE decision may clear even a conservative
 * structural restoration HOLD, because the semantic check sees the draft,
 * selected evidence and override context. Every other outcome blocks. */
export function resolveProbabilisticExclusionSafety(
  gate: DecisionRelevanceGateResult,
  counterfactuals: ChallengeCounterfactualResult,
  compatibility: Pick<ChallengeCompatibilityResult, 'decisions'> | null
): ProbabilisticExclusionSafety {
  void counterfactuals; // retained in the API/artifact for auditable structural diagnostics
  const challengeIds = new Set(gate.challengeCandidates.map((challenge) => challenge.unitId));
  const blocking = new Set(gate.droppedByClassifier.filter((unitId) => !challengeIds.has(unitId)));
  const decisions = new Map(compatibility?.decisions.map((decision) => [decision.unitId, decision]) ?? []);
  for (const challenge of gate.challengeCandidates) {
    if (
      challenge.evaluated.kind === 'EXCEPTION_RULE' ||
      challenge.mandatoryPrerequisite ||
      decisions.get(challenge.unitId)?.verdict !== 'COMPATIBLE'
    ) {
      blocking.add(challenge.unitId);
    }
  }
  return {
    answerDependsOnProbabilisticExclusion: blocking.size > 0,
    blockingUnitIds: [...blocking],
  };
}
