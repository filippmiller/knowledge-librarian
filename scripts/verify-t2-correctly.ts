import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  const d = await p.document.findFirst({ where: { scenarioKey: 'apostille.zags.spb' }, select: { rawText: true } });
  const text = (d?.rawText ?? '').toLowerCase().replace(/\s+/g, ' ');

  // Facts claimed by T2 v3 answer, checked as semantic substrings (not literal)
  const checks = [
    { label: 'Фурштатская 52',               needles: ['фурштатск', '52'] },
    { label: 'ст.м. Чернышевская',           needles: ['чернышевск'] },
    { label: 'телефон 272-21-10',            needles: ['272-21-10'] },
    { label: 'телефон 273-37-17',            needles: ['273-37-17'] },
    { label: 'сайт kzags.gov.spb.ru/apostil',needles: ['kzags.gov.spb.ru/apostil'] },
    { label: '2500 рублей',                  needles: ['2500'] },
    { label: 'Пн выходной',                  needles: ['понедельник выходной'] },
    { label: 'Вт 10:00-17:00',               needles: ['вторник с 10:00 до 17:00'] },
    { label: 'Перерыв 14:00-15:00',          needles: ['14:00 до 15:00'] },
    { label: 'Сб 10:00-16:00',               needles: ['суббота с 10:00 до 16:00'] },
    { label: 'Оригинал ЗАГС СПб',            needles: ['оригинал', 'загс спб'] },
    { label: 'На русском языке',             needles: ['на русском языке'] },
    { label: 'Не заламинирован',             needles: ['не заламинирован'] },
    { label: '5 рабочих дней',               needles: ['5 полных р.д.', '5 рабочих дней', '5 полных рабочих дней'] },
    { label: 'Запись не требуется',          needles: ['запись на подачу не требуется', 'запись не требуется'] },
    { label: 'Сбербанк оплата',              needles: ['сбербанк'] },
    { label: 'Банковский чек',               needles: ['банковский чек'] },
    { label: 'Личный паспорт заявителя',     needles: ['личный паспорт заявителя'] },
  ];

  let passed = 0, failed = 0;
  for (const c of checks) {
    const ok = c.needles.every((n) => text.includes(n.toLowerCase()));
    console.log(`  ${ok ? '✓' : '✗'} ${c.label}${ok ? '' : '   (missing: ' + c.needles.filter(n => !text.includes(n.toLowerCase())).join(', ') + ')'}`);
    ok ? passed++ : failed++;
  }
  console.log(`\n${passed}/${passed + failed} facts verified`);
}
main().catch(e=>{console.error(e);process.exit(1);}).finally(()=>p.$disconnect());
