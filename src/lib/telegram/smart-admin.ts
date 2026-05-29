import { createChatCompletion } from '@/lib/ai/chat-provider';
import { sendMessage, sendTypingIndicator } from './telegram-api';
import type { TelegramUserInfo } from './access-control';
import { addKnowledge } from './knowledge-manager';
import prisma from '@/lib/db';

// ============================================
// TYPES
// ============================================

export type AdminIntent =
  | 'add_rule'
  | 'delete_rule'
  | 'delete_document'
  | 'confirm_rule'
  | 'confirm_all_doc'
  | 'search_rules'
  | 'list_documents'
  | 'show_stats'
  | 'question';

interface ClassifiedIntent {
  intent: AdminIntent;
  confidence: number;
  params: Record<string, string>;
}

interface PendingConfirmation {
  intent: AdminIntent;
  params: Record<string, string>;
  preview: string;
  createdAt: number;
  chatId: number;
}

// In-memory pending confirmations: chatId -> PendingConfirmation
const pendingConfirmations = new Map<number, PendingConfirmation>();

const CONFIRMATION_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ============================================
// INTENT CLASSIFIER
// ============================================

const CLASSIFIER_PROMPT = `Ты классификатор намерений администратора базы знаний бюро переводов.

Определи намерение из текста администратора. Возможные намерения:

- add_rule — добавить новое знание/правило (пример: "сохрани правило...", "добавь знание...", "запомни что...")
  params: { text: "текст знания для сохранения" }

- delete_rule — удалить конкретное правило (пример: "Удали правило R-42", "убери R-5")
  params: { ruleCode: "R-42" }

- delete_document — удалить документ и все его правила (пример: "Удали документ 'Инструкция'")
  params: { docQuery: "Инструкция" }

- confirm_rule — подтвердить правило (пример: "Подтверди R-24", "окей R-10")
  params: { ruleCode: "R-24" }

- confirm_all_doc — подтвердить все правила из документа (пример: "Подтверди все правила из документа X")
  params: { docQuery: "X" }

- search_rules — поиск правил по теме (пример: "Покажи правила про апостиль", "найди правила о ценах")
  params: { query: "апостиль" }

- list_documents — список документов (пример: "Какие документы загружены?", "список документов")
  params: {}

- show_stats — статистика (пример: "Сколько правил?", "статистика по домену notary")
  params: { domain: "notary" } или {}

- question — обычный вопрос для поиска ответа в базе знаний (по умолчанию)
  params: {}

ПРАВИЛА:
- Если текст содержит R-\\d+ и действие (удали, подтверди, покажи) — это НЕ question
- Если неясно — используй "question" с низкой confidence
- ruleCode всегда в формате R-\\d+ (uppercase)
- Уверенность 0.0-1.0

Ответь JSON:
{
  "intent": "...",
  "confidence": 0.95,
  "params": { ... }
}`;

export async function classifyAdminIntent(text: string): Promise<ClassifiedIntent> {
  try {
    const response = await createChatCompletion({
      messages: [
        { role: 'system', content: CLASSIFIER_PROMPT },
        { role: 'user', content: text },
      ],
      responseFormat: 'json_object',
      temperature: 0.1,
      maxTokens: 256,
    });

    const parsed = JSON.parse(response) as ClassifiedIntent;

    // Validate
    const validIntents: AdminIntent[] = [
      'add_rule', 'delete_rule', 'delete_document', 'confirm_rule', 'confirm_all_doc',
      'search_rules', 'list_documents', 'show_stats', 'question',
    ];
    if (!validIntents.includes(parsed.intent)) {
      return { intent: 'question', confidence: 0, params: {} };
    }

    return {
      intent: parsed.intent,
      confidence: parsed.confidence ?? 0.5,
      params: parsed.params ?? {},
    };
  } catch (error) {
    console.error('[smart-admin] Classification failed:', error);
    return { intent: 'question', confidence: 0, params: {} };
  }
}

// ============================================
// CONFIRMATION FLOW
// ============================================

export function hasPendingConfirmation(chatId: number): boolean {
  const pending = pendingConfirmations.get(chatId);
  if (!pending) return false;

  // Check TTL
  if (Date.now() - pending.createdAt > CONFIRMATION_TTL_MS) {
    pendingConfirmations.delete(chatId);
    return false;
  }
  return true;
}

