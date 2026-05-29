import { createChatCompletion, normalizeJsonResponse } from '@/lib/ai/chat-provider';
import prisma from '@/lib/db';

export interface ExtractedRule {
  ruleCode: string;
  title: string;
  body: string;
  confidence: number;
  sourceSpan: {
    quote: string;
    locationHint: string;
  };
}

export interface ExtractedQA {
  question: string;
  answer: string;
  linkedRuleCode: string | null;
}

export interface KnowledgeExtractionResult {
  rules: ExtractedRule[];
  qaPairs: ExtractedQA[];
  uncertainties: {
    type: string;
    description: string;
    suggestedQuestion: string;
  }[];
}

const EXTRACTION_SYSTEM_PROMPT = `Ты - Экстрактор знаний для бюро переводов "Аврора".

ВСЕ ТЕКСТЫ ТОЛЬКО НА РУССКОМ ЯЗЫКЕ.

ГЛАВНАЯ ЗАДАЧА: извлечь МАКСИМАЛЬНОЕ количество конкретных правил из текста.
Лучше извлечь 30 правил, чем пропустить 20 из-за неуверенности.

═══ ЧТО СЧИТАЕТСЯ ПРАВИЛОМ ═══

Каждое из следующего = ОТДЕЛЬНОЕ правило:
• Любая цена, тариф, стоимость (за страницу, за слово, за услугу, за язык)
• Любой срок выполнения или действия документа
• Любое требование к документу (формат, заверение, апостиль, нотариус)
• Любая процедура или последовательность шагов
• Любое контактное лицо или ответственный
• Любая скидка, наценка, коэффициент, надбавка
• Любое ограничение, условие или исключение
• Любой тип услуги с описанием
• Любая аббревиатура или специальный термин с расшифровкой

═══ КАК ПИСАТЬ ПРАВИЛА ═══

title (5–12 слов): конкретный и содержательный
body: конкретные числа, суммы, шаги — без сокращений
confidence: 0.95 если явная цифра в тексте, 0.8 если вывод из контекста
sourceSpan.quote: дословная цитата (макс. 150 символов)

Коды правил: R-1, R-2, R-3 ... (строго последовательно)`;

const BATCH_SIZE = 8000;
const BATCH_OVERLAP = 600;

export async function extractKnowledge(
  documentText: string,
  existingRuleCodes: string[] = []
): Promise<KnowledgeExtractionResult> {
  let currentRuleCode = existingRuleCodes.length > 0
    ? Math.max(...existingRuleCodes.map(c => parseInt(c.replace('R-', '')))) + 1
    : 1;

  // Split document into batches so the full text is processed, not just the first 12k chars
  const batches: string[] = [];
  let offset = 0;
  while (offset < documentText.length) {
    const end = Math.min(offset + BATCH_SIZE, documentText.length);
    batches.push(documentText.slice(offset, end));
    if (end >= documentText.length) break;
    offset = end - BATCH_OVERLAP;
  }

  const allRules: ExtractedRule[] = [];
  const allQAPairs: ExtractedQA[] = [];
  const allUncertainties: KnowledgeExtractionResult['uncertainties'] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];

    const content = await createChatCompletion({
      messages: [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Извлеки ВСЕ правила из этой части документа. Нумерация начинается с R-${currentRuleCode}.
${batches.length > 1 ? `Часть ${i + 1} из ${batches.length}.` : ''}

ТЕКСТ ДОКУМЕНТА:
${batch}

ВАЖНО: Пройди текст построчно. Каждая строка с конкретным значением (цена, срок, требование, шаг) = отдельное правило.
Аббревиатуры (СОН, ГТД, ДМС и т.д.) тоже оформляй как правило с расшифровкой.

Ответь в формате JSON:
{
  "rules": [{"ruleCode": "R-${currentRuleCode}", "title": "...", "body": "...", "confidence": 0.95, "sourceSpan": {"quote": "...", "locationHint": "..."}}],
  "qaPairs": [{"question": "...", "answer": "...", "linkedRuleCode": "R-X или null"}],
  "uncertainties": [{"type": "ambiguous|outdated|conflicting|missing_context", "description": "...", "suggestedQuestion": "..."}]
}`,
        },
      ],
      responseFormat: 'json_object',
      temperature: 0.1,
      maxTokens: 8192,
    });

    if (!content) continue;

    try {
      const cleaned = normalizeJsonResponse(content);
      const result = JSON.parse(cleaned) as Partial<KnowledgeExtractionResult>;
      if (result && Array.isArray(result.rules)) {
        allRules.push(...result.rules);
        allQAPairs.push(...(result.qaPairs ?? []));
        allUncertainties.push(...(result.uncertainties ?? []));
        if (result.rules.length > 0) {
          const maxCode = Math.max(...result.rules.map(r => parseInt(r.ruleCode.replace('R-', ''))));
          currentRuleCode = maxCode + 1;
        }
      }
    } catch (e) {
      console.error(`[extractKnowledge] Failed to parse batch ${i + 1}:`, e);
    }
  }

  return {
    rules: allRules,
    qaPairs: allQAPairs,
    uncertainties: allUncertainties,
  };
}

export async function saveExtractedRules(
  documentId: string,
  rules: ExtractedRule[],
  domainIds: string[]
) {
  const createdRules: { id: string; ruleCode: string }[] = [];

  for (const rule of rules) {
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

    createdRules.push({ id: created.id, ruleCode: created.ruleCode });

    // Link rule to domains
    for (const domainId of domainIds) {
      await prisma.ruleDomain.create({
        data: {
          ruleId: created.id,
          domainId,
          confidence: rule.confidence,
        },
      });
    }
  }

  return createdRules;
}

export async function saveExtractedQAs(
  documentId: string,
  qaPairs: ExtractedQA[],
  ruleCodeToId: Map<string, string>,
  domainIds: string[]
) {
  for (const qa of qaPairs) {
    const ruleId = qa.linkedRuleCode ? ruleCodeToId.get(qa.linkedRuleCode) : null;

    const created = await prisma.qAPair.create({
      data: {
        documentId,
        ruleId,
        question: qa.question,
        answer: qa.answer,
      },
    });

    // Link QA to domains
    for (const domainId of domainIds) {
      await prisma.qADomain.create({
        data: {
          qaId: created.id,
          domainId,
        },
      });
    }
  }
}

export async function createAIQuestions(
  uncertainties: KnowledgeExtractionResult['uncertainties']
) {
  for (const u of uncertainties) {
    await prisma.aIQuestion.create({
      data: {
        issueType: u.type,
        question: u.suggestedQuestion,
        context: { description: u.description },
      },
    });
  }
}

export async function getExistingRuleCodes(): Promise<string[]> {
  const rules = await prisma.rule.findMany({
    select: { ruleCode: true },
    where: { status: 'ACTIVE' },
  });
  return rules.map((r) => r.ruleCode);
}
