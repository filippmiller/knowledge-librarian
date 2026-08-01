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
 * ОГРАНИЧЕНИЕ МЕТОДА, НЕ ЧИНИТСЯ ЗДЕСЬ ДЁШЕВО (независимо нашли Kimi K3 и
 * Codex). Область (`inScope`) вычисляется тем же кодом контроля, что решает,
 * срабатывать ли: полем `checked` из его вердикта. Это защищает от одного
 * класса самообмана — контроль не может выглядеть точнее из-за бага именно в
 * СРАВНЕНИИ суммы с прайсом, потому что `checked` считается ДО сравнения. Но
 * не защищает от другого: если распознаватель услуги/раздел-фильтр
 * (`FOREIGN_SECTION`, `NOT_A_TARIFF`, сопоставление слов) сам поломается и
 * начнёт признавать МЕНЬШЕ вопросов своими, находимость по этому замеру
 * вырастет — ровно настолько, насколько контроль ослеп. Ловить такую
 * регрессию — работа прицельных `verify-*.ts` на конкретных формулировках, не
 * этого агрегата.
 *
 * Запуск: railway run npx tsx scripts/measure-guard-quality.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { checkCertificationPriceAttribution } from '../src/lib/knowledge/certification-price';
import { checkStalePrice } from '../src/lib/knowledge/stale-price-check';
import { checkClientSafety } from '../src/lib/knowledge/audience';
import { getTariffs } from '../src/lib/knowledge/tariff-store';
import { splitSentences } from '../src/lib/knowledge/sentences';
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

/**
 * Подмена суммы — целиком и предложение, в которое она попала.
 *
 * Оба поля нужны раздельно: `full` идёт в `fires` (контроль всегда судит по
 * всему ответу — соседние предложения дают ему контекст), а `sentence` — в
 * `inScope`. Раньше `inScope` смотрел на `full`, и это било мимо: у ответа
 * «Перевод паспорта — 260 руб. Нотариальное заверение перевода — 1100 руб за
 * документ.» подмена первой суммы засчитывалась «в области» из-за ВТОРОЙ,
 * никак с подменой не связанной пары. Живой пример нашёл Codex в этом самом
 * корпусе, конструктивно то же независимо предсказал Kimi K3.
 *
 * `sentence` — РОВНО одно предложение с подменой, не префикс и не весь ответ.
 * Второй проход Kimi K3 засомневался: certification-price несёт тему из
 * предыдущих предложений (`carriedService` — «Нотариальное заверение копии —
 * 260 ₽. Если срочное, то 300 ₽» — второе предложение без своей темы). Прогнал
 * оба варианта на этом же примере (`scripts/probe-carried-service.ts`):
 * изолированное `«Если нужно срочное заверение, то 300 ₽ за страницу.»` даёт
 * `checked=1` — столько же, сколько в полном тексте. Причина в самом коде
 * контроля: `carriedService` переопределяет, КАКАЯ это услуга, но не гейтит
 * инкремент `checked` — тот срабатывает от голого упоминания «заверение» в
 * САМОМ предложении, вне зависимости от того, унаследована тема или нет.
 * Префикс (все предложения до подмены включительно) пробовал первым — он
 * технически ближе к тому, что видит контроль, но тем же путём возвращает
 * исходный баг: более РАННЯЯ несвязанная пара в префиксе тоже поднимает
 * `checked` выше нуля. Одно предложение свободно от обоих направлений
 * загрязнения — ни раньше, ни позже.
 */
interface Injection {
  full: string;
  sentence: string;
}

function injectMoney(answer: string, replacement: string): Injection | null {
  if (!MONEY.test(answer)) return null;
  const full = answer.replace(MONEY, replacement);
  // MONEY без /g меняет только первое вхождение — предложение с ним ищем по
  // подставленному значению. Раньше него в тексте буквальный текст замены
  // встретиться не может: он сам — валидное совпадение MONEY, а значит стал
  // бы ПЕРВЫМ совпадением и заменился бы вместо текущего места (проверено
  // Kimi K3 разбором для чисел-подстрок вида «1260 руб» тоже). Если сама сумма
  // легла на границу склеивания предложений (перевод строки внутри
  // `[\d\s ]`), совпадающего предложения не найдётся — тогда честнее
  // откатиться к оценке по всему тексту, чем упасть.
  const sentence = splitSentences(full).find((s) => s.includes(replacement)) ?? full;
  return { full, sentence };
}

interface GuardResult {
  name: string;
  /** Верные ответы, на которых контроль промолчал. */
  quietOnClean: number;
  cleanTotal: number;
  /** Подложенные дефекты, которые контроль поймал. */
  caught: number;
  /** Знаменатель находимости: только дефекты В ОБЛАСТИ контроля. */
  injectedTotal: number;
  /** Подложено, но контролю не адресовано — в знаменатель не идёт. */
  outOfScope: number;
  /** Было куда подложить дефект вообще (независимо от области) — для отличия
   *  «дефект подмешать было некуда» от «подмешали, но всё вне области». */
  injectable: number;
  falseAlarms: string[];
  missed: string[];
}

