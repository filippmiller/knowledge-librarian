import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NEEDLE = /апостил/i;

function snippet(text, needle, radius = 160) {
  if (!text) return '';
  const m = text.match(needle);
  if (!m) return text.slice(0, 240);
  const i = m.index ?? 0;
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + radius);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

async function main() {
  const [docCount, ruleCount, qaCount, chunkCount] = await Promise.all([
    prisma.document.count(),
    prisma.rule.count(),
    prisma.qAPair.count(),
    prisma.docChunk.count(),
  ]);
  console.log('=== DB TOTALS ===');
  console.log({ docCount, ruleCount, qaCount, chunkCount });
  console.log();

  const docs = await prisma.document.findMany({
    where: {
      OR: [
        { title: { contains: 'апостил', mode: 'insensitive' } },
        { filename: { contains: 'апостил', mode: 'insensitive' } },
        { rawText: { contains: 'апостил', mode: 'insensitive' } },
      ],
    },
    select: { id: true, title: true, filename: true, parseStatus: true, rawText: true, uploadedAt: true },
  });
  console.log(`=== DOCUMENTS mentioning "апостил" (${docs.length}) ===`);
  for (const d of docs) {
    const hits = (d.rawText || '').match(/апостил[а-я]*/gi) || [];
    console.log(`- [${d.id.slice(0, 10)}] "${d.title}" (${d.filename}) ${d.parseStatus} — ${hits.length} mentions`);
  }
  console.log();

  const rules = await prisma.rule.findMany({
    where: {
      OR: [
        { title: { contains: 'апостил', mode: 'insensitive' } },
        { body: { contains: 'апостил', mode: 'insensitive' } },
      ],
    },
    select: {
      id: true,
      ruleCode: true,
      title: true,
      body: true,
      confidence: true,
      status: true,
      sourceSpan: true,
      createdAt: true,
      document: { select: { id: true, title: true } },
      domains: { select: { domain: { select: { slug: true, title: true } } } },
    },
    orderBy: { ruleCode: 'asc' },
  });
  console.log(`=== RULES matching "апостил" (${rules.length}) ===`);
  for (const r of rules) {
    const domainSlugs = r.domains.map((d) => d.domain.slug).join(', ') || '—';
    console.log(`\n[${r.ruleCode}] ${r.title}  (status=${r.status}, conf=${r.confidence?.toFixed?.(2) ?? r.confidence})`);
    console.log(`  doc: ${r.document?.title ?? '(unlinked)'}`);
    console.log(`  domains: ${domainSlugs}`);
    console.log(`  body: ${snippet(r.body, NEEDLE)}`);
    if (r.sourceSpan && typeof r.sourceSpan === 'object') {
      const s = r.sourceSpan;
      if (s.locationHint || s.quote) {
        const q = s.quote ? String(s.quote).slice(0, 160).replace(/\s+/g, ' ').trim() : '';
        console.log(`  src: ${s.locationHint ?? ''}${q ? ` — "${q}"` : ''}`);
      }
    }
  }
  console.log();

  const qas = await prisma.qAPair.findMany({
    where: {
      OR: [
        { question: { contains: 'апостил', mode: 'insensitive' } },
        { answer: { contains: 'апостил', mode: 'insensitive' } },
      ],
    },
    select: {
      id: true,
      question: true,
      answer: true,
      status: true,
      document: { select: { id: true, title: true } },
      rule: { select: { ruleCode: true } },
    },
  });
  console.log(`=== Q&A PAIRS matching "апостил" (${qas.length}) ===`);
  for (const q of qas) {
    console.log(`\nQ: ${q.question}`);
    console.log(`A: ${snippet(q.answer, NEEDLE, 240)}`);
    console.log(`  linked: doc="${q.document?.title ?? '—'}" rule=${q.rule?.ruleCode ?? '—'}  status=${q.status}`);
  }
  console.log();

  const chunks = await prisma.docChunk.findMany({
    where: { content: { contains: 'апостил', mode: 'insensitive' } },
    select: {
      id: true,
      content: true,
      chunkIndex: true,
      document: { select: { id: true, title: true } },
    },
    orderBy: [{ documentId: 'asc' }, { chunkIndex: 'asc' }],
    take: 50,
  });
  console.log(`=== CHUNKS matching "апостил" (${chunks.length}) ===`);
  for (const c of chunks) {
    console.log(`\n#${c.chunkIndex} in "${c.document?.title}"`);
    console.log(`  ${snippet(c.content, NEEDLE, 200)}`);
  }

  console.log('\n=== REGIONAL VARIANT CROSS-SLICE ===');
  const regions = [
    { label: 'СПб / Санкт-Петербург', re: /(\bспб\b|санкт[- ]петербург|петербург)/i },
    { label: 'Ленинградская область', re: /(ленинградск|\bленобл|\bлен\.?\s*обл|\bло\b)/i },
    { label: 'Москва', re: /(москв|\bмск\b)/i },
    { label: 'МО / Моск. обл.', re: /(московск(ая|ой)\s*обл|\bмо\s|моск\.?\s*обл)/i },
    { label: 'Россия / РФ в целом', re: /(росси[йяе]|\bрф\b)/i },
    { label: 'зарубежн/иностран', re: /(зарубеж|иностран|посольств|консульств)/i },
  ];
  const all = [
    ...rules.map((r) => ({ kind: 'RULE', code: r.ruleCode, title: r.title, text: `${r.title}\n${r.body}` })),
    ...qas.map((q) => ({ kind: 'QA ', code: q.id.slice(0, 8), title: q.question.slice(0, 90), text: `${q.question}\n${q.answer}` })),
  ];
  for (const region of regions) {
    const hits = all.filter((item) => region.re.test(item.text));
    console.log(`\n[${region.label}] ${hits.length} items`);
    for (const h of hits) {
      console.log(`  - ${h.kind} ${h.code}: ${h.title}`);
    }
  }
}

main()
  .catch((e) => {
    console.error('ERROR:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
