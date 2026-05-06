import prisma from '@/lib/db';
import { createDocumentChunks } from '@/lib/ai/chunker';
import {
  extractKnowledge,
  getExistingRuleCodes,
  saveExtractedQAs,
  saveExtractedRules,
} from '@/lib/ai/knowledge-extractor';

type SourceSpan = {
  quote?: string;
  locationHint?: string;
  [key: string]: unknown;
};

export type RuleDocumentSyncResult = {
  attempted: boolean;
  updated: boolean;
  reason?: string;
  chunksCreated?: number;
  revisionId?: string;
};

export type DocumentRewriteResult = {
  chunksCreated: number;
  rulesCreated: number;
  qaPairsCreated: number;
  supersededRules: number;
  supersededQAPairs: number;
  revisionId: string;
};

export type DocumentRollbackResult = {
  documentId: string;
  restoredFromRevisionId: string;
  rollbackRevisionId: string;
  chunksCreated: number;
};

function asSourceSpan(value: unknown): SourceSpan {
  return value && typeof value === 'object' ? value as SourceSpan : {};
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function findApproximateRange(text: string, needle: string): { start: number; end: number } | null {
  const normalizedNeedle = normalizeWhitespace(needle);
  if (normalizedNeedle.length < 16) return null;

  const exactIndex = text.indexOf(needle);
  if (exactIndex !== -1) return { start: exactIndex, end: exactIndex + needle.length };

  const compactText = normalizeWhitespace(text);
  const compactIndex = compactText.indexOf(normalizedNeedle);
  if (compactIndex === -1) return null;

  let normalizedPosition = 0;
  let start = -1;
  let end = -1;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextIsSpace = /\s/.test(char);
    if (nextIsSpace) {
      if (i > 0 && !/\s/.test(text[i - 1])) normalizedPosition++;
    } else {
      if (normalizedPosition === compactIndex && start === -1) start = i;
      normalizedPosition++;
      if (normalizedPosition >= compactIndex + normalizedNeedle.length) {
        end = i + 1;
        break;
      }
    }
  }

  return start >= 0 && end > start ? { start, end } : null;
}

function patchText(text: string, candidates: string[], replacement: string): { text: string; matched?: string } {
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;

    const range = findApproximateRange(text, trimmed);
    if (!range) continue;

    return {
      text: `${text.slice(0, range.start)}${replacement}${text.slice(range.end)}`,
      matched: trimmed,
    };
  }

  return { text };
}

function excerpt(value: string): string {
  return value.slice(0, 2000);
}

async function getDocumentDomainIds(documentId: string): Promise<string[]> {
  const links = await prisma.documentDomain.findMany({
    where: { documentId },
    select: { domainId: true },
  });
  return links.map((link) => link.domainId);
}

export async function rebuildDocumentChunks(documentId: string, rawText: string): Promise<number> {
  const domainIds = await getDocumentDomainIds(documentId);
  await prisma.docChunk.deleteMany({ where: { documentId } });
  const createdChunkIds = await createDocumentChunks(documentId, rawText, domainIds);
  return createdChunkIds.length;
}

export async function syncRuleEditToDocument(params: {
  ruleId: string;
  newBody: string;
  previousBody?: string | null;
  editedBy?: string | null;
}): Promise<RuleDocumentSyncResult> {
  const rule = await prisma.rule.findUnique({
    where: { id: params.ruleId },
    include: { document: { select: { id: true, rawText: true } } },
  });

  if (!rule?.documentId || !rule.document?.rawText) {
    return { attempted: false, updated: false, reason: 'Правило не привязано к документу' };
  }

  const sourceSpan = asSourceSpan(rule.sourceSpan);
  const oldQuote = typeof sourceSpan.quote === 'string' ? sourceSpan.quote : '';
  const patch = patchText(rule.document.rawText, [oldQuote, params.previousBody ?? '', rule.body], params.newBody);

  if (!patch.matched || patch.text === rule.document.rawText) {
    return { attempted: true, updated: false, reason: 'Исходный фрагмент не найден в документе' };
  }

  const revision = await prisma.documentRevision.create({
    data: {
      documentId: rule.documentId,
      source: 'RULE_EDIT',
      ruleId: rule.id,
      actor: params.editedBy ?? null,
      previousRawText: rule.document.rawText,
      nextRawText: patch.text,
      previousExcerpt: excerpt(patch.matched),
      nextExcerpt: excerpt(params.newBody),
      metadata: {
        ruleCode: rule.ruleCode,
        previousBody: params.previousBody ?? null,
      },
    },
  });

  await prisma.document.update({
    where: { id: rule.documentId },
    data: { rawText: patch.text, parseStatus: 'COMPLETED', parseError: null },
  });

  const chunksCreated = await rebuildDocumentChunks(rule.documentId, patch.text);

  await prisma.rule.update({
    where: { id: rule.id },
    data: {
      sourceSpan: {
        ...sourceSpan,
        quote: params.newBody.slice(0, 500),
        previousQuote: patch.matched.slice(0, 500),
        syncedToDocumentAt: new Date().toISOString(),
        syncedToDocumentBy: params.editedBy ?? null,
      },
    },
  });

  return { attempted: true, updated: true, chunksCreated, revisionId: revision.id };
}

