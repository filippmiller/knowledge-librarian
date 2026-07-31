/**
 * Отбор строк прайса в контекст ответа.
 *
 * Проверка отвечает на один вопрос: попадает ли нужный раздел прайса в промпт,
 * когда клиент спрашивает о цене СВОИМИ словами, а не словами прайса.
 *
 * Повод — живой провал: «Сколько стоит заверение в Торгово-промышленной
 * палате?» не находил строку «ТПП СПб (от 2-х дней)», потому что общих слов у
 * вопроса и названия ноль, а поле синонимов не заполнено ни у одной из 62
 * услуг. Бот ответил «в базе знаний не указано» при цене 6000 ₽ в прайсе.
 *
 * Запуск: railway run npx tsx scripts/verify-tariff-context.ts
 */
import { getTariffs } from '../src/lib/knowledge/tariff-store';
import { buildTariffContext } from '../src/lib/knowledge/tariff-context';
import type { TariffSectionKey } from '../src/lib/knowledge/tariffs';
import prisma from '../src/lib/db';

let checks = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'ok  ' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Каждый раздел прайса обязан находиться живой клиентской формулировкой. */
const SECTION_PROBES: Array<{ section: TariffSectionKey; question: string }> = [
  { section: 'CERTIFICATION', question: 'Сколько стоит нотариальное заверение перевода?' },
  { section: 'CERTIFICATION', question: 'Сколько стоит сканирование готовых документов?' },
  { section: 'APOSTILLE_SPB', question: 'Сколько стоит апостиль в Санкт-Петербурге?' },
  { section: 'APOSTILLE_MOSCOW', question: 'Сколько стоит апостиль в Москве?' },
  { section: 'APOSTILLE_EDUCATION', question: 'Сколько стоит апостиль на диплом?' },
  { section: 'CONSULAR_LEGALIZATION', question: 'Сколько стоит консульская легализация для Иордании?' },
  { section: 'CHAMBER_OF_COMMERCE', question: 'Сколько стоит заверение в Торгово-промышленной палате?' },
  { section: 'CHAMBER_OF_COMMERCE', question: 'Сколько стоит ТПП?' },
  { section: 'VITAL_RECORDS_SPB', question: 'Сколько стоит истребование свидетельства о рождении?' },
  { section: 'CRIMINAL_RECORD', question: 'Сколько стоит справка об отсутствии судимости за 3 рабочих дня?' },
  { section: 'NOSTRIFICATION', question: 'Сколько стоит нострификация диплома?' },
];

async function main() {
  const tariffs = await getTariffs('client');
  if (tariffs.length === 0) {
    console.error('Сетка пуста — проверять нечего. Проверь DATABASE_URL.');
    process.exit(1);
  }

  console.log('══ КАЖДЫЙ РАЗДЕЛ НАХОДИТСЯ КЛИЕНТСКОЙ ФОРМУЛИРОВКОЙ ══\n');
  for (const probe of SECTION_PROBES) {
    const ctx = buildTariffContext(probe.question, tariffs);
    check(
      `${probe.section.padEnd(26)} | ${probe.question.slice(0, 52)}`,
      ctx.sections.includes(probe.section),
      ctx.count === 0 ? 'прайс не подан вовсе' : `подано ${ctx.count} строк: ${ctx.sections.join(', ')}`
    );
  }

  console.log('\n══ ГРАНИЦЫ ══\n');

  check(
    'вопрос не про деньги — прайс в промпт не идёт',
    buildTariffContext('К чему подшивается нотариальный перевод?', tariffs).count === 0
  );

  check(
    'матрица перевода не подаётся без названного языка',
    !buildTariffContext('Сколько стоит перевод документа?', tariffs).sections.includes('TRANSLATION')
  );

  const withLanguage = buildTariffContext('Сколько стоит перевод с английского языка?', tariffs);
  check(
    'матрица подаётся, когда язык назван',
    withLanguage.sections.includes('TRANSLATION'),
    `подано ${withLanguage.count} строк`
  );

  // Потолок нужен не для красоты: без него один вопрос про английский положил
  // бы в промпт полторы тысячи строк и вытеснил всё остальное.
  const all = buildTariffContext('Сколько стоит перевод с английского и апостиль и заверение?', tariffs);
  check('потолок строк соблюдается', all.count <= 70, `подано ${all.count}`);

  console.log(`\nпроверок: ${checks}, провалено: ${failed}`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
