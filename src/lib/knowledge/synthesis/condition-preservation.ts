import type { ChatMessage, CompletionAttempt } from '@/lib/ai/chat-provider';
import type { ExtractionRunConfig } from '@/lib/ai/extraction-run';
import { PaidStructuredSemanticError, structured } from '@/lib/ai/structured-output';
import { z } from 'zod';
import type { DraftAnswer } from './draft-answer';
import type { EvidencePack } from './evidence-pack';
import type { VerificationResult } from './verify-answer-claims';

export const CONDITION_PRESERVATION_VERDICTS = ['PRESERVED', 'DROPPED', 'AMBIGUOUS'] as const;
export interface ConditionPreservationDecision { readonly unitId: string; readonly verdict: (typeof CONDITION_PRESERVATION_VERDICTS)[number]; readonly reason: string }
export const conditionPreservationResponseSchema = z.strictObject({ results: z.array(z.strictObject({ unitId: z.string().min(1), verdict: z.enum(CONDITION_PRESERVATION_VERDICTS), reason: z.string().min(1) })) });
export interface ConditionedEvidence { readonly unitId: string; readonly statement: string; readonly conditions: readonly string[]; readonly applicabilityMode: 'NORMAL' | 'CONDITIONAL' | 'NEGATIVE' }
export interface ConditionPreservationResult { readonly decisions: readonly ConditionPreservationDecision[]; readonly blockingUnitIds: readonly string[]; readonly attempts: readonly CompletionAttempt[]; readonly requestMessages: readonly ChatMessage[]; readonly responseText: string | null }

export function conditionedEvidenceOf(pack: EvidencePack): ConditionedEvidence[] {
  return pack.items.flatMap((item) => (item.presentationConditions?.length ?? 0) > 0
    ? [{ unitId: item.unitId, statement: item.statement, conditions: item.presentationConditions!, applicabilityMode: item.applicabilityMode ?? 'NORMAL' }]
    : []);
}

export function buildConditionPreservationMessages(question: string, draft: DraftAnswer, evidence: readonly ConditionedEvidence[]): ChatMessage[] {
  return [{ role: 'system', content: 'Проверь, что каждое условие применимости явно привязано в ответе к своему правилу и сохранена ПОЛЯРНОСТЬ режима. CONDITIONAL запрещено превращать в безусловное разрешение. NEGATIVE означает, что необходимое условие отсутствует: правило может обосновывать только отказ; фраза «условия нет, но действие разрешено» означает DROPPED. PRESERVED — условие и полярность сохранены; DROPPED — потеряны; AMBIGUOUS — нельзя доказать сохранение. Ответ строго JSON: {"results":[{"unitId":"...","verdict":"PRESERVED|DROPPED|AMBIGUOUS","reason":"..."}]}.' }, { role: 'user', content: `Вопрос: "${question}"\nОтвет: "${draft.text}"\n\nУсловные правила:\n${evidence.map((item) => `unitId: ${item.unitId}\nПравило: ${item.statement}\nУсловия: ${item.conditions.map((c) => `"${c}"`).join(', ')}\nРежим: ${item.applicabilityMode}`).join('\n\n')}` }];
}

export interface VerifyConditionPreservationOptions { readonly question: string; readonly draft: DraftAnswer; readonly pack: EvidencePack; readonly runConfig: ExtractionRunConfig }
export function validateConditionPreservationDecisions(expectedUnitIds: readonly string[], decisions: readonly ConditionPreservationDecision[], telemetry: { attempts: readonly CompletionAttempt[]; requestMessages: readonly ChatMessage[]; responseText: string | null }): void {
  try {
    const expected = new Set(expectedUnitIds); const seen = new Set<string>();
    for (const decision of decisions) { if (!expected.has(decision.unitId)) throw new Error(`Condition verifier returned unexpected unitId: ${decision.unitId}`); if (seen.has(decision.unitId)) throw new Error(`Condition verifier returned duplicate unitId: ${decision.unitId}`); seen.add(decision.unitId); }
    for (const unitId of expected) if (!seen.has(unitId)) throw new Error(`Condition verifier omitted unitId: ${unitId}`);
  } catch (error) { throw new PaidStructuredSemanticError(error instanceof Error ? error.message : String(error), telemetry, { cause: error }); }
}
export async function verifyConditionPreservation(options: VerifyConditionPreservationOptions): Promise<ConditionPreservationResult> {
  const evidence = conditionedEvidenceOf(options.pack);
  if (evidence.length === 0) return { decisions: [], blockingUnitIds: [], attempts: [], requestMessages: [], responseText: null };
  const messages = buildConditionPreservationMessages(options.question, options.draft, evidence);
  const result = await structured({ schema: conditionPreservationResponseSchema, messages, runConfig: options.runConfig });
  validateConditionPreservationDecisions(evidence.map((item) => item.unitId), result.data.results, { attempts: result.attempts, requestMessages: result.requestMessages ?? messages, responseText: result.rawText ?? null });
  return { decisions: result.data.results, blockingUnitIds: result.data.results.filter((d) => d.verdict !== 'PRESERVED').map((d) => d.unitId), attempts: result.attempts, requestMessages: result.requestMessages ?? messages, responseText: result.rawText ?? null };
}

export type ConditionPreservationVerifier = (options: VerifyConditionPreservationOptions) => Promise<ConditionPreservationResult>;
export async function verifyConditionsAfterBasicVerification(basicVerified: boolean, options: VerifyConditionPreservationOptions, verifier: ConditionPreservationVerifier = verifyConditionPreservation): Promise<ConditionPreservationResult | null> {
  if (!basicVerified) return null;
  if (conditionedEvidenceOf(options.pack).length === 0) return null;
  return verifier(options);
}

export function mergeConditionPreservationVerification(basic: VerificationResult, preservation: ConditionPreservationResult | null): VerificationResult {
  if (preservation === null || preservation.blockingUnitIds.length === 0) return basic;
  return { verified: false, violations: [...basic.violations, ...preservation.blockingUnitIds.map((unitId) => ({ code: 'condition_not_preserved' as const, detail: `условие применимости unit ${unitId} не сохранено однозначно` }))] };
}
