/**
 * Semantic answer judge (goal-shift continuation, 2026-08-09, Task 22).
 *
 * The deterministic grader (case-grader.ts / grade-aurora-fixture.ts) only
 * proves STRUCTURAL correctness — right rule selected, no unsupported
 * numbers, right disposition, evidence-group coverage. It cannot know
 * whether the generated PROSE is actually right. This module is that
 * missing layer.
 *
 * ORACLE ISOLATION: this module reads `expectedAnswer` — it lives in
 * `src/lib/eval/` (oracle-adjacent, same role as case-grader.ts), and the
 * CALLER is responsible for only invoking it after the engine has already
 * produced `actualAnswer`/`selectedEvidenceStatements` (this module has no
 * way to enforce that ordering itself, same as case-grader.ts's own
 * discipline note about oracle-blind construction).
 *
 * A structural PASS and a semantic verdict are two separate signals — a
 * caller deciding overall pass/fail should require BOTH, per the task's
 * explicit instruction: "the semantic judge does not override an
 * objective deterministic failure."
 */

import type { ChatMessage } from '@/lib/ai/chat-provider';
import type { CompletionRunConfig } from '@/lib/ai/chat-provider';
import { structured } from '@/lib/ai/structured-output';
import { z } from 'zod';

export const SEMANTIC_VERDICTS = ['CORRECT', 'PARTIALLY_CORRECT', 'INCORRECT', 'UNSUPPORTED', 'OVERCLAIMED'] as const;
export type SemanticVerdict = (typeof SEMANTIC_VERDICTS)[number];

export interface SemanticJudgeInput {
  readonly question: string;
  readonly actualAnswer: string;
  readonly selectedEvidenceStatements: readonly string[];
  readonly expectedAnswer: string;
}

export interface RawJudgeVerdict {
  readonly verdict: SemanticVerdict;
  readonly reasoning: string;
  readonly confidence: number;
}

export interface JudgeProvenance {
  readonly provider: string;
  readonly model: string;
  readonly promptVersion: string;
}

export interface SemanticJudgeResult extends RawJudgeVerdict {
  readonly judgeProvider: string;
  readonly judgeModel: string;
  readonly judgePromptVersion: string;
}

const SYSTEM_PROMPT = `Ты сравниваешь ДВА текста: реальный ответ системы и эталонный (ожидаемый) ответ на тот же вопрос — по СУТИ, не по формулировке.

verdict:
- CORRECT — реальный ответ верно передаёт содержание эталонного ответа (формулировка может отличаться).
- PARTIALLY_CORRECT — часть верна, часть неверна или пропущена.
- INCORRECT — реальный ответ противоречит эталонному по существу.
- UNSUPPORTED — реальный ответ не подтверждён предоставленным evidence (даже если текст похож на эталон).
- OVERCLAIMED — реальный ответ утверждает больше, чем подтверждено evidence или чем говорит эталон.

confidence: число от 0 до 1 — насколько ты уверен в вердикте.
reasoning: коротко, почему именно этот вердикт.

Ответ СТРОГО JSON: {"verdict": "...", "reasoning": "...", "confidence": число}`;

export function buildJudgePromptMessages(input: SemanticJudgeInput): ChatMessage[] {
  const evidence =
    input.selectedEvidenceStatements.length > 0
      ? input.selectedEvidenceStatements.map((s, i) => `${i + 1}. ${s}`).join('\n')
      : '(нет)';
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Вопрос: "${input.question}"\n\nРеальный ответ системы:\n${input.actualAnswer}\n\nEvidence, на которых построен реальный ответ:\n${evidence}\n\nЭталонный (ожидаемый) ответ:\n${input.expectedAnswer}\n\nВынеси вердикт.`,
    },
  ];
}

export function interpretJudgeResponse(
  raw: RawJudgeVerdict,
  provenance: JudgeProvenance
): SemanticJudgeResult {
  return {
    ...raw,
    judgeProvider: provenance.provider,
    judgeModel: provenance.model,
    judgePromptVersion: provenance.promptVersion,
  };
}

const judgeResponseSchema = z.strictObject({
  verdict: z.enum(SEMANTIC_VERDICTS),
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});

export interface JudgeAnswerOptions {
  readonly input: SemanticJudgeInput;
  readonly runConfig: CompletionRunConfig;
}

/**
 * Real-call wrapper. `runConfig` should identify a model/provider
 * DIFFERENT from the synthesis generator where practical — a judge built
 * from the same material as the defendant repeats its errors (same
 * principle already documented in verify-answer-claims.ts's header, for
 * the deterministic layer; this is the same argument applied to the LLM
 * layer instead of ruling LLM judgment out entirely).
 */
export async function judgeAnswer(options: JudgeAnswerOptions): Promise<SemanticJudgeResult> {
  const result = await structured({
    schema: judgeResponseSchema,
    messages: buildJudgePromptMessages(options.input),
    runConfig: { ...options.runConfig, fallbackPolicy: 'NONE' },
  });
  return interpretJudgeResponse(result.data, {
    provider: options.runConfig.provider,
    model: options.runConfig.model,
    promptVersion: options.runConfig.promptVersion,
  });
}
