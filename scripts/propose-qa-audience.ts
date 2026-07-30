/**
 * Предложение аудитории для операторских Q&A-пар.
 *
 * Пары с authority-тегами — это ответы, которые оператор утвердил как
 * эталонные. Многие из них писались клиенту и по смыслу клиентские, но все
 * получили безопасный дефолт INTERNAL_ONLY при появлении колонки аудитории.
 * Из-за этого канонический override для клиентского контура не работает:
 * на «Какие услуги оказывает агентство?» внутренний контур отвечает с
 * уверенностью 100%, а клиентский — «в базе знаний нет данных».
 *
 * Решение принимается не по названию, а по содержимому: каждая пара
 * прогоняется через ту же сигнализацию, что защищает клиентские ответы.
 * Прошла — можно предлагать клиентской; сработала — остаётся внутренней и
 * попадает в список на разбор оператором.
 *
 * Запуск:
 *   railway run npx tsx scripts/propose-qa-audience.ts
 *   railway run npx tsx scripts/propose-qa-audience.ts --apply
 */
import { KnowledgeAudience, PrismaClient } from '@prisma/client';
import { checkClientSafety } from '../src/lib/knowledge/audience';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

const AUTHORITY_TAGS = ['VOICE_ANSWER_AUTHORITY', 'HISTORICAL_ANSWER_AUTHORITY'];
const AUTHORITY_ORIGINS = ['voice-operator', 'historical-operator'];

function hasAuthority(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const value = metadata as Record<string, unknown>;
  return (
    AUTHORITY_TAGS.includes(String(value.authorityTag)) ||
    AUTHORITY_ORIGINS.includes(String(value.origin))
  );
}

async function main(): Promise<void> {
  const all = await prisma.qAPair.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, question: true, answer: true, audience: true, metadata: true },
    orderBy: { createdAt: 'desc' },
  });

  const authority = all.filter((qa) => hasAuthority(qa.metadata));
  console.log(`ACTIVE Q&A-пар всего: ${all.length}`);
  console.log(`из них операторских (authority): ${authority.length}`);
  console.log(
    `уже клиентских: ${authority.filter((qa) => qa.audience === KnowledgeAudience.CLIENT_SAFE).length}`
  );
  console.log('');

  const safe: typeof authority = [];
  const unsafe: Array<{ qa: (typeof authority)[number]; violations: string[] }> = [];

  for (const qa of authority) {
    const verdict = checkClientSafety(qa.answer);
    if (verdict.safe) safe.push(qa);
    else unsafe.push({ qa, violations: verdict.violations });
  }

  console.log(`=== ПРОШЛИ проверку — можно клиентскими (${safe.length}) ===`);
  for (const qa of safe) {
    console.log(`  · ${qa.question.replace(/\s+/g, ' ').slice(0, 110)}`);
  }

  console.log('');
  console.log(`=== НЕ ПРОШЛИ — остаются внутренними, нужен разбор (${unsafe.length}) ===`);
  for (const { qa, violations } of unsafe) {
    console.log(`  ⚠ ${qa.question.replace(/\s+/g, ' ').slice(0, 90)}`);
    console.log(`     причина: ${violations.join(', ')}`);
    console.log(`     ответ: ${qa.answer.replace(/\s+/g, ' ').slice(0, 160)}`);
  }

  if (apply) {
    const toUpdate = safe.filter((qa) => qa.audience !== KnowledgeAudience.CLIENT_SAFE);
    const result = await prisma.qAPair.updateMany({
      where: { id: { in: toUpdate.map((qa) => qa.id) } },
      data: { audience: KnowledgeAudience.CLIENT_SAFE },
    });
    console.log(`\nПрименено: ${result.count} пар переведены в CLIENT_SAFE`);
  } else {
    console.log('\nЭто предпросмотр. Для применения добавьте --apply');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
