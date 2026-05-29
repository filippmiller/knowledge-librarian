import prisma from '@/lib/db';

type DomainConfig = {
  slug: string;
  title: string;
  description: string;
  parentSlug: string;
  documentFilenames: string[];
  documentTitleContains?: string[];
};

const DOMAINS: DomainConfig[] = [
  {
    slug: 'legal_compliance.consular_legalization',
    title: 'Консульская легализация',
    description: 'Процедуры, сроки, требования и страны для консульской легализации документов.',
    parentSlug: 'legal_compliance',
    documentFilenames: [
      'ИНСТРУКЦИЯ КЛ общее (2).docx',
      'Список_стран_для_которых_ТРЕБУЕТСЯ_КЛ.docx',
      'шпаргалка про апостили.docx',
    ],
    documentTitleContains: ['ИНСТРУКЦИЯ КЛ общее'],
  },
  {
    slug: 'sales_clients.crm_checklists',
    title: 'CRM чек-листы',
    description: 'Заполнение лидов, сделок, бланков заказа и операционные CRM-процедуры.',
    parentSlug: 'sales_clients',
    documentFilenames: [
      'Чек_лист_заполнение_Лида,_Сделки,_Бланка.docx',
      'Шпаргалка.docx',
    ],
  },
];

async function ensureDomain(config: DomainConfig) {
  const parent = await prisma.domain.findUnique({ where: { slug: config.parentSlug } });
  if (!parent) throw new Error(`Parent domain not found: ${config.parentSlug}`);

  return prisma.domain.upsert({
    where: { slug: config.slug },
    update: {
      title: config.title,
      description: config.description,
      parentDomainId: parent.id,
    },
    create: {
      slug: config.slug,
      title: config.title,
      description: config.description,
      parentDomainId: parent.id,
    },
  });
}

async function findTargetDocuments(config: DomainConfig) {
  const or = [
    { filename: { in: config.documentFilenames } },
    ...(config.documentTitleContains ?? []).map((needle) => ({
      title: { contains: needle, mode: 'insensitive' as const },
    })),
  ];

  return prisma.document.findMany({
    where: { OR: or },
    select: { id: true, title: true, filename: true },
  });
}

async function linkDomainToDocument(domainId: string, documentId: string) {
  await prisma.documentDomain.upsert({
    where: { documentId_domainId: { documentId, domainId } },
    update: { confidence: 0.98 },
    create: { documentId, domainId, isPrimary: false, confidence: 0.98 },
  });

  const [rules, qaPairs, chunks] = await Promise.all([
    prisma.rule.findMany({ where: { documentId }, select: { id: true, confidence: true } }),
    prisma.qAPair.findMany({ where: { documentId }, select: { id: true } }),
    prisma.docChunk.findMany({ where: { documentId }, select: { id: true } }),
  ]);

  for (const rule of rules) {
    await prisma.ruleDomain.upsert({
      where: { ruleId_domainId: { ruleId: rule.id, domainId } },
      update: { confidence: Math.max(rule.confidence, 0.9) },
      create: { ruleId: rule.id, domainId, confidence: Math.max(rule.confidence, 0.9) },
    });
  }

  for (const qa of qaPairs) {
    await prisma.qADomain.upsert({
      where: { qaId_domainId: { qaId: qa.id, domainId } },
      update: { confidence: 0.95 },
      create: { qaId: qa.id, domainId, confidence: 0.95 },
    });
  }

  for (const chunk of chunks) {
    await prisma.chunkDomain.upsert({
      where: { chunkId_domainId: { chunkId: chunk.id, domainId } },
      update: { confidence: 0.95 },
      create: { chunkId: chunk.id, domainId, confidence: 0.95 },
    });
  }

  return {
    rules: rules.length,
    qaPairs: qaPairs.length,
    chunks: chunks.length,
  };
}

async function rejectResolvedStagedDomainSuggestions(slug: string) {
  const result = await prisma.stagedExtraction.updateMany({
    where: {
      itemType: 'DOMAIN_SUGGESTION',
      isVerified: false,
      data: {
        path: ['suggestedSlug'],
        equals: slug,
      },
    },
    data: { isRejected: true },
  });

  return result.count;
}

async function main() {
  const report = [];

  for (const config of DOMAINS) {
    const domain = await ensureDomain(config);
    const documents = await findTargetDocuments(config);
    if (documents.length === 0) {
      throw new Error(`No documents found for ${config.slug}`);
    }

    const links = [];
    for (const document of documents) {
      const counts = await linkDomainToDocument(domain.id, document.id);
      links.push({ document: document.title, filename: document.filename, ...counts });
    }

    const resolvedSuggestions = await rejectResolvedStagedDomainSuggestions(config.slug);
    report.push({
      domain: config.slug,
      documentsLinked: documents.length,
      resolvedStagedDomainSuggestions: resolvedSuggestions,
      links,
    });
  }

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((error) => {
    console.error('[fatal]', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