function measure(
  name: string,
  clean: string[],
  inject: (answer: string) => Injection | null,
  fires: (answer: string) => boolean,
  /**
   * Попал ли подложенный дефект в область контроля — по ПРЕДЛОЖЕНИЮ с
   * дефектом, не по всему ответу (см. докстринг `Injection`).
   *
   * Ценовые сторожа судят только предложения, где к сумме привязана услуга: без
   * услуги число не относится ни к чему, и молчать — их замысел, а не промах.
   * Область берётся из вердикта самого контроля (`checked` для ЭТОГО
   * предложения в изоляции), а не из отдельной эвристики: вторая мерка
   * неизбежно разошлась бы с первой.
   */
  inScope: (sentence: string) => boolean = () => true
): GuardResult {
  const res: GuardResult = {
    name,
    quietOnClean: 0,
    cleanTotal: 0,
    caught: 0,
    injectedTotal: 0,
    outOfScope: 0,
    injectable: 0,
    falseAlarms: [],
    missed: [],
  };
  for (const answer of clean) {
    res.cleanTotal += 1;
    if (fires(answer)) res.falseAlarms.push(answer.slice(0, 110).replace(/\n/g, ' '));
    else res.quietOnClean += 1;

    const injection = inject(answer);
    if (injection === null) continue;
    res.injectable += 1;
    if (!inScope(injection.sentence)) {
      res.outOfScope += 1;
      continue;
    }
    res.injectedTotal += 1;
    if (fires(injection.full)) res.caught += 1;
    else res.missed.push(injection.full.slice(0, 110).replace(/\n/g, ' '));
  }
  return res;
}

function print(r: GuardResult): void {
  console.log(`\n── ${r.name}`);
  console.log(`   МОЛЧИТ на верных:   ${r.quietOnClean} из ${r.cleanTotal} (${pct(r.quietOnClean, r.cleanTotal)}) · ложных тревог ${r.falseAlarms.length}`);
  console.log(`   НАХОДИТ подложенное: ${r.caught} из ${r.injectedTotal} (${pct(r.caught, r.injectedTotal)}) · пропущено ${r.missed.length}`);
  if (r.outOfScope > 0) {
    console.log(`   вне компетенции:    ${r.outOfScope} — контроль отказался судить (нет пары услуга-цена в его области); в знаменатель не идёт`);
  }
  if (r.injectable === 0) {
    console.log('   ⚠ дефект подмешать было некуда — контроль этим замером НЕ проверен');
  } else if (r.injectedTotal === 0) {
    console.log('   ⚠ всё подложенное оказалось вне области — контроль этим замером НЕ проверен');
  } else if (r.injectedTotal < 10) {
    console.log(`   ⚠ знаменатель мал (${r.injectedTotal}): один случай — это ${pct(1, r.injectedTotal)}, проценту доверять с осторожностью`);
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
      (a) => injectMoney(a, '260 руб'),
      (a) => !checkCertificationPriceAttribution(a).consistent,
      (s) => checkCertificationPriceAttribution(s).checked > 0
    )
  );

  print(
    measure(
      'Устаревшая цена (stale-price-check)',
      answers,
      (a) => injectMoney(a, `${alien} руб`),
      (a) => !checkStalePrice(a, tariffs).ok,
      (s) => checkStalePrice(s, tariffs).checked > 0
    )
  );

  print(
    measure(
      'Утечка клиентского контура (client-safety)',
      answers,
      // Адрес и график госоргана — то, что уводит клиента делать услугу мимо
      // бюро. Дописывается в конец, как это и происходит в живом ответе.
      (a) => ({
        full: `${a}\n\nМинюст находится по адресу ул. Смольного 3, приём вторник и четверг с 10 до 17.`,
        sentence: 'Минюст находится по адресу ул. Смольного 3, приём вторник и четверг с 10 до 17.',
      }),
      (a) => !checkClientSafety(a).safe
      // inScope не передан: утечка читает весь текст, у неё область — весь корпус.
    )
  );

  console.log(`\nЧИТАТЬ ТАК: контроль годится удерживать ответ КЛИЕНТУ, только если`);
  console.log(`молчит почти на всех верных. Высокая находимость при заметной доле`);
  console.log(`ложных тревог означает не защиту, а случайный эскалатор.`);
  console.log(`\nО ЗНАМЕНАТЕЛЕ. Находимость считается по дефектам В ОБЛАСТИ контроля —`);
  console.log(`оценённой ПО ПРЕДЛОЖЕНИЮ с подменой, не по всему ответу (см. докстринг`);
  console.log(`файла и \`Injection\`). Область берётся из вердикта самого контроля,`);
  console.log(`поэтому не может разойтись с тем, что он на самом деле смотрит — но и не`);
  console.log(`защищает от регрессии в том, что он считает своей областью (тоже в`);
  console.log(`докстринге файла). Утечки контура это не касается: она читает весь текст.`);
  console.log(`\nЧТО ОСТАЛОСЬ НЕЧЕСТНОГО. Подмена может не создать ошибки: если ответ и так`);
  console.log(`про услугу за 260 ₽, «приписке цены» ловить нечего, а случай считается`);
  console.log(`пропуском. Находимость приписки поэтому всё ещё занижена — но уже не на`);
  console.log(`ответах без услуги, а только на этих.`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
