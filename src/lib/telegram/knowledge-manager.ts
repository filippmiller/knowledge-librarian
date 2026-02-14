import { createChatCompletion } from '@/lib/ai/chat-provider';
import { generateEmbeddings } from '@/lib/openai';
import prisma from '@/lib/db';

interface ParsedKnowledge {
  rules: {
    title: string;
    body: string;
  }[];
  qaPairs: {
    question: string;
    answer: string;
  }[];
}

const KNOWLEDGE_PARSER_PROMPT = `Ты - парсер знаний для бюро переводов "Аврора".

Из текста администратора извлеки структурированные знания:

1. ПРАВИЛА (rules): Если текст содержит факт, цену, процедуру или правило - оформи как бизнес-правило.
   - title: краткое название (до 10 слов)
   - body: полное описание правила

2. ВОПРОСЫ И ОТВЕТЫ (qaPairs): Для каждого правила создай 1-2 естественных вопроса, которые может задать сотрудник.
   - question: вопрос на русском языке
   - answer: ответ на основе правила

ПРАВИЛА:
- Извлекай ТОЛЬКО то, что явно указано в тексте
- НЕ додумывай и не дополняй информацию
- Все тексты на РУССКОМ языке
- Если текст слишком короткий или неинформативный - верни пустые массивы

Ответь в формате JSON:
{
  "rules": [{ "title": "...", "body": "..." }],
  "qaPairs": [{ "question": "...", "answer": "..." }]
}`;

const KNOWLEDGE_CORRECTOR_PROMPT = `Ты - корректор знаний для бюро переводов "Аврора".

Администратор хочет исправить/обновить существующие знания.

Существующие правила:
{EXISTING_RULES}

Текст от администратора:
{ADMIN_TEXT}

Определи, какие существующие правила нужно обновить или какие новые правила создать.

Ответь в формате JSON:
{
  "updates": [
    {
      "existingRuleCode": "R-X или null если новое",
      "title": "новое название",
      "body": "новое описание"
    }
  ],
  "newQaPairs": [
    { "question": "...", "answer": "..." }
  ]
}`;

/**
 * Parse admin text into rules and QA pairs using AI, then save to DB.
 */
export async function addKnowledge(
  text: string,
  addedByTelegramId: string
): Promise<{ rulesCreated: number; qaPairsCreated: number; summary: string }> {
  // Step 1: Parse text with AI
  const response = await createChatCompletion({
    messages: [
      { role: 'system', content: KNOWLEDGE_PARSER_PROMPT },
      { role: 'user', content: text },
    ],
    responseFormat: 'json_object',
    temperature: 0.2,
  });

  let parsed: ParsedKnowledge;
  try {
    parsed = JSON.parse(response);
  } catch {
    return { rulesCreated: 0, qaPairsCreated: 0, summary: 'Не удалось распарсить ответ AI' };
  }

  if (!parsed.rules?.length && !parsed.qaPairs?.length) {
    return { rulesCreated: 0, qaPairsCreated: 0, summary: 'AI не нашёл знаний в тексте' };
  }

  // Step 2: Get next rule code
  const nextRuleCode = await getNextRuleCode();

  // Step 3: Auto-classify domain
  const domainIds = await classifyDomainForText(text);

  // Step 4: Save rules
  let rulesCreated = 0;
  const ruleIds: string[] = [];
  for (let i = 0; i < (parsed.rules?.length || 0); i++) {
    const rule = parsed.rules[i];
    const ruleCode = `R-${nextRuleCode + i}`;

    const created = await prisma.rule.create({
      data: {
        ruleCode,
        title: rule.title,
        body: rule.body,
        confidence: 0.9,
        sourceSpan: { quote: text.slice(0, 200), locationHint: `Добавлено через Telegram (${addedByTelegramId})` },
      },
    });

    ruleIds.push(created.id);

    // Link to domains
    for (const domainId of domainIds) {
      await prisma.ruleDomain.create({
        data: { ruleId: created.id, domainId, confidence: 0.9 },
      });
    }

    rulesCreated++;
  }

  // Step 5: Save QA pairs
  let qaPairsCreated = 0;
  for (const qa of (parsed.qaPairs || [])) {
    const created = await prisma.qAPair.create({
      data: {
        ruleId: ruleIds.length > 0 ? ruleIds[0] : null,
        question: qa.question,
        answer: qa.answer,
      },
    });

    // Link to domains
    for (const domainId of domainIds) {
      await prisma.qADomain.create({
        data: { qaId: created.id, domainId },
      });
    }

    qaPairsCreated++;
  }

  // Step 6: Create chunk with embedding for the original text
  await createKnowledgeChunk(text, domainIds);

  // Step 7: Build summary
  const parts: string[] = [];
  if (rulesCreated > 0) {
    const codes = Array.from({ length: rulesCreated }, (_, i) => `R-${nextRuleCode + i}`);
    parts.push(`${rulesCreated} правил (${codes.join(', ')})`);
  }
  if (qaPairsCreated > 0) {
    parts.push(`${qaPairsCreated} пар вопрос-ответ`);
  }

  const summary = `Сохранено: ${parts.join(', ')}`;
  return { rulesCreated, qaPairsCreated, summary };
}

/**
 * Correct existing knowledge using AI.
 */
