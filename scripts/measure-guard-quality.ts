/**
 * Полезен ли контроль: ловит ли он подложенный дефект и молчит ли на верном.
 *
 * Частота срабатывания не измеряет ничего. Контроль, сработавший сто раз, может
 * быть и лучшей защитой системы, и худшим её тормозом — по частоте это
 * неразличимо. Различают два числа, и оба нужны сразу:
 *
 *   · НАХОДИТ  — доля подложенных дефектов, которые контроль поймал;
 *   · МОЛЧИТ   — доля ВЕРНЫХ ответов, на которых он НЕ сработал.
 *
 * Без второго числа контроль — это рандомизированный эскалатор: поймать всё
 * можно, объявив ошибкой каждый ответ. Требование измерять обе стороны
 * поставлено независимым аудитом Kimi K3.
 *
 * Материал — 156 реальных ответов бота из замера автономности, а не выдуманные
 * предложения. В них подмешиваются дефекты ровно того класса, ради которого
 * контроль написан:
 *
 *   · цена подменяется ценой ДРУГОЙ услуги (та самая приписка, ради которой
 *     писан `certification-price`);
 *   · цена подменяется суммой, которой в прайсе нет вовсе (устаревшая цена,
 *     ради которой писан `stale-price-check`);
 *   · в ответ дописывается адрес и график госоргана (утечка клиентского
 *     контура, ради которой писан `client-safety`).
 *
 * Измеряются только ДЕТЕРМИНИРОВАННЫЕ контроли. Модельные (проверка связности)
 * сюда не входят честно: они стохастичны, и один прогон не отличит контроль от
 * монетки — для них нужен отдельный замер с повторами.
 *
 * Запуск: railway run npx tsx scripts/measure-guard-quality.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { checkCertificationPriceAttribution } from '../src/lib/knowledge/certification-price';
import { checkStalePrice } from '../src/lib/knowledge/stale-price-check';
import { checkClientSafety } from '../src/lib/knowledge/audience';
import { getTariffs } from '../src/lib/knowledge/tariff-store';
import type { TariffRecord } from '../src/lib/knowledge/tariffs';
import prisma from '../src/lib/db';

const MONEY = /(\d[\d\s ]{2,})\s*(?:₽|руб)/u;

function loadAnswers(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of readdirSync('docs/bot-audit').filter((x) => x.startsWith('.autonomy-150-results'))) {
    for (const line of readFileSync(`docs/bot-audit/${f}`, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { answer?: string };
        if (!r.answer) continue;
        const key = r.answer.slice(0, 90);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(r.answer);
      } catch {
        /* оборванная строка */
      }
    }
  }
  return out;
}

const pct = (a: number, b: number) => (b === 0 ? '—' : `${Math.round((a / b) * 100)}%`);

interface GuardResult {
  name: string;
  /** Верные ответы, на которых контроль промолчал. */
  quietOnClean: number;
  cleanTotal: number;
  /** Подложенные дефекты, которые контроль поймал. */
  caught: number;
  injectedTotal: number;
  /** Верные ответы, на которых он сработал зря. */
  falseAlarms: string[];
  /** Подложенные дефекты, которые он пропустил. */
  missed: string[];
}

function measure(
  name: string,
  clean: string[],
  inject: (answer: string) => string | null,
  fires: (answer: string) => boolean
): GuardResult {
  const res: GuardResult = {
    name,
    quietOnClean: 0,
    cleanTotal: 0,
    caught: 0,
    injectedTotal: 0,
    falseAlarms: [],
    missed: [],
  };
  for (const answer of clean) {
    res.cleanTotal += 1;
    if (fires(answer)) res.falseAlarms.push(answer.slice(0, 110).replace(/\n/g, ' '));
    else res.quietOnClean += 1;

    const spoiled = inject(answer);
    if (spoiled === null) continue;
    res.injectedTotal += 1;
    if (fires(spoiled)) res.caught += 1;
    else res.missed.push(spoiled.slice(0, 110).replace(/\n/g, ' '));
  }
  return res;
}

function print(r: GuardResult): void {
  console.log(`\n── ${r.name}`);
  console.log(`   МОЛЧИТ на верных:   ${r.quietOnClean} из ${r.cleanTotal} (${pct(r.quietOnClean, r.cleanTotal)}) · ложных тревог ${r.falseAlarms.length}`);
  console.log(`   НАХОДИТ подложенное: ${r.caught} из ${r.injectedTotal} (${pct(r.caught, r.injectedTotal)}) · пропущено ${r.missed.length}`);
  if (r.injectedTotal === 0) {
    console.log('   ⚠ дефект подмешать было некуда — контроль этим замером НЕ проверен');
  }
  for (const f of r.falseAlarms.slice(0, 3)) console.log(`   ложная тревога: ${f}`);
  for (const m of r.missed.slice(0, 3)) console.log(`   пропущено:      ${m}`);
}

async function main() {
  const answers = loadAnswers();
  const tariffs = await getTariffs('client');
  console.log(`\n=== КАЧЕСТВО ДЕТЕРМИНИРОВАННЫХ КОНТРОЛЕЙ ===`);
  console.log(`реальных ответов бота: ${answers.length} · строк прайса: ${tariffs.length}`);

  // Сумма, которой нет ни у одной услуги: подмена ею изображает устаревшую цену.
  const used = new Set(tariffs.map((t) => t.amount).filter((x): x is number => x !== null));
  let alien = 1234;
  while (used.has(alien)) alien += 7;

  print(
    measure(
      'Приписка цены (certification-price)',
      answers,
      // Цена подменяется ценой ДРУГОЙ услуги заверения: 1100 ₽/док против
      // 260 ₽/стр — ровно тот дефект, с которого начался модуль.
      (a) => (MONEY.test(a) ? a.replace(MONEY, '260 руб') : null),
      (a) => !checkCertificationPriceAttribution(a).consistent
    )
  );

  print(
    measure(
      'Устаревшая цена (stale-price-check)',
      answers,
      (a) => (MONEY.test(a) ? a.replace(MONEY, `${alien} руб`) : null),
      (a) => !checkStalePrice(a, tariffs).ok
    )
  );

  print(
    measure(
      'Утечка клиентского контура (client-safety)',
      answers,
      // Адрес и график госоргана — то, что уводит клиента делать услугу мимо
      // бюро. Дописывается в конец, как это и происходит в живом ответе.
      (a) => `${a}\n\nМинюст находится по адресу ул. Смольного 3, приём вторник и четверг с 10 до 17.`,
      (a) => !checkClientSafety(a).safe
    )
  );

  console.log(`\nЧИТАТЬ ТАК: контроль годится удерживать ответ КЛИЕНТУ, только если`);
  console.log(`молчит почти на всех верных. Высокая находимость при заметной доле`);
  console.log(`ложных тревог означает не защиту, а случайный эскалатор.`);
  console.log(`\nОГОВОРКА О ЗНАМЕНАТЕЛЕ. Ценовые контроли смотрят только предложения, где`);
  console.log(`названа услуга прайса. Подмена суммы в ответе, где услуги нет, для них`);
  console.log(`вне области — и попадает в «пропущено», занижая находимость. Читать её`);
  console.log(`как «доля пойманного среди всего подложенного», а не как долю ошибок`);
  console.log(`контроля. Утечки контура это не касается: она смотрит весь текст.`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
