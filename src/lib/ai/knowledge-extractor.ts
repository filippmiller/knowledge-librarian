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

const EXTRACTION_SYSTEM_PROMPT = `Ты - Экстрактор знаний для бюро переводов.

ВАЖНО: ВСЕ извлечённые данные должны быть на РУССКОМ языке!

Твоя задача - извлечь структурированные знания из документов:

1. БИЗНЕС-ПРАВИЛА: Явные утверждения о порядке работы
   - Цены, тарифы, сроки
   - Процедуры и рабочие процессы
   - Требования и условия

2. ВОПРОСЫ И ОТВЕТЫ: Пары вопрос-ответ для помощи сотрудникам
   - На основе извлечённых правил
   - Типичные вопросы по теме

3. НЕЯСНОСТИ: Отметь всё, что:
   - Неоднозначно ("примерно", "обычно", "около")
   - Возможно устарело
   - Противоречит общим знаниям
   - Требует уточнения

КРИТИЧЕСКИ ВАЖНО:
- Извлекай ТОЛЬКО явно указанное
- НЕ делай выводов и предположений
- Если указана цена - извлекай точно
- Если описана процедура - извлекай шаги
- Всегда цитируй источник с точной цитатой
- ВСЕ тексты (title, body, question, answer, description) на РУССКОМ языке

Коды правил должны быть последовательными: R-1, R-2, R-3...`;

export async function extractKnowledge(
  documentText: string,
  existingRuleCodes: string[] = []
): Promise<KnowledgeExtractionResult> {
  const startCode = existingRuleCodes.length > 0
    ? Math.max(...existingRuleCodes.map(c => parseInt(c.replace('R-', '')))) + 1
    : 1;

  const content = await createChatCompletion({
    messages: [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Извлеки знания из этого документа.
Начни нумерацию правил с R-${startCode}.

Содержимое документа:
${documentText.slice(0, 12000)}

Ответь в формате JSON точно по этой схеме:
{
  "rules": [
    {
      "ruleCode": "R-${startCode}",
      "title": "Краткое название правила на русском",
      "body": "Полное описание правила на русском",
      "confidence": 0.0-1.0,
      "sourceSpan": {
        "quote": "Точная цитата из документа",
        "locationHint": "Раздел или контекст"
      }
    }
  ],
  "qaPairs": [
    {
      "question": "Вопрос на русском",
      "answer": "Чёткий ответ на русском на основе извлечённых правил",
      "linkedRuleCode": "R-X или null"
    }
  ],
  "uncertainties": [
    {
      "type": "ambiguous|outdated|conflicting|missing_context",
      "description": "Описание неясности на русском",
      "suggestedQuestion": "Вопрос администратору на русском"
    }
  ]
}`,
      },
    ],
    responseFormat: 'json_object',
    temperature: 0.2,
    maxTokens: 4096,
  });
  if (!content) {
    throw new Error('Empty response from Knowledge Extractor');
  }

  const cleaned = normalizeJsonResponse(content);
  const result = JSON.parse(cleaned) as Partial<KnowledgeExtractionResult>;
  if (
    !result ||
    !Array.isArray(result.rules) ||
    !Array.isArray(result.qaPairs) ||
    !Array.isArray(result.uncertainties)
  ) {
    throw new Error('Knowledge Extractor returned invalid JSON');
  }

  return result as KnowledgeExtractionResult;
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
