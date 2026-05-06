import { createChatCompletion, normalizeJsonResponse } from '@/lib/ai/chat-provider';
import prisma from '@/lib/db';
import { buildExtractionBatches, dedupeAndRenumberRules } from '@/lib/ai/extraction-batches';

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

export async function extractKnowledge(
  documentText: string,
  existingRuleCodes: string[] = []
): Promise<KnowledgeExtractionResult> {
  let currentRuleCode = existingRuleCodes.length > 0
    ? Math.max(...existingRuleCodes.map(c => parseInt(c.replace('R-', '')))) + 1
    : 1;

  const batches = buildExtractionBatches(documentText);

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
${batches.length > 1 ? `Часть ${batch.index} из ${batch.total}. Строки ${batch.startLine}-${batch.endLine}.` : ''}

ТЕКСТ ДОКУМЕНТА С НОМЕРАМИ СТРОК:
${batch.numberedText}

ВАЖНО:
1. Пройди строки сверху вниз. Каждая атомарная строка с ценой, сроком, адресом, телефоном, требованием, исключением, шагом процедуры, вариантом подачи, способом оплаты, ответственным или аббревиатурой = отдельное правило.
2. Не объединяй несколько разных фактов в одно правило. Лучше 3 коротких правила, чем 1 длинное.
3. Для списков создай отдельное правило на каждый пункт списка.
4. Если строка является заголовком раздела, используй её как locationHint для следующих правил.
5. В sourceSpan.locationHint указывай номер строки или диапазон строк, например "L0012-L0014".
6. Цель плотности: из 20 содержательных строк обычно должно получиться 12-25 правил. Не экономь правила.
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

  const deduped = dedupeAndRenumberRules(allRules, allQAPairs, existingRuleCodes.length > 0
    ? Math.max(...existingRuleCodes.map(c => parseInt(c.replace('R-', '')))) + 1
    : 1);

  return {
    rules: deduped.rules,
    qaPairs: deduped.qaPairs,
    uncertainties: allUncertainties,
  };
}

export async function saveExtractedRules(
  documentId: string,
  rules: ExtractedRule[],
  domainIds: string[]
) {
  const createdRules: { id: string; ruleCode: string }[] = [];
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { scenarioKey: true },
  });

  for (const rule of rules) {
    const created = await prisma.rule.create({
      data: {
        documentId,
        ruleCode: rule.ruleCode,
        title: rule.title,
        body: rule.body,
        confidence: rule.confidence,
        sourceSpan: rule.sourceSpan,
        scenarioKey: document?.scenarioKey ?? null,
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
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: { scenarioKey: true },
  });
  for (const qa of qaPairs) {
    const ruleId = qa.linkedRuleCode ? ruleCodeToId.get(qa.linkedRuleCode) : null;

    const created = await prisma.qAPair.create({
      data: {
        documentId,
        ruleId,
        question: qa.question,
        answer: qa.answer,
        scenarioKey: document?.scenarioKey ?? null,
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
