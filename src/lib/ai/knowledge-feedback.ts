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
import { isDraftableDraft } from '@/lib/ai/answer-policy';

/** True when the answer is low-trust and worth capturing as a draft rule. */
export function isLowTrust(result: EnhancedAnswerResult): boolean {
  // A clarification prompt is not an answer — nothing to capture.
  if (result.scenarioClarification) return false;
  if (result.answerSource === 'general_ai') return true;
  if (result.requiresHumanReview) return true;
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
}): Promise<string | null> {
  try {
    if (!isLowTrust(params.result)) return null;

    // Dedup: don't pile up duplicate OPEN drafts. Compare on a NORMALIZED form
    // (trim / lowercase / collapse whitespace) so "Как апостилировать СОР" and
    // "как  апостилировать сор" don't both queue. (A tiny race window remains for
    // truly simultaneous identical questions — harmless: worst case is two drafts
    // the admin sees and rejects one. A partial-unique DB index is the robust
    // follow-up.)
    const target = normalizeQuestion(params.question);
    const openGaps = await prisma.aIQuestion.findMany({
      where: { issueType: 'knowledge_gap', status: 'OPEN' },
      select: { question: true },
      take: 300,
      orderBy: { createdAt: 'desc' },
    });
    if (openGaps.some((g) => normalizeQuestion(g.question) === target)) return null;

    // Draft answer = the answer we already produced.
    const draftAnswer = params.result.answer;

    // Quality gate: never file a draft for a context-less fragment or a
    // "no data / please clarify" non-answer. These pollute the admin queue and,
    // if approved, poison the KB.
    if (!isDraftableDraft(params.question, draftAnswer)) return null;

    let scenarioKey: string | null = null;
    try {
      const d = await classifyScenario(params.question);
      scenarioKey = d.kind === 'scenario_clear' ? d.scenarioKey : null;
    } catch {
      /* scenario tag is best-effort */
    }

    const created = await prisma.aIQuestion.create({
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
      select: { id: true },
    });
    console.log('[knowledge-feedback] knowledge_gap draft created for:', params.question.slice(0, 80));
    return created.id;
  } catch (e) {
    console.warn('[knowledge-feedback] createKnowledgeGapSuggestion failed:', e);
    return null;
  }
}

interface Draft {
  question?: string;
  answer?: string;
  scenarioKey?: string | null;
}

/** Canonical form for dedup comparison: trim, lowercase, collapse whitespace. */
function normalizeQuestion(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Approve a knowledge_gap draft → create an ACTIVE QAPair (the answer may be
 * edited by the admin) and mark the AIQuestion ANSWERED. Returns the QAPair id.
 */
export async function approveKnowledgeGap(
  id: string,
  opts: { answer?: string; scenarioKey?: string | null; approvedBy: string }
): Promise<{ qaPairId: string }> {
  // Read first to validate the draft (cheap, no mutation).
  const aq = await prisma.aIQuestion.findUnique({ where: { id } });
  if (!aq || aq.issueType !== 'knowledge_gap') throw new Error('not a knowledge_gap suggestion');
  if (aq.status !== 'OPEN') throw new Error('already resolved');

  const draft = ((aq.context as Record<string, unknown> | null)?.draft ?? {}) as Draft;
  const question = (draft.question ?? aq.question).trim();
  const answer = (opts.answer ?? draft.answer ?? '').trim();
  if (answer.length < 5) throw new Error('answer too short');
  const scenarioKey = opts.scenarioKey !== undefined ? opts.scenarioKey : draft.scenarioKey ?? null;

  // Atomic claim + write. `updateMany` with a status guard is the lock: only ONE
  // concurrent approval can flip OPEN→ANSWERED (count === 1); a loser sees
  // count === 0 and aborts BEFORE creating a duplicate QAPair. The transaction
  // rolls the claim back if QAPair.create fails, so we never leave an ANSWERED
  // draft with no pair.
  return await prisma.$transaction(async (tx) => {
    const claim = await tx.aIQuestion.updateMany({
      where: { id, issueType: 'knowledge_gap', status: 'OPEN' },
      data: { status: 'ANSWERED', respondedAt: new Date() },
    });
    if (claim.count !== 1) throw new Error('already resolved');

    const existingQa = await tx.qAPair.findFirst({
      where: { question, status: 'ACTIVE' },
      orderBy: { updatedAt: 'desc' },
    });

    if (existingQa && existingQa.answer.trim() === answer) {
      await tx.aIQuestion.update({
        where: { id },
        data: { response: `approved → existing QAPair ${existingQa.id}` },
      });
      return { qaPairId: existingQa.id };
    }

    if (existingQa) {
      await tx.qAPair.update({
        where: { id: existingQa.id },
        data: { status: 'SUPERSEDED' },
      });
    }

    const qa = await tx.qAPair.create({
      data: {
        question,
        answer,
        status: 'ACTIVE',
        version: existingQa ? existingQa.version + 1 : 1,
        supersedesQaId: existingQa?.id,
        scenarioKey,
        metadata: {
          origin: 'ai-suggested',
          approvedBy: opts.approvedBy,
          approvedAt: new Date().toISOString(),
          fromAIQuestion: id,
        },
      },
    });

    await tx.knowledgeChange.create({
      data: {
        targetType: 'QA_PAIR',
        targetId: qa.id,
        changeType: existingQa ? 'SUPERSEDE' : 'CREATE',
        oldValue: existingQa ? { question: existingQa.question, answer: existingQa.answer, version: existingQa.version } : undefined,
        newValue: { question: qa.question, answer: qa.answer, version: qa.version, scenarioKey: qa.scenarioKey },
        reason: existingQa ? 'Утверждена новая версия ответа через human review' : 'Утверждён новый ответ через human review',
        initiatedBy: 'ADMIN',
        approvedBy: opts.approvedBy,
        status: 'APPROVED',
        reviewedAt: new Date(),
      },
    });

    await tx.aIQuestion.update({
      where: { id },
      data: { response: `approved → QAPair ${qa.id}` },
    });

    return { qaPairId: qa.id };
  });
}

/** Reject a knowledge_gap draft → mark the AIQuestion DISMISSED. */
export async function rejectKnowledgeGap(id: string): Promise<void> {
  await prisma.aIQuestion.update({
    where: { id },
    data: { status: 'DISMISSED', respondedAt: new Date() },
  });
}
