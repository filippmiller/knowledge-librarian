import { Prisma } from '@prisma/client';
import prisma from '@/lib/db';
import { syncRuleEditToDocument } from '@/lib/knowledge/document-sync';

type SafeRuleEditResult = {
  ok: boolean;
  ruleCode?: string;
  title?: string;
  body?: string;
  documentId?: string | null;
  documentTitle?: string | null;
  revisionId?: string;
  chunksCreated?: number;
  reason?: string;
  summary: string;
};

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export async function safelyEditTelegramRule(params: {
  ruleCode: string;
  newBody: string;
  newTitle?: string | null;
  editedByTelegramId: string;
  editSource: 'telegram_command' | 'telegram_voice' | 'telegram_corrector';
}): Promise<SafeRuleEditResult> {
  const code = params.ruleCode.toUpperCase();
  const existing = await prisma.rule.findFirst({
    where: { ruleCode: code, status: 'ACTIVE' },
    include: {
      document: { select: { id: true, title: true, rawText: true } },
      qaPairs: { where: { status: 'ACTIVE' }, select: { id: true, answer: true } },
    },
  });

  if (!existing) {
    return { ok: false, summary: `Правило ${code} не найдено или не активно`, reason: 'RULE_NOT_FOUND' };
  }

  if (!existing.documentId || !existing.document?.rawText) {
    return {
      ok: false,
      ruleCode: existing.ruleCode,
      documentId: existing.documentId,
      summary:
        `Правило ${existing.ruleCode} нельзя менять через бота: оно не привязано к исходному документу. ` +
        'Откройте правило в Mini App и привяжите/исправьте источник, иначе ревизия документа не будет создана.',
      reason: 'NO_LINKED_DOCUMENT',
    };
  }

  const previous = {
    title: existing.title,
    body: existing.body,
    confidence: existing.confidence,
    sourceSpan: existing.sourceSpan,
    qaAnswers: existing.qaPairs.map((qa) => ({ id: qa.id, answer: qa.answer })),
  };

  const newTitle = params.newTitle?.trim() || existing.title;
  const newBody = params.newBody.trim();
  if (newBody.length < 10) {
    return { ok: false, ruleCode: existing.ruleCode, summary: 'Новый текст правила слишком короткий', reason: 'BODY_TOO_SHORT' };
  }

  await prisma.rule.update({
    where: { id: existing.id },
    data: {
      title: newTitle,
      body: newBody,
      confidence: 1,
      sourceSpan: {
        ...asObject(existing.sourceSpan),
        editedVia: params.editSource,
        editedBy: params.editedByTelegramId,
        editedAt: new Date().toISOString(),
      },
    },
  });

  await prisma.qAPair.updateMany({
    where: { ruleId: existing.id, status: 'ACTIVE' },
    data: {
      answer: newBody,
      documentId: existing.documentId,
      scenarioKey: existing.scenarioKey,
    },
  });

  const syncResult = await syncRuleEditToDocument({
    ruleId: existing.id,
    newBody,
    previousBody: existing.body,
    editedBy: params.editedByTelegramId,
  });

  if (!syncResult.updated || !syncResult.revisionId) {
    await prisma.rule.update({
      where: { id: existing.id },
      data: {
        title: previous.title,
        body: previous.body,
        confidence: previous.confidence,
        sourceSpan: previous.sourceSpan === null ? Prisma.JsonNull : previous.sourceSpan,
      },
    });

    for (const qa of previous.qaAnswers) {
      await prisma.qAPair.update({
        where: { id: qa.id },
        data: { answer: qa.answer },
      });
    }

    return {
      ok: false,
      ruleCode: existing.ruleCode,
      documentId: existing.documentId,
      documentTitle: existing.document.title,
      reason: syncResult.reason ?? 'DOCUMENT_SYNC_FAILED',
      summary:
        `Правило ${existing.ruleCode} не изменено: не удалось обновить исходный документ ` +
        `(${syncResult.reason ?? 'синхронизация не сработала'}). Правка отменена.`,
    };
  }

  return {
    ok: true,
    ruleCode: existing.ruleCode,
    title: newTitle,
    body: newBody,
    documentId: existing.documentId,
    documentTitle: existing.document.title,
    revisionId: syncResult.revisionId,
    chunksCreated: syncResult.chunksCreated,
    summary:
      `Правило ${existing.ruleCode} обновлено. Документ "${existing.document.title}" синхронизирован, ` +
      `создана ревизия ${syncResult.revisionId}, пересобрано чанков: ${syncResult.chunksCreated ?? 0}.`,
  };
}
