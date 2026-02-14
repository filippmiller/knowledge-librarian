import { downloadFile, sendMessage, sendTypingIndicator, sendUploadingIndicator } from './telegram-api';
import type { TelegramMessage } from './telegram-api';
import type { TelegramUserInfo } from './access-control';
import { parseDocument, detectMimeType } from '@/lib/document-parser';
import { createChatCompletion, normalizeJsonResponse } from '@/lib/ai/chat-provider';
import { generateEmbeddings } from '@/lib/openai';
import prisma from '@/lib/db';

interface DomainClassResult {
  documentDomains: {
    primaryDomainSlug: string;
    secondaryDomainSlugs: string[];
    confidence: number;
  }[];
}

interface KnowledgeExtractResult {
  rules: {
    ruleCode: string;
    title: string;
    body: string;
    confidence: number;
    sourceSpan: { quote: string; locationHint: string };
  }[];
  qaPairs: {
    question: string;
    answer: string;
    linkedRuleCode: string | null;
  }[];
}

/**
 * Handle document uploads from admins.
 * Downloads the file, parses it, runs the 3-phase pipeline, and saves to DB.
 */
export async function handleDocumentUpload(
  message: TelegramMessage,
  user: TelegramUserInfo
): Promise<void> {
  const chatId = message.chat.id;

  if (!message.document) return;

  const fileName = message.document.file_name || 'unknown';
  const fileSizeMB = (message.document.file_size || 0) / (1024 * 1024);

  // Telegram bot API limits file downloads to 20MB
  if (fileSizeMB > 20) {
    await sendMessage(chatId, `Файл слишком большой (${fileSizeMB.toFixed(1)} МБ). Максимум 20 МБ.`);
    return;
  }

  // Check supported file types
  const mimeType = message.document.mime_type || detectMimeType(fileName);
  const supportedTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/plain',
  ];

  if (!supportedTypes.includes(mimeType) && !fileName.match(/\.(pdf|docx?|txt|md)$/i)) {
    await sendMessage(chatId, `Неподдерживаемый формат файла: ${mimeType}\n\nПоддерживаются: PDF, DOCX, DOC, TXT`);
    return;
  }

  await sendUploadingIndicator(chatId);
  await sendMessage(chatId, `Обрабатываю документ "${fileName}"...\n\nЭто может занять 1-3 минуты.`);

  try {
    // Step 1: Download file
    const { buffer } = await downloadFile(message.document.file_id);

    // Step 2: Parse document text
    const rawText = await parseDocument(buffer, mimeType, fileName);

    if (!rawText || rawText.trim().length < 20) {
      await sendMessage(chatId, 'Не удалось извлечь текст из документа, или документ слишком короткий.');
      return;
    }

    // Step 3: Create document record
    const document = await prisma.document.create({
      data: {
        title: message.caption || fileName.replace(/\.[^.]+$/, ''),
        filename: fileName,
        mimeType,
        rawText,
        rawBytes: buffer,
        parseStatus: 'PROCESSING',
      },
    });

    await sendTypingIndicator(chatId);

    // Phase 1: Domain classification (non-streaming)
    await sendMessage(chatId, 'Фаза 1/3: Классификация домена...');
    const domainIds = await classifyDomains(rawText, document.id);

    // Phase 2: Knowledge extraction (non-streaming)
    await sendTypingIndicator(chatId);
    await sendMessage(chatId, 'Фаза 2/3: Извлечение знаний...');
    const { rulesCreated, qaPairsCreated, ruleCodeToId } = await extractKnowledge(rawText, document.id, domainIds);

    // Phase 3: Chunking + embeddings
    await sendTypingIndicator(chatId);
    await sendMessage(chatId, 'Фаза 3/3: Индексация для поиска...');
    const chunksCreated = await createChunks(rawText, document.id, domainIds);

    // Mark document as completed
    await prisma.document.update({
      where: { id: document.id },
      data: { parseStatus: 'COMPLETED' },
    });

    // Send summary
    const summary = [
      `Документ "${fileName}" обработан!`,
      '',
      `Правил создано: ${rulesCreated}`,
      `Пар вопрос-ответ: ${qaPairsCreated}`,
      `Фрагментов для поиска: ${chunksCreated}`,
      `Доменов привязано: ${domainIds.length}`,
    ].join('\n');

    await sendMessage(chatId, summary);
  } catch (error) {
    console.error('[document-handler] Error:', error);

    const errorMsg = error instanceof Error ? error.message : String(error);
    await sendMessage(
      chatId,
      `Ошибка при обработке документа "${fileName}":\n${errorMsg.slice(0, 300)}\n\nПопробуйте загрузить снова или через веб-интерфейс.`
    );
  }
}