export async function correctKnowledge(
  text: string,
  correctedByTelegramId: string
): Promise<{ updated: number; created: number; summary: string }> {
  // Fetch existing rules for context
  const existingRules = await prisma.rule.findMany({
    where: { status: 'ACTIVE' },
    select: { ruleCode: true, title: true, body: true },
    take: 50,
    orderBy: { createdAt: 'desc' },
  });

  const rulesText = existingRules
    .map((r) => `[${r.ruleCode}] ${r.title}: ${r.body.slice(0, 100)}`)
    .join('\n');

  const prompt = KNOWLEDGE_CORRECTOR_PROMPT
    .replace('{EXISTING_RULES}', rulesText)
    .replace('{ADMIN_TEXT}', text);

  const response = await createChatCompletion({
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: text },
    ],
    responseFormat: 'json_object',
    temperature: 0.2,
  });

  let parsed: { updates?: { existingRuleCode: string | null; title: string; body: string }[]; newQaPairs?: { question: string; answer: string }[] };
  try {
    parsed = JSON.parse(response);
  } catch {
    return { updated: 0, created: 0, summary: 'Не удалось распарсить ответ AI' };
  }

  let updated = 0;
  let created = 0;
  const domainIds = await classifyDomainForText(text);

  for (const update of (parsed.updates || [])) {
    if (update.existingRuleCode) {
      // Update existing rule by creating new version
      const existing = await prisma.rule.findFirst({
        where: { ruleCode: update.existingRuleCode, status: 'ACTIVE' },
      });

      if (existing) {
        // Supersede old rule
        await prisma.rule.update({
          where: { id: existing.id },
          data: { status: 'SUPERSEDED' },
        });

        // Create new version
        const nextCode = await getNextRuleCode();
        await prisma.rule.create({
          data: {
            ruleCode: `R-${nextCode}`,
            title: update.title,
            body: update.body,
            confidence: 0.9,
            supersedesRuleId: existing.id,
            sourceSpan: { quote: text.slice(0, 200), locationHint: `Исправлено через Telegram (${correctedByTelegramId})` },
          },
        });
        updated++;
      }
    } else {
      // New rule
      const nextCode = await getNextRuleCode();
      const newRule = await prisma.rule.create({
        data: {
          ruleCode: `R-${nextCode}`,
          title: update.title,
          body: update.body,
          confidence: 0.9,
          sourceSpan: { quote: text.slice(0, 200), locationHint: `Добавлено через Telegram (${correctedByTelegramId})` },
        },
      });

      for (const domainId of domainIds) {
        await prisma.ruleDomain.create({
          data: { ruleId: newRule.id, domainId, confidence: 0.9 },
        });
      }
      created++;
    }
  }

  // Save new QA pairs
  for (const qa of (parsed.newQaPairs || [])) {
    const newQa = await prisma.qAPair.create({
      data: { question: qa.question, answer: qa.answer },
    });
    for (const domainId of domainIds) {
      await prisma.qADomain.create({
        data: { qaId: newQa.id, domainId },
      });
    }
  }

  // Create chunk for the correction text
  await createKnowledgeChunk(text, domainIds);

  const parts: string[] = [];
  if (updated > 0) parts.push(`${updated} правил обновлено`);
  if (created > 0) parts.push(`${created} правил создано`);
  if (parsed.newQaPairs?.length) parts.push(`${parsed.newQaPairs.length} QA пар`);

  return {
    updated,
    created,
    summary: parts.length > 0 ? parts.join(', ') : 'Изменений не найдено',
  };
}

async function getNextRuleCode(): Promise<number> {
  const maxRule = await prisma.rule.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { ruleCode: 'desc' },
    select: { ruleCode: true },
  });

  if (!maxRule) return 1;

  const num = parseInt(maxRule.ruleCode.replace('R-', ''));
  return isNaN(num) ? 1 : num + 1;
}

async function classifyDomainForText(text: string): Promise<string[]> {
  // Quick domain classification using AI
  const response = await createChatCompletion({
    messages: [
      {
        role: 'system',
        content: `Определи домен(ы) для этого текста из списка:
general_ops, notary, pricing, translation_ops, formatting_delivery, it_tools, hr_internal, sales_clients, legal_compliance

Ответь JSON: { "domains": ["slug1"] }`,
      },
      { role: 'user', content: text.slice(0, 500) },
    ],
    responseFormat: 'json_object',
    temperature: 0.1,
    maxTokens: 256,
  });

  try {
    const parsed = JSON.parse(response) as { domains?: string[] };
    const slugs = parsed.domains || ['general_ops'];

    const domains = await prisma.domain.findMany({
      where: { slug: { in: slugs } },
      select: { id: true },
    });

    if (domains.length > 0) {
      return domains.map((d) => d.id);
    }

    // Fallback: use general_ops
    const fallback = await prisma.domain.findUnique({
      where: { slug: 'general_ops' },
      select: { id: true },
    });
    return fallback ? [fallback.id] : [];
  } catch {
    return [];
  }
}

async function createKnowledgeChunk(text: string, domainIds: string[]): Promise<void> {
  if (text.length < 20) return;

  try {
    const embeddings = await generateEmbeddings([text.slice(0, 2000)]);
    const embedding = embeddings[0];

    // Create a virtual document for admin-added content
    const doc = await prisma.document.create({
      data: {
        title: `Telegram: ${text.slice(0, 50)}...`,
        filename: 'telegram-input.txt',
        mimeType: 'text/plain',
        parseStatus: 'COMPLETED',
      },
    });

    // Link document to domains
    for (const domainId of domainIds) {
      await prisma.documentDomain.create({
        data: { documentId: doc.id, domainId, isPrimary: true, confidence: 0.9 },
      });
    }

    // Create chunk
    const chunk = await prisma.docChunk.create({
      data: {
        documentId: doc.id,
        chunkIndex: 0,
        content: text,
        embedding,
        metadata: { source: 'telegram_admin' },
      },
    });

    for (const domainId of domainIds) {
      await prisma.chunkDomain.create({
        data: { chunkId: chunk.id, domainId },
      });
    }
  } catch (error) {
    console.error('[knowledge-manager] Failed to create chunk:', error);
  }
}
