import { openai, CHAT_MODEL } from '@/lib/openai';
import prisma from '@/lib/db';

export interface DomainClassification {
  primaryDomainSlug: string;
  secondaryDomainSlugs: string[];
  confidence: number;
  reason: string;
}

export interface NewDomainSuggestion {
  suggestedSlug: string;
  title: string;
  description: string;
  parentSlug: string | null;
  confidence: number;
  reason: string;
}

export interface DomainStewardResult {
  documentDomains: DomainClassification[];
  newDomainSuggestions: NewDomainSuggestion[];
  questionsForHuman: string[];
}

const DOMAIN_STEWARD_SYSTEM_PROMPT = `Ты - Хранитель доменов библиотеки знаний бюро переводов.

Твоя задача - классифицировать документы по подходящим доменам знаний и предлагать новые домены при необходимости.

ВАЖНО: Отвечай ТОЛЬКО на русском языке!

КРИТИЧЕСКИЕ ПРАВИЛА:
1. Ты НИКОГДА не создаёшь домены самостоятельно - ты только ПРЕДЛАГАЕШЬ и ОБЪЯСНЯЕШЬ
2. Для каждой классификации указывай чёткую причину
3. При неуверенности добавляй вопрос для администратора
4. Используй точечную нотацию для иерархических доменов (например, "notary.veremiy_msk")
5. Уверенность должна отражать твою реальную оценку (от 0.0 до 1.0)

Доступные базовые домены:
- general_ops: Общие операционные процедуры
- notary: Нотариальные процедуры и контакты
- pricing: Цены и тарифы на услуги
- translation_ops: Процессы перевода и контроль качества
- formatting_delivery: Форматирование и доставка документов
- it_tools: Программные инструменты и технические процедуры
- hr_internal: HR и внутренние политики
- sales_clients: Работа с клиентами и продажи
- legal_compliance: Юридические требования и соответствие

При предложении новых поддоменов:
- Предлагай только если контент достаточно специфичен для отдельного поддомена
- Родительский домен должен уже существовать
- Укажи чёткую причину, почему это должно быть отдельно

Выводи анализ в формате JSON по указанной схеме. ВСЕ тексты (reason, description, questions) должны быть на РУССКОМ языке.`;

export async function classifyDocumentDomains(
  documentText: string,
  existingDomains: { slug: string; title: string; description: string | null }[]
): Promise<DomainStewardResult> {
  const domainList = existingDomains
    .map((d) => `- ${d.slug}: ${d.title}${d.description ? ` (${d.description})` : ''}`)
    .join('\n');

  const response = await openai.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      { role: 'system', content: DOMAIN_STEWARD_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Analyze this document and classify it into appropriate domains.

Available domains:
${domainList}

Document content:
${documentText.slice(0, 8000)}

Respond with JSON in this exact format:
{
  "documentDomains": [
    {
      "primaryDomainSlug": "string",
      "secondaryDomainSlugs": ["string"],
      "confidence": 0.0-1.0,
      "reason": "string"
    }
  ],
  "newDomainSuggestions": [
    {
      "suggestedSlug": "string",
      "title": "string",
      "description": "string",
      "parentSlug": "string or null",
      "confidence": 0.0-1.0,
      "reason": "string"
    }
  ],
  "questionsForHuman": ["string"]
}`,
      },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.3,
  });

  const content = response.choices[0].message.content;
  if (!content) {
    throw new Error('Empty response from Domain Steward');
  }

  const result = JSON.parse(content) as DomainStewardResult;
  return result;
}

export async function getExistingDomains() {
  return prisma.domain.findMany({
    select: {
      slug: true,
      title: true,
      description: true,
    },
  });
}

export async function saveDomainSuggestions(
  documentId: string,
  suggestions: NewDomainSuggestion[]
) {
  const records = suggestions.map((s) => ({
    suggestedSlug: s.suggestedSlug,
    title: s.title,
    description: s.description,
    parentSlug: s.parentSlug,
    confidence: s.confidence,
    reason: s.reason,
    createdFromDocumentId: documentId,
  }));

  await prisma.domainSuggestion.createMany({
    data: records,
  });
}

export async function linkDocumentToDomains(
  documentId: string,
  classifications: DomainClassification[]
) {
  for (const classification of classifications) {
    // Link primary domain
    const primaryDomain = await prisma.domain.findUnique({
      where: { slug: classification.primaryDomainSlug },
    });

    if (primaryDomain) {
      await prisma.documentDomain.upsert({
        where: {
          documentId_domainId: {
            documentId,
            domainId: primaryDomain.id,
          },
        },
        update: {
          isPrimary: true,
          confidence: classification.confidence,
        },
        create: {
          documentId,
          domainId: primaryDomain.id,
          isPrimary: true,
          confidence: classification.confidence,
        },
      });
    }

    // Link secondary domains
    for (const secondarySlug of classification.secondaryDomainSlugs) {
      const secondaryDomain = await prisma.domain.findUnique({
        where: { slug: secondarySlug },
      });

      if (secondaryDomain) {
        await prisma.documentDomain.upsert({
          where: {
            documentId_domainId: {
              documentId,
              domainId: secondaryDomain.id,
            },
          },
          update: {
            isPrimary: false,
            confidence: classification.confidence * 0.8,
          },
          create: {
            documentId,
            domainId: secondaryDomain.id,
            isPrimary: false,
            confidence: classification.confidence * 0.8,
          },
        });
      }
    }
  }
}
