import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const domains = await prisma.domain.findMany({
  select: { id: true, slug: true, title: true, parentDomainId: true, _count: { select: { rules: true, qaPairs: true, chunks: true, documents: true } } },
  orderBy: { slug: 'asc' },
});

console.log('=== DOMAINS ===');
console.log(`Total: ${domains.length}`);
for (const d of domains) {
  const parent = d.parentDomainId ? domains.find(x => x.id === d.parentDomainId)?.slug : null;
  console.log(`- ${d.slug}${parent ? ' [parent: ' + parent + ']' : ''} — "${d.title}" (rules:${d._count.rules}, qa:${d._count.qaPairs}, chunks:${d._count.chunks}, docs:${d._count.documents})`);
}

await prisma.$disconnect();