export async function rewriteDocumentAndKnowledge(params: {
  documentId: string;
  rawText: string;
  editedBy?: string | null;
}): Promise<DocumentRewriteResult> {
  const document = await prisma.document.findUnique({
    where: { id: params.documentId },
    select: { id: true, rawText: true },
  });
  if (!document) throw new Error('Документ не найден');

  const domainIds = await getDocumentDomainIds(params.documentId);

  const revision = await prisma.documentRevision.create({
    data: {
      documentId: params.documentId,
      source: 'DOCUMENT_EDIT',
      actor: params.editedBy ?? null,
      previousRawText: document.rawText ?? null,
      nextRawText: params.rawText,
      previousExcerpt: document.rawText ? excerpt(document.rawText) : null,
      nextExcerpt: excerpt(params.rawText),
      metadata: {
        action: 'rewriteDocumentAndKnowledge',
      },
    },
  });

  await prisma.document.update({
    where: { id: params.documentId },
    data: { rawText: params.rawText, parseStatus: 'PROCESSING', parseError: null },
  });

  const [supersededRules, supersededQAPairs] = await Promise.all([
    prisma.rule.updateMany({
      where: { documentId: params.documentId, status: 'ACTIVE' },
      data: { status: 'SUPERSEDED' },
    }),
    prisma.qAPair.updateMany({
      where: { documentId: params.documentId, status: 'ACTIVE' },
      data: { status: 'SUPERSEDED' },
    }),
  ]);

  const chunksCreated = await rebuildDocumentChunks(params.documentId, params.rawText);

  const existingCodes = await getExistingRuleCodes();
  const extraction = await extractKnowledge(params.rawText, existingCodes);
  const createdRules = await saveExtractedRules(params.documentId, extraction.rules, domainIds);
  const ruleCodeToId = new Map(createdRules.map((rule) => [rule.ruleCode, rule.id]));
  await saveExtractedQAs(params.documentId, extraction.qaPairs, ruleCodeToId, domainIds);

  await prisma.document.update({
    where: { id: params.documentId },
    data: { parseStatus: 'COMPLETED', parseError: null },
  });

  await prisma.processingAttempt.create({
    data: {
      documentId: params.documentId,
      status: 'SUCCESS',
      completedAt: new Date(),
      errorMessage: `Document edited via Mini App by ${params.editedBy ?? 'unknown'}; knowledge rebuilt`,
    },
  }).catch(() => undefined);

  return {
    chunksCreated,
    rulesCreated: createdRules.length,
    qaPairsCreated: extraction.qaPairs.length,
    supersededRules: supersededRules.count,
    supersededQAPairs: supersededQAPairs.count,
    revisionId: revision.id,
  };
}

export async function rollbackDocumentToRevision(params: {
  revisionId: string;
  editedBy?: string | null;
}): Promise<DocumentRollbackResult> {
  const revision = await prisma.documentRevision.findUnique({
    where: { id: params.revisionId },
    include: { document: { select: { id: true, rawText: true } } },
  });

  if (!revision) throw new Error('Ревизия документа не найдена');
  if (revision.previousRawText === null || revision.previousRawText === undefined) {
    throw new Error('В ревизии нет текста для отката');
  }

  const rollbackRevision = await prisma.documentRevision.create({
    data: {
      documentId: revision.documentId,
      source: 'REVISION_ROLLBACK',
      actor: params.editedBy ?? null,
      previousRawText: revision.document.rawText ?? null,
      nextRawText: revision.previousRawText,
      previousExcerpt: revision.document.rawText ? excerpt(revision.document.rawText) : null,
      nextExcerpt: excerpt(revision.previousRawText),
      metadata: {
        restoredFromRevisionId: revision.id,
        restoredFromSource: revision.source,
        restoredRuleId: revision.ruleId,
      },
    },
  });

  await prisma.document.update({
    where: { id: revision.documentId },
    data: { rawText: revision.previousRawText, parseStatus: 'COMPLETED', parseError: null },
  });

  const chunksCreated = await rebuildDocumentChunks(revision.documentId, revision.previousRawText);

  return {
    documentId: revision.documentId,
    restoredFromRevisionId: revision.id,
    rollbackRevisionId: rollbackRevision.id,
    chunksCreated,
  };
}
