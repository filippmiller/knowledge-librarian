/**
 * Извлечены ли из прайса на перевод те правила, без которых цену назвать нельзя:
 * определение категорий сложности и правило «1 категория — только С языка».
 */
import prisma from '../src/lib/db';

const PROBES: Array<{ label: string; term: string }> = [
  { label: 'правило «1 категория только с иностранного»', term: 'только с иностранн' },
  { label: 'правило «на язык — со 2 категории»', term: 'начиная со 2' },
  { label: 'определение: 1 категория — личные документы', term: 'личные документ' },
  { label: 'определение: 2 категория — простые тексты', term: 'простые текст' },
  { label: 'определение: 3 категория — узкоспециализированные', term: 'узкоспециализированн' },
  { label: 'паспорт как документ 1 категории', term: 'паспорт' },
  { label: 'наценка за нечёткий текст', term: 'нечетк' },
  { label: 'минимальный объём 1 у.с.', term: 'минимальный объем' },
];

async function main() {
  const doc = await prisma.document.findFirst({
    where: { title: { contains: 'Прайс на перевод и заверение-010126' } },
    select: { id: true, title: true },
  });
  if (!doc) {
    console.log('документ не найден');
    return;
  }
  console.log(`Документ: ${doc.title}\n`);

  for (const p of PROBES) {
    const rules = await prisma.rule.findMany({
      where: { documentId: doc.id, status: 'ACTIVE', body: { contains: p.term, mode: 'insensitive' } },
      select: { ruleCode: true, body: true },
      take: 3,
    });
    const mark = rules.length > 0 ? 'ЕСТЬ' : 'НЕТ';
    console.log(`[${mark}] ${p.label} — правил: ${rules.length}`);
    for (const r of rules) {
      console.log(`      [${r.ruleCode}] ${r.body.slice(0, 200).replace(/\s+/g, ' ')}`);
    }
  }

  // Сколько ценовых правил вообще не называют язык.
  const all = await prisma.rule.findMany({
    where: { documentId: doc.id, status: 'ACTIVE', body: { contains: 'Стандарт', mode: 'insensitive' } },
    select: { ruleCode: true, body: true },
  });
  const LANG = /(английск|арабск|венгерск|вьетнамск|немецк|французск|испанск|итальянск|китайск|японск|турецк|польск|чешск|финск|болгарск|сербск|греческ|иврит|корейск|латышск|литовск|эстонск|грузинск|армянск|азербайджанск|казахск|узбекск|таджикск|киргизск|молдавск|румынск|украинск|белорусск|абхазск|нидерландск|шведск|норвежск|датск|португальск|словацк|словенск|хорватск|персидск|хинди|урду|тайск|индонезийск|монгольск|туркменск|латинск|макед)/i;
  const anonymous = all.filter((r) => !LANG.test(r.body) && !/категори/i.test(r.body));
  console.log(`\n=== Ценовые правила со словом «Стандарт»: ${all.length} ===`);
  console.log(`из них НЕ называют ни язык, ни категорию: ${anonymous.length}`);
  for (const a of anonymous.slice(0, 5)) {
    console.log(`      [${a.ruleCode}] ${a.body.slice(0, 160).replace(/\s+/g, ' ')}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
