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

import { KnowledgeAudience } from '@prisma/client';
import prisma from '@/lib/db';
import type { EnhancedAnswerResult } from '@/lib/ai/enhanced-answering-engine';
import { classifyScenario } from '@/lib/knowledge/scenario-classifier';
import { isDraftableDraft } from '@/lib/ai/answer-policy';
import { upsertLearnedQaPair } from '@/lib/knowledge/qa-upsert';
import { checkClientSafety, type Audience } from '@/lib/knowledge/audience';
import { extractRiskyClaims } from '@/lib/ai/claim-grounding';

/** Контур, в котором был задан вопрос → метка знания, которую получит пара. */
function audienceToKnowledge(audience: Audience): KnowledgeAudience {
  return audience === 'client' ? KnowledgeAudience.CLIENT_SAFE : KnowledgeAudience.INTERNAL_ONLY;
}

/**
 * Аудитория черновика. Записывается при создании и читается при утверждении:
 * между ними проходит человек, и восстановить контур по тексту вопроса нельзя.
 * Старые черновики поля не имеют — для них безопасный дефолт `internal`,
 * потому что ошибка в эту сторону сужает ответ, а не выпускает внутренние
 * факты клиенту.
 */
function readDraftAudience(context: unknown): Audience {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return 'internal';
  return (context as Record<string, unknown>).audience === 'client' ? 'client' : 'internal';
}

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
  /** Контур, в котором задан вопрос. Обязателен: без него утверждённая пара
   *  уходит во внутренние и клиентский контур ничему не учится. */
  audience: Audience;
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
      select: { question: true, context: true },
      take: 300,
      orderBy: { createdAt: 'desc' },
    });
    // Дедуп внутри контура: один и тот же вопрос от клиента и от сотрудника —
    // это два разных черновика с разным составом допустимых фактов.
    if (
      openGaps.some(
        (g) =>
          normalizeQuestion(g.question) === target &&
          readDraftAudience(g.context) === params.audience
      )
    ) {
      return null;
    }

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
          audience: params.audience,
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
  // Контур берётся из черновика, а не угадывается: между созданием и
  // утверждением проходит человек, и вопрос «клиентский он или внутренний» по
  // одному тексту уже не восстановить.
  const audience = audienceToKnowledge(readDraftAudience(aq.context));

  // Оператор вправе отредактировать черновик перед утверждением, и правка не
  // проходит ни одной проверки движка. Так в базу попадает утверждение, которое
  // синтез никогда бы не выпустил: адрес госоргана в клиентской паре или цена,
  // взятая из головы. Пара при этом становится постоянной — её будут выдавать
  // снова и снова.
  //
  // Клиентскую пару с маршрутом наружу отклоняем: она прямо противоречит цели
  // контура. Про числа только предупреждаем — источников на этом шаге уже нет,
  // и отличить выдуманную цену от правильной, но отредактированной, нельзя.
  if (audience === KnowledgeAudience.CLIENT_SAFE) {
    const safety = checkClientSafety(answer);
    if (!safety.safe) {
      throw new Error(
        `Ответ уводит клиента наружу (${safety.violations.join(', ')}) — как клиентскую пару сохранять нельзя`
      );
    }
  }
  const editedByOperator = opts.answer !== undefined && opts.answer.trim() !== (draft.answer ?? '').trim();
  if (editedByOperator) {
    const claims = extractRiskyClaims(answer);
    if (claims.length > 0) {
      console.warn(
        '[knowledge-feedback] Оператор отредактировал черновик и в ответе есть числа (%s). Источники на этом шаге недоступны — проверить вручную: %s',
        claims.map((c) => `${c.value}/${c.unit}`).join(', '),
        question.slice(0, 80)
      );
    }
  }

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

    const upsert = await upsertLearnedQaPair(tx, {
      question,
      answer,
      audience,
      scenarioKey,
      metadata: {
        origin: 'ai-suggested',
        audience: audience === 'CLIENT_SAFE' ? 'client' : 'internal',
        approvedBy: opts.approvedBy,
        approvedAt: new Date().toISOString(),
        fromAIQuestion: id,
      },
    });

    if (upsert.reused) {
      await tx.aIQuestion.update({
        where: { id },
        data: { response: `approved → existing QAPair ${upsert.qaPairId}` },
      });
      return { qaPairId: upsert.qaPairId };
    }

    await tx.knowledgeChange.create({
      data: {
        targetType: 'QA_PAIR',
        targetId: upsert.qaPairId,
        changeType: upsert.supersededId ? 'SUPERSEDE' : 'CREATE',
        oldValue: upsert.previous,
        newValue: { question, answer, version: upsert.version, scenarioKey, audience },
        reason: upsert.supersededId ? 'Утверждена новая версия ответа через human review' : 'Утверждён новый ответ через human review',
        initiatedBy: 'ADMIN',
        approvedBy: opts.approvedBy,
        status: 'APPROVED',
        reviewedAt: new Date(),
      },
    });

    await tx.aIQuestion.update({
      where: { id },
      data: { response: `approved → QAPair ${upsert.qaPairId}` },
    });

    return { qaPairId: upsert.qaPairId };
  });
}

/** Reject a knowledge_gap draft → mark the AIQuestion DISMISSED. */
export async function rejectKnowledgeGap(id: string): Promise<void> {
  await prisma.aIQuestion.update({
    where: { id },
    data: { status: 'DISMISSED', respondedAt: new Date() },
  });
}
