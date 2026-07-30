/**
 * Разметка документов по аудитории.
 *
 * Клиентским объявляется только то, что можно показать заказчику: клиентские
 * прайсы, публичная оферта, требования к документам и страновые списки.
 * Всё остальное остаётся внутренним — инструкции по подаче в госорганы,
 * внутренний и партнёрский прайсы, чек-листы и обучающие материалы.
 *
 * Принцип при сомнении — оставить внутренним: цена ошибки в эту сторону —
 * менее полный клиентский ответ, а в обратную — утечка внутренних данных или
 * отправка клиента делать услугу самостоятельно.
 *
 * Запуск (сначала посмотреть, что изменится):
 *   railway run npx tsx scripts/set-audience.ts
 *   railway run npx tsx scripts/set-audience.ts --apply
 */
import { KnowledgeAudience, PrismaClient } from '@prisma/client';
import { setDocumentAudience } from '../src/lib/knowledge/audience';

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

/**
 * Документы, которые можно показывать клиенту. Проверены на отсутствие
 * себестоимости, партнёрских цен и инструкций по подаче в госорганы.
 */
const CLIENT_SAFE_TITLES = [
  // Действующие клиентские цены (01.01.2026).
  'Прайс клиентский апостиль, истребование и КЛ СПб и МСК 010126',
  'Прайс на перевод и заверение-010126',
  // Публичный договор — по определению предназначен клиенту.
  'Публичная оферта',
  // Страновые требования: это факты о мире, они не уводят клиента никуда,
  // а наоборот объясняют, зачем нужна услуга.
  'Список_стран_для_которых_ТРЕБУЕТСЯ_КЛ',
  'Страны,_для_которых_не_нужен_апостиль_МЮ_2023',
  'Апостиль_страны_кому_на_оригинал_кому_двойной',
  // Требования к самому документу: клиент должен их знать, чтобы прислать
  // пригодный документ.
  'Ручное правило R-332: Требования к документу на НКО и на Апостиль',
  'Ручное правило R-333: Требования к нотариальному переводу',
];

async function main(): Promise<void> {
  const documents = await prisma.document.findMany({
    select: { id: true, title: true, audience: true, _count: { select: { rules: true } } },
    orderBy: { title: 'asc' },
  });

  const wanted = new Map<string, KnowledgeAudience>();
  for (const doc of documents) {
    wanted.set(
      doc.id,
      CLIENT_SAFE_TITLES.includes(doc.title)
        ? KnowledgeAudience.CLIENT_SAFE
        : KnowledgeAudience.INTERNAL_ONLY
    );
  }

  const missing = CLIENT_SAFE_TITLES.filter((t) => !documents.some((d) => d.title === t));
  if (missing.length > 0) {
    console.log('НЕ НАЙДЕНЫ в базе (проверьте название):');
    for (const t of missing) console.log(`  · ${t}`);
    console.log('');
  }

  let changed = 0;
  let clientRules = 0;
  for (const doc of documents) {
    const target = wanted.get(doc.id)!;
    if (target === KnowledgeAudience.CLIENT_SAFE) clientRules += doc._count.rules;
    if (doc.audience === target) continue;
    changed++;
    console.log(`${doc.audience} → ${target}  ${doc.title} (правил: ${doc._count.rules})`);
    if (apply) {
      const counts = await setDocumentAudience(doc.id, target);
      console.log(
        `    применено: правил ${counts.rules}, Q&A ${counts.qaPairs}, чанков ${counts.chunks}`
      );
    }
  }

  console.log('');
  console.log(`документов всего: ${documents.length}`);
  console.log(`клиентских после разметки: ${CLIENT_SAFE_TITLES.length - missing.length}`);
  console.log(`правил в клиентском контуре: ${clientRules}`);
  console.log(`требуют изменения: ${changed}`);
  if (!apply) console.log('\nЭто предпросмотр. Для применения добавьте --apply');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