export async function handleConfirmationResponse(chatId: number, text: string, user: TelegramUserInfo): Promise<void> {
  const pending = pendingConfirmations.get(chatId);
  if (!pending) {
    await sendMessage(chatId, 'Нет ожидающих подтверждений.');
    return;
  }

  pendingConfirmations.delete(chatId);

  const normalized = text.toLowerCase().trim();
  const isYes = ['да', 'yes', 'ок', 'ok', 'подтверждаю', 'удали', 'удаляй'].includes(normalized);

  if (!isYes) {
    await sendMessage(chatId, 'Операция отменена.');
    return;
  }

  // Execute the confirmed action
  try {
    switch (pending.intent) {
      case 'delete_rule':
        await executeDeleteRule(chatId, pending.params.ruleCode, user);
        break;
      case 'delete_document':
        await executeDeleteDocument(chatId, pending.params.docId, user);
        break;
      default:
        await sendMessage(chatId, 'Неизвестная операция.');
    }
  } catch (error) {
    console.error('[smart-admin] Confirmed action failed:', error);
    await sendMessage(chatId, 'Ошибка при выполнении операции.');
  }
}

async function requestConfirmation(
  chatId: number,
  intent: AdminIntent,
  params: Record<string, string>,
  preview: string
): Promise<void> {
  pendingConfirmations.set(chatId, {
    intent,
    params,
    preview,
    createdAt: Date.now(),
    chatId,
  });

  await sendMessage(chatId, `${preview}\n\nПодтвердите: да / нет`);
}

// ============================================
// ACTION ROUTER
// ============================================

export async function handleSmartAdminAction(
  chatId: number,
  intent: ClassifiedIntent,
  user: TelegramUserInfo
): Promise<void> {
  switch (intent.intent) {
    case 'add_rule':
      await executeAddRule(chatId, intent.params.text, user);
      break;

    case 'confirm_rule':
      await executeConfirmRule(chatId, intent.params.ruleCode);
      break;

    case 'confirm_all_doc':
      await executeConfirmAllDocRules(chatId, intent.params.docQuery);
      break;

    case 'search_rules':
      await executeSearchRules(chatId, intent.params.query);
      break;

    case 'list_documents':
      await executeListDocuments(chatId);
      break;

    case 'show_stats':
      await executeShowStats(chatId, intent.params.domain);
      break;

    case 'delete_rule':
      await prepareDeleteRule(chatId, intent.params.ruleCode);
      break;

    case 'delete_document':
      await prepareDeleteDocument(chatId, intent.params.docQuery);
      break;

    default:
      await sendMessage(chatId, 'Не удалось определить действие.');
  }
}

// ============================================
// SAFE EXECUTORS (no confirmation needed)
// ============================================

async function executeAddRule(chatId: number, text: string, user: TelegramUserInfo): Promise<void> {
  if (!text) {
    await sendMessage(chatId, 'Не указан текст для сохранения.');
    return;
  }

  await sendTypingIndicator(chatId);
  try {
    const result = await addKnowledge(text, user.telegramId);
    await sendMessage(chatId, result.summary);
  } catch (error) {
    console.error('[smart-admin] addKnowledge failed:', error);
    await sendMessage(chatId, 'Ошибка при сохранении знания.');
  }
}

async function executeConfirmRule(chatId: number, ruleCode: string): Promise<void> {
  if (!ruleCode) {
    await sendMessage(chatId, 'Не указан код правила.');
    return;
  }

  const code = ruleCode.toUpperCase();
  const rule = await prisma.rule.findFirst({
    where: { ruleCode: code, status: 'ACTIVE' },
  });

  if (!rule) {
    await sendMessage(chatId, `Правило ${code} не найдено.`);
    return;
  }

  if (rule.confidence >= 1.0) {
    await sendMessage(chatId, `Правило ${code} уже подтверждено (100%).`);
    return;
  }

  await prisma.rule.update({
    where: { id: rule.id },
    data: { confidence: 1.0 },
  });

  await sendMessage(chatId, `Правило ${code} подтверждено (100%).\n\n${rule.title}`);
}

