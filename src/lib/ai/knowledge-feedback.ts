// Self-improving knowledge loop.
//
// When the bot answers with low trust (general AI knowledge, low/insufficient
// confidence), we store a DRAFT question→answer pair as an AIQuestion of
// issueType 'knowledge_gap'. An admin then approves / edits / rejects it
// (Telegram buttons or the web /admin/ai-questions page). On approval the draft
// becomes an ACTIVE QAPair tagged with the scenario and marked ai-suggested, so
// the next identical question is answered from the base.
//
// Human gate ALWAYS: the draft answer is unverified AI knowledge and can be
// wrong — nothing auto-saves.

import prisma from '@/lib/db';
import type { EnhancedAnswerResult } from '@/lib/ai/enhanced-answering-engine';
import { classifyScenario } from '@/lib/knowledge/scenario-classifier';

/** True when the answer is low-trust and worth capturing as a draft rule. */
export function isLowTrust(result: EnhancedAnswerResult): boolean {
  // A clarification prompt is not an answer — nothing to capture.
  if (result.scenarioClarification) return false;
  if (result.answerSource === 'general_ai') return true;
  if (result.confidenceLevel === 'low' || result.confidenceLevel === 'insufficient') return true;
  return false;
}

/**
 * Fire-and-forget: if the answer is low-trust, store a draft Q→A suggestion in
 * AIQuestion (issueType 'knowledge_gap') for admin approval. Deduped by exact
 * question among OPEN gaps. Never throws into the caller.
 */
export async function createKnowledgeGapSuggestion(params: {
  question: string;
  result: EnhancedAnswerResult;
  source: 'WEB' | 'TELEGRAM' | 'API';
  sessionId?: string;
}): Promise<void> {
  try {
    if (!isLowTrust(params.result)) return;

    // Dedup: don't pile up identical OPEN drafts for the same question.
    const dupe = await prisma.aIQuestion.findFirst({
      where: { issueType: 'knowledge_gap', status: 'OPEN', question: params.question },
      select: { id: true },
    });
    if (dupe) return;

    // Draft answer = the answer we already produced. For out_of_scope "нет
    // данных" (insufficient → low-trust) the draft answer is the no-data text,
    // which the admin replaces with the real answer when they edit & approve.
    const draftAnswer = params.result.answer;

    let scenarioKey: string | null = null;
    try {
      const d = await classifyScenario(params.question);
      scenarioKey = d.kind === 'scenario_clear' ? d.scenarioKey : null;
    } catch {
      /* scenario tag is best-effort */
    }

    await prisma.aIQuestion.create({
      data: {
        issueType: 'knowledge_gap',
        question: params.question,
        status: 'OPEN',
        context: {
          source: params.source,
          sessionId: params.sessionId ?? null,
          answerSource: params.result.answerSource ?? null,
          confidenceLevel: params.result.confidenceLevel,
          draft: { question: params.question, answer: draftAnswer, scenarioKey },
        },
      },
    });
    console.log('[knowledge-feedback] knowledge_gap draft created for:', params.question.slice(0, 80));
  } catch (e) {
    console.warn('[knowledge-feedback] createKnowledgeGapSuggestion failed:', e);
  }
}

interface Draft {
  question?: string;
  answer?: string;
  scenarioKey?: string | null;
}

/**
 * Approve a knowledge_gap draft → create an ACTIVE QAPair (the answer may be
 * edited by the admin) and mark the AIQuestion ANSWERED. Returns the QAPair id.
 */
export async function approveKnowledgeGap(
  id: string,
  opts: { answer?: string; scenarioKey?: string | null; approvedBy: string }
): Promise<{ qaPairId: string }> {
  const aq = await prisma.aIQuestion.findUnique({ where: { id } });
  if (!aq || aq.issueType !== 'knowledge_gap') throw new Error('not a knowledge_gap suggestion');
  if (aq.status !== 'OPEN') throw new Error('already resolved');

  const draft = ((aq.context as Record<string, unknown> | null)?.draft ?? {}) as Draft;
  const question = (draft.question ?? aq.question).trim();
  const answer = (opts.answer ?? draft.answer ?? '').trim();
  if (answer.length < 5) throw new Error('answer too short');
  const scenarioKey = opts.scenarioKey !== undefined ? opts.scenarioKey : draft.scenarioKey ?? null;

  const qa = await prisma.qAPair.create({
    data: {
      question,
      answer,
      status: 'ACTIVE',
      scenarioKey,
      metadata: {
        origin: 'ai-suggested',
        approvedBy: opts.approvedBy,
        approvedAt: new Date().toISOString(),
        fromAIQuestion: id,
      },
    },
  });

  await prisma.aIQuestion.update({
    where: { id },
    data: { status: 'ANSWERED', respondedAt: new Date(), response: `approved → QAPair ${qa.id}` },
  });

  return { qaPairId: qa.id };
}

/** Reject a knowledge_gap draft → mark the AIQuestion DISMISSED. */
export async function rejectKnowledgeGap(id: string): Promise<void> {
  await prisma.aIQuestion.update({
    where: { id },
    data: { status: 'DISMISSED', respondedAt: new Date() },
  });
}