async function classifyDomains(rawText: string, documentId: string): Promise<string[]> {
  const existingDomains = await prisma.domain.findMany({
    select: { id: true, slug: true, title: true, description: true },
  });

  const domainList = existingDomains
    .map((d) => `- ${d.slug}: ${d.title}`)
    .join('\n');

  const response = await createChatCompletion({
    messages: [
      {
        role: 'system',
        content: `Ты - классификатор доменов. Определи домены для документа.

Доступные домены:
${domainList}

Ответь JSON:
{
  "documentDomains": [{
    "primaryDomainSlug": "slug",
    "secondaryDomainSlugs": ["slug"],
    "confidence": 0.8
  }]
}`,
      },
      { role: 'user', content: rawText.slice(0, 4000) },
    ],
    responseFormat: 'json_object',
    temperature: 0.3,
    maxTokens: 1024,
  });

  let result: DomainClassResult;
  try {
    result = JSON.parse(response);
  } catch {
    // Fallback to general_ops
    const fallback = existingDomains.find((d) => d.slug === 'general_ops');
    return fallback ? [fallback.id] : [];
  }

  const domainIds: string[] = [];

  for (const assignment of (result.documentDomains || [])) {
    const primary = existingDomains.find((d) => d.slug === assignment.primaryDomainSlug);
    if (primary) {
      await prisma.documentDomain.upsert({
        where: { documentId_domainId: { documentId, domainId: primary.id } },
        update: { isPrimary: true, confidence: assignment.confidence },
        create: { documentId, domainId: primary.id, isPrimary: true, confidence: assignment.confidence },
      });
      domainIds.push(primary.id);
    }

    for (const slug of (assignment.secondaryDomainSlugs || [])) {
      const secondary = existingDomains.find((d) => d.slug === slug);
      if (secondary && !domainIds.includes(secondary.id)) {
        await prisma.documentDomain.upsert({
          where: { documentId_domainId: { documentId, domainId: secondary.id } },
          update: { confidence: assignment.confidence * 0.8 },
          create: { documentId, domainId: secondary.id, confidence: assignment.confidence * 0.8 },
        });
        domainIds.push(secondary.id);
      }
    }
  }

  return [...new Set(domainIds)];
}

async function extractKnowledge(
  rawText: string,
  documentId: string,
  domainIds: string[]
): Promise<{ rulesCreated: number; qaPairsCreated: number; ruleCodeToId: Map<string, string> }> {
  // Get existing rule codes
  const existingRules = await prisma.rule.findMany({
    where: { status: 'ACTIVE' },
    select: { ruleCode: true },
  });
  const startCode = existingRules.length > 0
    ? Math.max(...existingRules.map((r) => parseInt(r.ruleCode.replace('R-', '')))) + 1
    : 1;

  const response = await createChatCompletion({
    messages: [
      {
        role: 'system',
        content: `Ты - экстрактор знаний для бюро переводов. Извлеки правила и QA пары.
Начинай нумерацию с R-${startCode}. ВСЕ тексты на РУССКОМ.

Ответь JSON:
{
  "rules": [{ "ruleCode": "R-${startCode}", "title": "...", "body": "...", "confidence": 0.8, "sourceSpan": { "quote": "...", "locationHint": "..." } }],
  "qaPairs": [{ "question": "...", "answer": "...", "linkedRuleCode": "R-X или null" }]
}`,
      },
      { role: 'user', content: rawText.slice(0, 8000) },
    ],
    responseFormat: 'json_object',
    temperature: 0.2,
    maxTokens: 4096,
  });

  let result: KnowledgeExtractResult;
  try {
    result = JSON.parse(response);
  } catch {
    return { rulesCreated: 0, qaPairsCreated: 0, ruleCodeToId: new Map() };
  }

  const ruleCodeToId = new Map<string, string>();
  let rulesCreated = 0;

  for (const rule of (result.rules || [])) {
    const created = await prisma.rule.create({
      data: {
        documentId,
        ruleCode: rule.ruleCode,
        title: rule.title,
        body: rule.body,
        confidence: rule.confidence,
        sourceSpan: rule.sourceSpan,
      },
    });

    ruleCodeToId.set(rule.ruleCode, created.id);

    for (const domainId of domainIds) {
      await prisma.ruleDomain.upsert({
        where: { ruleId_domainId: { ruleId: created.id, domainId } },
        update: { confidence: rule.confidence },
        create: { ruleId: created.id, domainId, confidence: rule.confidence },
      });
    }
    rulesCreated++;
  }

  let qaPairsCreated = 0;
  for (const qa of (result.qaPairs || [])) {
    const ruleId = qa.linkedRuleCode ? ruleCodeToId.get(qa.linkedRuleCode) : null;

    const created = await prisma.qAPair.create({
      data: {
        documentId,
        ruleId: ruleId || null,
        question: qa.question,
        answer: qa.answer,
      },
    });

    for (const domainId of domainIds) {
      await prisma.qADomain.upsert({
        where: { qaId_domainId: { qaId: created.id, domainId } },
        update: {},
        create: { qaId: created.id, domainId },
      });
    }
    qaPairsCreated++;
  }

  return { rulesCreated, qaPairsCreated, ruleCodeToId };
}

async function createChunks(rawText: string, documentId: string, domainIds: string[]): Promise<number> {
  const { splitTextIntoChunks } = await import('@/lib/ai/chunker');

  const chunks = splitTextIntoChunks(rawText);
  let created = 0;

  // Process in small batches to conserve memory
  const BATCH_SIZE = 3;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const embeddings = await generateEmbeddings(batch.map((c) => c.content));

    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const embedding = embeddings[j];

      const createdChunk = await prisma.docChunk.create({
        data: {
          documentId,
          chunkIndex: chunk.index,
          content: chunk.content,
          embedding,
          metadata: chunk.metadata,
        },
      });

      for (const domainId of domainIds) {
        await prisma.chunkDomain.create({
          data: { chunkId: createdChunk.id, domainId },
        });
      }
      created++;
    }
  }

  return created;
}
