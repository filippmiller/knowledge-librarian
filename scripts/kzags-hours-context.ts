import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const d = await p.document.findFirst({ where: { scenarioKey: 'apostille.zags.spb' }, select: { rawText: true } });
  const text = d?.rawText ?? '';
  for (const word of ['Понедельник', 'Суббота', 'выходной', 'Санитарный']) {
    const idx = text.indexOf(word);
    console.log(`\n=== context around "${word}" @ ${idx} ===`);
    if (idx >= 0) console.log(text.slice(Math.max(0, idx - 60), Math.min(text.length, idx + 200)).replace(/\s+/g, ' '));
    else console.log('NOT FOUND');
  }
}
main().catch(e=>{console.error(e);process.exit(1);}).finally(()=>p.$disconnect());
