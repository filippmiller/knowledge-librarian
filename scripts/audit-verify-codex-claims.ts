/**
 * Проверка утверждений кросс-аудита Codex. Каждое либо подтверждается
 * измерением, либо опровергается.
 */
import prisma from '../src/lib/db';
import { normalizeQuestionForCache, storeCachedAnswer, getCachedAnswer, clearAnswerCache } from '../src/lib/ai/answer-cache';

async function main() {
  // --- Претензия 1: «107 безымянных правил» посчитано без учёта title ---
  const doc = await prisma.document.findFirst({
    where: { title: { contains: 'Прайс на перевод и заверение-010126' } },
    select: { id: true },
  });
  if (doc) {
    const all = await prisma.rule.findMany({
      where: { documentId: doc.id, status: 'ACTIVE', body: { contains: 'Стандарт', mode: 'insensitive' } },
      select: { ruleCode: true, title: true, body: true },
    });
    const LANG = /(английск|арабск|венгерск|вьетнамск|немецк|французск|испанск|итальянск|китайск|японск|турецк|польск|чешск|финск|болгарск|сербск|греческ|иврит|корейск|латышск|литовск|эстонск|грузинск|армянск|азербайджанск|казахск|узбекск|таджикск|киргизск|молдавск|румынск|украинск|белорусск|абхазск|нидерландск|шведск|норвежск|датск|португальск|словацк|словенск|хорватск|персидск|хинди|урду|тайск|индонезийск|монгольск|туркменск|латинск|макед|каталон|малайск|черногорск|дари|пушту)/i;

    const bodyOnly = all.filter((r) => !LANG.test(r.body) && !/категори/i.test(r.body));
    const titleAndBody = all.filter((r) => {
      const combined = `${r.title ?? ''} ${r.body}`;
      return !LANG.test(combined) && !/категори/i.test(combined);
    });

    console.log('=== Претензия 1: считать надо по title + body ===');
    console.log(`ценовых правил со словом «Стандарт»: ${all.length}`);
    console.log(`без языка/категории в body:          ${bodyOnly.length}   (моя цифра)`);
    console.log(`без языка/категории в title + body:  ${titleAndBody.length}   (цифра Codex)`);
    console.log('\nОбразцы title у правил, которые я считал безымянными:');
    for (const r of bodyOnly.slice(0, 8)) {
      console.log(`  [${r.ruleCode}] title="${r.title ?? '(нет)'}"`);
    }
  }

  // --- Претензия 2: нечёткий кэш теряет отрицание «не» ---
  console.log('\n=== Претензия 2: кэш стирает «не» (термы короче 3 символов) ===');
  const q1 = 'Нужен ли оригинал для нотариального заверения?';
  const q2 = 'Не нужен ли оригинал для нотариального заверения?';
  console.log(`нормализация 1: "${normalizeQuestionForCache(q1)}"`);
  console.log(`нормализация 2: "${normalizeQuestionForCache(q2)}"`);

  clearAnswerCache();
  const fake = {
    answer: 'ОТВЕТ НА ПЕРВЫЙ ВОПРОС',
    confidence: 0.8,
    confidenceLevel: 'high' as const,
    needsClarification: false,
    citations: [],
    domainsUsed: [],
    queryAnalysis: { originalQuery: q1, expandedQueries: [], extractedEntities: { dates: [], prices: [], documentTypes: [], services: [] }, isAmbiguous: false },
    answerSource: 'knowledge_base' as const,
    requiresHumanReview: false,
  };
  const stored = storeCachedAnswer('client', q1, fake as never);
  const hit = getCachedAnswer('client', q2);
  console.log(`записано в кэш: ${stored}`);
  console.log(`вопрос с «Не» получил чужой ответ: ${hit ? `ДА (${hit.cacheHit}) → "${hit.result.answer}"` : 'нет'}`);

  // Ещё одна пара с противоположным смыслом.
  const q3 = 'Можно ли апостилировать справку в Санкт-Петербурге?';
  const q4 = 'Можно ли не апостилировать справку в Санкт-Петербурге?';
  clearAnswerCache();
  storeCachedAnswer('client', q3, { ...fake, answer: 'ОТВЕТ ПРО МОЖНО' } as never);
  const hit2 = getCachedAnswer('client', q4);
  console.log(`\n"${q3}"\n"${q4}"`);
  console.log(`второй получил ответ первого: ${hit2 ? `ДА (${hit2.cacheHit})` : 'нет'}`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
