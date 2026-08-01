/**
 * Сколько строк тарифной сетки сводятся к настолько общим стемам, что почти
 * ЛЮБОЕ предложение с деньгами их наберёт. Найдено на живом примере: тариф
 * «Стандартный срок (45 рабочих дней) (...)» даёт стемы ["стандартн","срок"] —
 * и «срок» подстрокой сидит в «сроки», «сроков», так что предложение вообще
 * без этой услуги в виду совпадает.
 *
 * Запуск: railway run npx tsx scripts/probe-degenerate-names.ts
 */
import { getTariffs } from '../src/lib/knowledge/tariff-store';
import { serviceTerms } from '../src/lib/knowledge/service-terms';
import prisma from '../src/lib/db';

async function main() {
  const tariffs = await getTariffs('client');
  const byStems = new Map<string, typeof tariffs>();

  for (const t of tariffs) {
    const stems = serviceTerms(t.serviceName);
    // Риск — когда стемов всего 1-2: короткое название почти без индивидуальных
    // слов совпадёт с чужим предложением, где эти же общие слова встретились
    // случайно («срок» — подстрока «сроки», «сроков»).
    if (stems.length <= 2) {
      const key = stems.join('+');
      const list = byStems.get(key) ?? [];
      list.push(t);
      byStems.set(key, list);
    }
  }

  const risky = [...byStems.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log(`групп с потенциально общими стемами: ${risky.length}`);
  for (const [key, rows] of risky.slice(0, 15)) {
    console.log(`\n«${key}» — ${rows.length} строк(и):`);
    for (const r of rows.slice(0, 4)) {
      console.log(`  · ${r.serviceName} (${r.amount} ₽, раздел ${r.section})`);
    }
    if (rows.length > 4) console.log(`  … и ещё ${rows.length - 4}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
