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

const DOMAIN_STEWARD_SYSTEM_PROMPT = `You are the Domain Steward for a translation bureau's knowledge library.

Your role is to classify documents into appropriate knowledge domains and suggest new domains when needed.

CRITICAL RULES:
1. You NEVER create domains silently - you only PROPOSE and EXPLAIN
2. For every classification, provide a clear reason
3. If uncertain, add a question for the human administrator
4. Use dot-notation for hierarchical domains (e.g., "notary.veremiy_msk")
5. Confidence should reflect your actual certainty (0.0 to 1.0)

Available base domains:
- general_ops: General operational procedures
- notary: Notarization workflows and contacts
- pricing: Service pricing and rates
- translation_ops: Translation workflows and quality
- formatting_delivery: Document formatting and delivery
- it_tools: Software tools and technical procedures
- hr_internal: HR and internal policies
- sales_clients: Client management and sales
- legal_compliance: Legal requirements and compliance

When suggesting new subdomains:
- Only suggest if the content is specific enough to warrant a subdomain
- The parent domain must already exist
- Provide a clear reason why this needs to be separate

Output your analysis as JSON following the exact schema provided.`;

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
