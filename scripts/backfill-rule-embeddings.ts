import { Prisma } from '@prisma/client';
import prisma from '../src/lib/db';
import { generateEmbeddings } from '../src/lib/openai';
import { ruleEmbeddingText } from '../src/lib/knowledge/rule-embedding';

/**
 * Досчитывает семантические векторы правилам, созданным до появления поля
 * `Rule.embedding` (translation-wmq).
 *
 * ЗАЧЕМ. Уверенность ответа считалась только по семантике чанков и совпадению
 * с Q&A — правила не весили ничего. Измерено на изолированной песочнице:
 * вопрос находил 6 релевантных правил и 0 чанков, получал confidence 0.00 и
 * уходил клиенту как «уточню у коллеги» при том, что ответ в базе был. Пока
 * у старых правил нет вектора, они продолжают весить ноль — то есть фикс без
 * этого скрипта работает только на заново загруженных документах.
 *
 * БЕЗОПАСНОСТЬ. Скрипт ТОЛЬКО дописывает `embedding` тем правилам, у которых
 * его нет. Он не меняет ни текст, ни статус, ни аудиторию, ни домены — то
 * есть не может испортить выдачу: правило без вектора и до, и после остаётся
 * тем же правилом, просто начинает участвовать в оценке уверенности.
 * Прерванный прогон безопасно продолжить — уже обработанные пропускаются.
 *
 *   railway run npx tsx scripts/backfill-rule-embeddings.ts --dry-run
 *   railway run npx tsx scripts/backfill-rule-embeddings.ts
 */
const BATCH_SIZE = 50;

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const total = await prisma.rule.count();
  const missing = await prisma.rule.count({ where: { embedding: { equals: Prisma.DbNull } } });

  console.log(`Правил всего: ${total}`);
  console.log(`Без вектора:  ${missing}`);

  if (missing === 0) {
    console.log('Досчитывать нечего.');
    return;
  }
  if (dryRun) {
    console.log(`--dry-run: было бы посчитано ${missing} векторов (${Math.ceil(missing / BATCH_SIZE)} батчей).`);
    return;
  }

  let processed = 0;
  let failed = 0;

  for (;;) {
    const batch = await prisma.rule.findMany({
      where: { embedding: { equals: Prisma.DbNull } },
      select: { id: true, title: true, body: true },
      take: BATCH_SIZE,
    });
    if (batch.length === 0) break;

    let vectors: number[][];
    try {
      vectors = await generateEmbeddings(batch.map((r) => ruleEmbeddingText(r.title, r.body)));
    } catch (error) {
      // Батч не удался — не бросаем весь прогон: остальные правила ни при чём.
      // Но и не крутимся вечно на одном и том же батче: выходим, чтобы
      // причина отказа была видна человеку, а не утонула в ретраях.
      console.error(`Батч из ${batch.length} правил не посчитался, останавливаюсь:`, error);
      failed += batch.length;
      break;
    }

    for (let i = 0; i < batch.length; i++) {
      await prisma.rule.update({
        where: { id: batch[i].id },
        data: { embedding: vectors[i] },
      });
      processed++;
    }
    console.log(`  посчитано ${processed}/${missing}`);
  }

  console.log(`\nГотово. Досчитано: ${processed}. Не удалось: ${failed}.`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