async function executeConfirmAllDocRules(chatId: number, docQuery: string): Promise<void> {
  if (!docQuery) {
    await sendMessage(chatId, 'Не указан документ.');
    return;
  }

  const doc = await prisma.document.findFirst({
    where: {
      title: { contains: docQuery, mode: 'insensitive' },
      parseStatus: 'COMPLETED',
    },
    select: { id: true, title: true },
  });

  if (!doc) {
    await sendMessage(chatId, `Документ "${docQuery}" не найден.`);
    return;
  }

  const result = await prisma.rule.updateMany({
    where: { documentId: doc.id, status: 'ACTIVE', confidence: { lt: 1.0 } },
    data: { confidence: 1.0 },
  });

  await sendMessage(chatId, `Подтверждено ${result.count} правил из документа "${doc.title}".`);
}

async function executeSearchRules(chatId: number, query: string): Promise<void> {
  if (!query) {
    await sendMessage(chatId, 'Не указан поисковый запрос.');
    return;
  }

  const rules = await prisma.rule.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { ruleCode: { contains: query, mode: 'insensitive' } },
        { title: { contains: query, mode: 'insensitive' } },
        { body: { contains: query, mode: 'insensitive' } },
      ],
    },
    select: { ruleCode: true, title: true, confidence: true },
    take: 15,
    orderBy: { createdAt: 'desc' },
  });

  if (rules.length === 0) {
    await sendMessage(chatId, `Правила по запросу "${query}" не найдены.`);
    return;
  }

  let text = `Найдено ${rules.length} правил по "${query}":\n\n`;
  for (const r of rules) {
    const conf = r.confidence >= 1.0 ? '' : ` (${(r.confidence * 100).toFixed(0)}%)`;
    text += `${r.ruleCode} - ${r.title}${conf}\n`;
  }
  await sendMessage(chatId, text);
}

async function executeListDocuments(chatId: number): Promise<void> {
  const docs = await prisma.document.findMany({
    where: { parseStatus: 'COMPLETED' },
    select: {
      id: true,
      title: true,
      uploadedAt: true,
      _count: { select: { rules: { where: { status: 'ACTIVE' } } } },
    },
    orderBy: { uploadedAt: 'desc' },
  });

  if (docs.length === 0) {
    await sendMessage(chatId, 'Нет обработанных документов.');
    return;
  }

  let text = `Документы (${docs.length}):\n\n`;
  for (const doc of docs) {
    const date = doc.uploadedAt.toISOString().slice(0, 10);
    text += `${doc.title} — ${doc._count.rules} правил (${date})\n`;
  }
  await sendMessage(chatId, text);
}

async function executeShowStats(chatId: number, domain?: string): Promise<void> {
  if (domain) {
    const domainObj = await prisma.domain.findFirst({
      where: { slug: { contains: domain, mode: 'insensitive' } },
      select: { id: true, slug: true, title: true },
    });

    if (!domainObj) {
      await sendMessage(chatId, `Домен "${domain}" не найден.`);
      return;
    }

    const ruleCount = await prisma.ruleDomain.count({ where: { domainId: domainObj.id } });
    const qaCount = await prisma.qADomain.count({ where: { domainId: domainObj.id } });
    const chunkCount = await prisma.chunkDomain.count({ where: { domainId: domainObj.id } });

    await sendMessage(chatId,
      `Статистика домена "${domainObj.title}" (${domainObj.slug}):\n\n` +
      `Правил: ${ruleCount}\n` +
      `QA пар: ${qaCount}\n` +
      `Чанков: ${chunkCount}`
    );
    return;
  }

  // Global stats
  const [ruleCount, qaCount, chunkCount, docCount] = await Promise.all([
    prisma.rule.count({ where: { status: 'ACTIVE' } }),
    prisma.qAPair.count({ where: { status: 'ACTIVE' } }),
    prisma.docChunk.count(),
    prisma.document.count({ where: { parseStatus: 'COMPLETED' } }),
  ]);

  const confirmedRules = await prisma.rule.count({
    where: { status: 'ACTIVE', confidence: { gte: 1.0 } },
  });

  await sendMessage(chatId,
    `Статистика базы знаний:\n\n` +
    `Документов: ${docCount}\n` +
    `Правил: ${ruleCount} (подтверждено: ${confirmedRules})\n` +
    `QA пар: ${qaCount}\n` +
    `Чанков: ${chunkCount}`
  );
}

// ============================================
// DESTRUCTIVE EXECUTORS (with confirmation)
// ============================================

