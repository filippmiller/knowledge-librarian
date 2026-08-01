/**
 * Сторож устаревших цен: чувствительность и молчание.
 *
 * Замер на реальных ответах дал ноль тревог (`scripts/audit-stale-price-fp.ts`).
 * Само по себе это ничего не значит: контроль, который не способен сработать
 * никогда, тоже даёт ноль. Возражение Codex принято — здесь измеряется, ловит
 * ли сторож подложенную ошибку.
 *
 * Метод: по каждой услуге сетки строится предложение с ЕЁ ЖЕ ценой (тревоги
 * быть не должно) и с заведомо чужой (тревога обязана быть). Предложения
 * синтетические, зато покрывают весь прайс, а не те шесть сумм, до которых
 * контроль дотянулся на сохранённых ответах.
 *
 * Отдельно закреплён дефект, найденный теневым прогоном: питерский апостиль
 * не должен сверяться с московской строкой только потому, что «МЮ» и «МО»
 * короче порога длины.
 *
 * Запуск: railway run npx tsx scripts/verify-stale-price.ts
 */
import { getTariffs } from '../src/lib/knowledge/tariff-store';
import { checkStalePrice } from '../src/lib/knowledge/stale-price-check';
import type { TariffRecord } from '../src/lib/knowledge/tariffs';
import prisma from '../src/lib/db';

let checks = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'ok  ' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Сумма, которой заведомо нет ни у одной услуги прайса. */
function alienAmount(all: TariffRecord[]): number {
  const used = new Set(all.flatMap((t) => [t.amount, t.baseFeeAmount].filter((x): x is number => x !== null)));
  let candidate = 1234;
  while (used.has(candidate)) candidate += 7;
  return candidate;
}

