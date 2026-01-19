import { openai, CHAT_MODEL } from '@/lib/openai';
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

const EXTRACTION_SYSTEM_PROMPT = `You are a Knowledge Extractor for a translation bureau.

Your task is to extract structured knowledge from documents:

1. BUSINESS RULES: Explicit statements about how things should be done
   - Prices, rates, deadlines
   - Procedures and workflows
   - Requirements and conditions

2. Q&A PAIRS: Natural question-answer pairs that could help staff
   - Based on the rules you extract
   - Common questions someone might ask about this topic

3. UNCERTAINTIES: Flag anything that is:
   - Ambiguous ("примерно", "обычно", "около")
   - Potentially outdated
   - Conflicting with common knowledge
   - Missing important context

CRITICAL:
- Extract ONLY what is explicitly stated
- Do NOT infer or assume information
- If a price is mentioned, extract it exactly
- If a procedure is described, extract the steps
- Always cite the source with a relevant quote

Rule codes should be sequential: R-1, R-2, R-3...`;

export async function extractKnowledge(
  documentText: string,
  existingRuleCodes: string[] = []
): Promise<KnowledgeExtractionResult> {
  const startCode = existingRuleCodes.length > 0
    ? Math.max(...existingRuleCodes.map(c => parseInt(c.replace('R-', '')))) + 1
    : 1;

  const response = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Extract knowledge from this document.
Start rule numbering from R-${startCode}.

Document content:
${documentText.slice(0, 12000)}

Respond with JSON in this exact format:
{
  "rules": [
    {
      "ruleCode": "R-${startCode}",
      "title": "Short descriptive title",
      "body": "Full rule description",
      "confidence": 0.0-1.0,
      "sourceSpan": {
        "quote": "Exact quote from document",
        "locationHint": "Section or context"
      }
    }
  ],
  "qaPairs": [
    {
      "question": "Natural question",
      "answer": "Clear answer based on extracted rules",
      "linkedRuleCode": "R-X or null"
    }
  ],
  "uncertainties": [
    {
      "type": "ambiguous|outdated|conflicting|missing_context",
      "description": "What is uncertain",
      "suggestedQuestion": "Question to ask the admin"
    }
  ]
}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.2,
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error('Empty response from Knowledge Extractor');
  }

  return JSON.parse(content) as KnowledgeExtractionResult;
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