async function prepareDeleteRule(chatId: number, ruleCode: string): Promise<void> {
  if (!ruleCode) {
    await sendMessage(chatId, 'Не указан код правила.');
    return;
  }

  const code = ruleCode.toUpperCase();
  const rule = await prisma.rule.findFirst({
    where: { ruleCode: code, status: 'ACTIVE' },
    include: {
      _count: { select: { qaPairs: { where: { status: 'ACTIVE' } } } },
    },
  });

  if (!rule) {
    await sendMessage(chatId, `Правило ${code} не найдено.`);
    return;
  }

  const preview =
    `Удаление правила ${code}:\n\n` +
    `${rule.title}\n` +
    `QA пар: ${rule._count.qaPairs}\n` +
    `Уверенность: ${(rule.confidence * 100).toFixed(0)}%`;

  await requestConfirmation(chatId, 'delete_rule', { ruleCode: code }, preview);
}

async function prepareDeleteDocument(chatId: number, docQuery: string): Promise<void> {
  if (!docQuery) {
    await sendMessage(chatId, 'Не указан документ.');
    return;
  }

  const doc = await prisma.document.findFirst({
    where: {
      title: { contains: docQuery, mode: 'insensitive' },
    },
    include: {
      _count: {
        select: {
          rules: { where: { status: 'ACTIVE' } },
          qaPairs: { where: { status: 'ACTIVE' } },
          chunks: true,
        },
      },
    },
  });

  if (!doc) {
    await sendMessage(chatId, `Документ "${docQuery}" не найден.`);
    return;
  }

  const preview =
    `Удаление документа "${doc.title}":\n\n` +
    `Правил: ${doc._count.rules}\n` +
    `QA пар: ${doc._count.qaPairs}\n` +
    `Чанков: ${doc._count.chunks}\n\n` +
    `ВСЕ связанные данные будут удалены!`;

  await requestConfirmation(chatId, 'delete_document', { docId: doc.id, docTitle: doc.title }, preview);
}

async function executeDeleteRule(chatId: number, ruleCode: string, user: TelegramUserInfo): Promise<void> {
  const code = ruleCode.toUpperCase();

  const rule = await prisma.rule.findFirst({
    where: { ruleCode: code, status: 'ACTIVE' },
  });

  if (!rule) {
    await sendMessage(chatId, `Правило ${code} уже удалено или не найдено.`);
    return;
  }

  // Transaction: deprecate rule + deprecate QA pairs
  await prisma.$transaction(async (tx) => {
    await tx.rule.update({
      where: { id: rule.id },
      data: {
        status: 'DEPRECATED',
        sourceSpan: {
          ...(typeof rule.sourceSpan === 'object' && rule.sourceSpan !== null ? rule.sourceSpan : {}),
          deletedBy: user.telegramId,
          deletedAt: new Date().toISOString(),
        },
      },
    });

    await tx.qAPair.updateMany({
      where: { ruleId: rule.id, status: 'ACTIVE' },
      data: { status: 'DEPRECATED' },
    });
  });

  await sendMessage(chatId, `Правило ${code} удалено (DEPRECATED).\n\n${rule.title}`);
}

async function executeDeleteDocument(chatId: number, docId: string, user: TelegramUserInfo): Promise<void> {
  const doc = await prisma.document.findUnique({
    where: { id: docId },
    select: { id: true, title: true },
  });

  if (!doc) {
    await sendMessage(chatId, 'Документ не найден.');
    return;
  }

  // Transaction: deprecate all rules, QA pairs, delete chunks
  const result = await prisma.$transaction(async (tx) => {
    const rules = await tx.rule.updateMany({
      where: { documentId: doc.id, status: 'ACTIVE' },
      data: { status: 'DEPRECATED' },
    });

    const qaPairs = await tx.qAPair.updateMany({
      where: { documentId: doc.id, status: 'ACTIVE' },
      data: { status: 'DEPRECATED' },
    });

    // Delete chunks and their domain links (cascade handles chunkDomain)
    const chunks = await tx.docChunk.deleteMany({
      where: { documentId: doc.id },
    });

    // Mark document as failed/removed
    await tx.document.update({
      where: { id: doc.id },
      data: { parseStatus: 'FAILED', parseError: `Удалён через Telegram (${user.telegramId})` },
    });

    return { rules: rules.count, qaPairs: qaPairs.count, chunks: chunks.count };
  });

  await sendMessage(chatId,
    `Документ "${doc.title}" удалён.\n\n` +
    `Правил: ${result.rules}\n` +
    `QA пар: ${result.qaPairs}\n` +
    `Чанков: ${result.chunks}`
  );
}
