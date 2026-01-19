import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const baseDomains = [
  {
    slug: 'general_ops',
    title: 'General Operations',
    description: 'General operational procedures and guidelines',
  },
  {
    slug: 'notary',
    title: 'Notary Services',
    description: 'Notarization workflows, contacts, and requirements',
  },
  {
    slug: 'pricing',
    title: 'Pricing',
    description: 'Service pricing, rates, and cost calculations',
  },
  {
    slug: 'translation_ops',
    title: 'Translation Operations',
    description: 'Translation workflows, quality standards, and procedures',
  },
  {
    slug: 'formatting_delivery',
    title: 'Formatting & Delivery',
    description: 'Document formatting requirements and delivery procedures',
  },
  {
    slug: 'it_tools',
    title: 'IT & Tools',
    description: 'Software tools, CAT tools, and technical procedures',
  },
  {
    slug: 'hr_internal',
    title: 'HR & Internal',
    description: 'Human resources, internal policies, and team procedures',
  },
  {
    slug: 'sales_clients',
    title: 'Sales & Clients',
    description: 'Client management, sales procedures, and communication',
  },
  {
    slug: 'legal_compliance',
    title: 'Legal & Compliance',
    description: 'Legal requirements, compliance, and regulatory information',
  },
];

async function main() {
  console.log('Seeding database...');

  // Create base domains
  for (const domain of baseDomains) {
    await prisma.domain.upsert({
      where: { slug: domain.slug },
      update: {},
      create: domain,
    });
    console.log(`Created domain: ${domain.slug}`);
  }

  console.log('Seeding completed!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