async function main() {
  const tariffs = await getTariffs('client');
  if (tariffs.length === 0) {
    console.error('Сетка пуста — проверять нечего. Проверь DATABASE_URL.');
    process.exit(1);
  }

  const alien = alienAmount(tariffs);

  // Только фиксированные цены: у «от 60 руб.» и процентов сверять нечем, и
  // сторож их пропускает намеренно.
  const fixed = tariffs.filter((t) => t.amountKind === 'FIXED' && t.amount !== null && t.section !== 'TRANSLATION');
  const byName = new Map<string, TariffRecord>();
  for (const t of fixed) if (!byName.has(t.serviceName)) byName.set(t.serviceName, t);

  console.log(`══ ЧУВСТВИТЕЛЬНОСТЬ: подложенная чужая сумма (${alien} ₽) ══\n`);
  let caught = 0;
  let reached = 0;
  const blind: string[] = [];
  for (const [name, t] of byName) {
    const sentence = `Услуга «${name}» стоит ${alien} рублей.`;
    const verdict = checkStalePrice(sentence, tariffs);
    if (verdict.checked === 0) {
      blind.push(name);
      continue;
    }
    reached += 1;
    if (!verdict.ok) caught += 1;
    else blind.push(`${name} (сумма проверена, но тревоги нет)`);
  }
  check(
    `подложенная чужая сумма ловится там, куда контроль дотягивается`,
    reached > 0 && caught === reached,
    `дотянулся до ${reached} услуг из ${byName.size}, поймал ${caught}`
  );

  console.log(`\nуслуг с фиксированной ценой: ${byName.size}`);
  console.log(`контроль их видит:            ${reached}`);
  console.log(`СЛЕПАЯ ЗОНА:                  ${blind.length}`);

  console.log(`\n══ МОЛЧАНИЕ: собственная цена услуги тревоги не даёт ══\n`);
  let falseAlarms = 0;
  for (const [name, t] of byName) {
    const sentence = `Услуга «${name}» стоит ${t.amount} рублей.`;
    if (!checkStalePrice(sentence, tariffs).ok) {
      falseAlarms += 1;
      console.log(`  ЛОЖНАЯ ТРЕВОГА: «${name}» при собственной цене ${t.amount} ₽`);
    }
  }
  check('на собственной цене услуги контроль молчит', falseAlarms === 0, `ложных тревог ${falseAlarms}`);

  console.log(`\n══ ДЕФЕКТ ТЕНЕВОГО ПРОГОНА: регион и орган короче порога ══\n`);

  // Ответ про питерский апостиль. «Апостиль МЮ МО (1 р.д.)» стоит 17 000 ₽, и
  // пока «МЮ» и «МО» были невидимы, эта московская строка оказывалась
  // единственной подходящей — контроль объявлял 16 000 ₽ устаревшей ценой,
  // сверив Петербург с Московской областью.
  const spb = 'Если нужен апостиль, то 16 000 рублей и 3–5 рабочих дней.';
  const verdictSpb = checkStalePrice(spb, tariffs);
  check(
    'апостиль без указания органа и региона не сверяется с московской строкой',
    verdictSpb.ok,
    verdictSpb.ok ? '' : `тревога: ${verdictSpb.findings.map((f) => `${f.amount} при «${f.serviceHint}»`).join('; ')}`
  );

  console.log(`\n══ КОЛИЧЕСТВО: цена за единицу, умноженная на число единиц ══\n`);

  // Предсказано аудитом Codex, воспроизведено запуском: «Сканирование
  // обойдётся в 200 рублей за 5 страниц» — верный ответ при цене 40 ₽ за
  // страницу, а сторож объявлял 200 ₽ устаревшей ценой.
  const multiplied = 'Сканирование обойдётся в 200 рублей за 5 страниц.';
  const vMul = checkStalePrice(multiplied, tariffs);
  check(
    'сумма за названное количество единиц тревоги не даёт',
    vMul.ok,
    vMul.ok ? '' : vMul.findings.map((f) => `${f.amount} при «${f.serviceHint}»`).join('; ')
  );

  // Обратная сторона послабления: без названного количества кратность остаётся
  // ошибкой, иначе двойной тариф проходил бы молча.
  const doubled = 'Сканирование стоит 200 рублей.';
  check('кратная сумма БЕЗ количества по-прежнему ловится', !checkStalePrice(doubled, tariffs).ok);

  console.log(`\n══ ЕДИНИЦА РЯДОМ С ЧИСЛОМ ══\n`);

  // Найдено на сохранённых ответах бота: в предложении названо заверение
  // штампом БП (250 ₽ за документ), а сумма 530 ₽ стоит с единицей «за
  // условную страницу» — это цена перевода, а не заверения.
  const twoServices =
    'Перевод с английского на русский в стандартном режиме стоит 530 рублей за условную страницу, а заверение перевода подписью переводчика и штампом БП оплачивается отдельно.';
  const vTwo = checkStalePrice(twoServices, tariffs);
  check(
    'цена с чужой единицей не приписывается названной услуге',
    vTwo.ok,
    vTwo.ok ? '' : vTwo.findings.map((f) => `${f.amount} при «${f.serviceHint}»`).join('; ')
  );

  // Обратная сторона: с СВОЕЙ единицей ошибка обязана ловиться.
  const ownUnit = 'Сканирование стоит 55 рублей за страницу.';
  check('ошибка при совпадающей единице по-прежнему ловится', !checkStalePrice(ownUnit, tariffs).ok);

  console.log(`\n══ СИНОНИМЫ: перекрытие между базовым и срочным тарифом ══\n`);

  // Синоним базового тарифа («заверить перевод у нотариуса») — подмножество
  // слов синонима срочного («срочно заверить перевод у нотариуса»). Пробовал
  // разрешать по специфичности (самое частное совпадение побеждает, как в
  // `tariff-lookup.ts`, по предложению ревью CodeRabbit) — на синтетическом
  // примере чинит именно этот случай, но на живом корпусе ломает другой:
  // предложение с ДВУМЯ ценами для ДВУХ вариантов («срочное заверение — 1250,
  // или 1450 если двуязычное») отдаёт «самое частное» не той сумме, и верный
  // ответ получает новую ложную тревогу (`scripts/probe-all-false-alarms.ts`,
  // 4→5, причём новая — на верном ответе). Молчание здесь — сознательный
  // выбор дешевле лечения: полнота на этом узком случае стоит новых ложных
  // тревог на более частом.
  const urgentByVerb = 'Срочно заверить перевод у нотариуса — 1000 рублей.';
  check(
    'перекрывающиеся синонимы базового и срочного тарифа дают молчание, не угадывание',
    checkStalePrice(urgentByVerb, tariffs).checked === 0
  );

  // Настоящая неоднозначность — две РАЗНЫЕ услуги без отношения подмножества —
  // тоже должна молчать, а не выбирать наугад. Сканирование и ксерокопия —
  // обе однословные, совпадают независимо друг от друга, и ни одна не
  // является подмножеством слов другой.
  const trueAmbiguity = 'Сканирование и ксерокопия документа вместе обойдутся в 999999 рублей.';
  check(
    'две разные услуги в одном предложении дают молчание',
    checkStalePrice(trueAmbiguity, tariffs).checked === 0
  );

  console.log(`\nпроверок: ${checks}, провалено: ${failed}`);
  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
