import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  console.log('=== T2 HALLUCINATION CHECK: КЗАГС СПб schedule claims ===');
  const kzagsDoc = await p.document.findFirst({ where: { scenarioKey: 'apostille.zags.spb' }, select: { rawText: true } });
  const text = kzagsDoc?.rawText ?? '';
  for (const phrase of ['Вторник–пятница','Вторник-пятница','10:00–17:00','10:00-17:00','14:00–15:00','14:00-15:00','Суббота','Понедельник','выходной','задний двор','Дворца Бракосочетания','дальнее здание','Санитарный день']) {
    const found = text.toLowerCase().includes(phrase.toLowerCase());
    console.log(`  ${found?'✓':'✗'} "${phrase}"`);
  }
  console.log();

  console.log('=== T4 CHECK: МЮ source text presence ===');
  const myDoc = await p.document.findFirst({ where: { scenarioKey: 'apostille.min_justice' }, select: { rawText: true } });
  const mytext = myDoc?.rawText ?? '';
  for (const phrase of ['Оптиков','35к1','679-70-31','Исаакиевская','ул. Оптиков','ПОЛУЧЕНИЕ С 9:30','ПОДАЧА С 9:30']) {
    console.log(`  ${mytext.includes(phrase)?'✓':'✗'} "${phrase}"`);
  }
  console.log();

  // T2: what is actually in КЗАГС schedule?
  console.log('=== КЗАГС раздел про график (first occurrence of "график" or "ВРЕМЯ") ===');
  const m = text.match(/[\s\S]{0,50}(график|ВРЕМЯ|режим|работ[аы])[\s\S]{0,400}/i);
  console.log(m ? m[0].replace(/\n{2,}/g,'\n').slice(0,600) : '(not found in rawText)');
}
main().catch(e=>{console.error(e);process.exit(1);}).finally(()=>p.$disconnect());
