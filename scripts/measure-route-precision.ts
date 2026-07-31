/**
 * Точность КАЖДОГО разрешающего маршрута детерминированных таблиц.
 *
 * Зачем. Возражение аудита (docs/bot-audit/12-adversarial-plan-audit.md §3):
 * «для порога 2% значима не средняя accuracy, а precision каждого разрешающего
 * маршрута». Общая точность 95% бесполезна, если редкая «нотариальная копия»
 * систематически путается с частым «нотариальным переводом».
 *
 * Асимметрия цены ошибки. Пропуск (маршрут промолчал) оставляет вопрос обычному
 * пути — это потеря автономности. Ложное срабатывание даёт клиенту уверенный
 * неверный ответ, ОДИНАКОВЫЙ на всех перефразировках, и проходит все
 * существующие контроли. Поэтому главная цифра здесь — ложноположительные на
 * БЛИЗКИХ отрицательных.
 *
 * Разметка сделана по предметной истине (тетрадь стажёра, слова владельца,
 * прайс), а НЕ по поведению кода. Формулировки взяты из корпуса 180 реальных
 * вопросов (docs/email-bot/may2026-knowledge-base-final.json) там, где корпус их
 * даёт — помечены полем `src`.
 *
 * Запуск: npx tsx scripts/measure-route-precision.ts
 */
import {
  classifyApostilleDocument,
  detectIssuingRegion,
  resolveApostilleTerritoriality,
} from '../src/lib/knowledge/apostille-authority';
import { resolveSourceDocumentRoute } from '../src/lib/knowledge/source-document-route';
import {
  resolveCourtTranslation,
  checkSwornTranslationClaim,
} from '../src/lib/knowledge/sworn-translation';
import { checkCertificationPriceAttribution } from '../src/lib/knowledge/certification-price';

/* ------------------------------------------------------------------ */
/* Каркас замера                                                       */
/* ------------------------------------------------------------------ */

type Bucket = 'pos' | 'near' | 'far';

interface Case<R extends string> {
  /** Вопрос клиента или (для проверок ответа) текст ответа бота. */
  q: string;
  /** Предметная истина. Не поведение кода. */
  expected: R;
  bucket: Bucket;
  /** Для каких маршрутов этот случай — близкий отрицательный. */
  nearOf?: R[];
  /** Откуда формулировка. */
  src?: string;
}

interface RouteStats {
  posTotal: number;
  posHit: number;
  nearTotal: number;
  nearFp: number;
  farTotal: number;
  farFp: number;
  tp: number;
  fp: number;
}

interface Incident {
  route: string;
  bucket: Bucket;
  q: string;
  expected: string;
  got: string;
  src?: string;
}

/** Счётчик обязан считать фактические вызовы, а не задуманный объём. */
let evaluations = 0;
const allFalsePositives: Incident[] = [];
const allMisses: Incident[] = [];

interface ModuleReport {
  title: string;
  rows: Array<{
    route: string;
    recall: string;
    nearFp: string;
    farFp: string;
    precision: string;
  }>;
}

const moduleReports: ModuleReport[] = [];

function pct(n: number, d: number): string {
  if (d === 0) return 'н/д';
  return `${((n / d) * 100).toFixed(0)}%`;
}

function measure<R extends string>(
  title: string,
  routes: readonly R[],
  cases: ReadonlyArray<Case<R>>,
  run: (q: string) => R,
  abstainRoute?: R
): void {
  // Разметка обязана быть согласованной: близкий отрицательный не может
  // ожидать тот самый маршрут, для которого он отрицательный.
  for (const c of cases) {
    if (c.bucket === 'near') {
      if (!c.nearOf || c.nearOf.length === 0) {
        throw new Error(`близкий отрицательный без nearOf: ${c.q}`);
      }
      for (const r of c.nearOf) {
        if (r === c.expected) throw new Error(`nearOf совпал с expected: ${c.q}`);
      }
    }
    if (!routes.includes(c.expected)) throw new Error(`неизвестный маршрут: ${c.expected}`);
  }

  const stats = new Map<R, RouteStats>();
  for (const r of routes) {
    stats.set(r, {
      posTotal: 0,
      posHit: 0,
      nearTotal: 0,
      nearFp: 0,
      farTotal: 0,
      farFp: 0,
      tp: 0,
      fp: 0,
    });
  }
  const s = (r: R): RouteStats => stats.get(r)!;

  const fp: Incident[] = [];
  const miss: Incident[] = [];

  for (const c of cases) {
    const got = run(c.q);
    evaluations++;

    if (got === c.expected) s(got).tp++;
    else s(got).fp++;

    if (c.bucket === 'pos') {
      s(c.expected).posTotal++;
      if (got === c.expected) s(c.expected).posHit++;
      else miss.push({ route: c.expected, bucket: c.bucket, q: c.q, expected: c.expected, got, src: c.src });
    }

    if (c.bucket === 'near') {
      for (const r of c.nearOf!) {
        s(r).nearTotal++;
        if (got === r) {
          s(r).nearFp++;
          fp.push({ route: r, bucket: 'near', q: c.q, expected: c.expected, got, src: c.src });
        }
      }
      if (got !== c.expected && !c.nearOf!.includes(got)) {
        miss.push({ route: c.expected, bucket: c.bucket, q: c.q, expected: c.expected, got, src: c.src });
      }
    }

    if (c.bucket === 'far') {
      for (const r of routes) {
        // Для маршрута молчания дальний отрицательный — это его положительный,
        // а не отрицательный. Не засчитываем, чтобы не рисовать ложный ноль.
        if (r === c.expected) continue;
        s(r).farTotal++;
        if (got === r) {
          s(r).farFp++;
          fp.push({ route: r, bucket: 'far', q: c.q, expected: c.expected, got, src: c.src });
        }
      }
      if (got !== c.expected) {
        // уже учтено в fp выше
      }
    }
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log(title);
  console.log('='.repeat(78));
  if (abstainRoute) {
    console.log(
      `Маршрут молчания: «${abstainRoute}». Для него «ложноположительное» = промолчал там,\n` +
        'где обязан был решить (пропуск), а не выдал неверный ответ. Цена ниже.'
    );
  }
  console.log(
    'маршрут'.padEnd(20) +
      'полнота'.padEnd(14) +
      'ЛП близкие'.padEnd(14) +
      'ЛП дальние'.padEnd(14) +
      'точность'
  );
  console.log('-'.repeat(78));

  const rows: ModuleReport['rows'] = [];
  for (const r of routes) {
    const st = s(r);
    const recall = `${st.posHit}/${st.posTotal} ${pct(st.posHit, st.posTotal)}`;
    const nearFp = `${st.nearFp}/${st.nearTotal} ${pct(st.nearFp, st.nearTotal)}`;
    const farFp = `${st.farFp}/${st.farTotal} ${pct(st.farFp, st.farTotal)}`;
    const precision = `${st.tp}/${st.tp + st.fp} ${pct(st.tp, st.tp + st.fp)}`;
    console.log(
      String(r).padEnd(20) + recall.padEnd(14) + nearFp.padEnd(14) + farFp.padEnd(14) + precision
    );
    rows.push({ route: String(r), recall, nearFp, farFp, precision });

    if (st.posTotal < 10) console.log(`   ВНИМАНИЕ: положительных всего ${st.posTotal} (норма 10)`);
    if (st.nearTotal < 10) console.log(`   ВНИМАНИЕ: близких отрицательных всего ${st.nearTotal} (норма 10)`);
    if (st.farTotal < 5) console.log(`   ВНИМАНИЕ: дальних отрицательных всего ${st.farTotal} (норма 5)`);
  }
  moduleReports.push({ title, rows });

  if (fp.length > 0) {
    console.log(`\n  ЛОЖНОПОЛОЖИТЕЛЬНЫЕ (${fp.length}):`);
    for (const i of fp) {
      console.log(`  [${i.bucket === 'near' ? 'близкий' : 'дальний'}] «${i.q}»`);
      console.log(`      ожидалось: ${i.expected}   получено: ${i.got}${i.src ? `   (${i.src})` : ''}`);
    }
  }
  if (miss.length > 0) {
    console.log(`\n  ПРОПУСКИ — маршрут не сработал там, где обязан (${miss.length}):`);
    for (const i of miss) {
      console.log(`  «${i.q}»`);
      console.log(`      ожидалось: ${i.expected}   получено: ${i.got}${i.src ? `   (${i.src})` : ''}`);
    }
  }

  allFalsePositives.push(...fp);
  allMisses.push(...miss);
}

/* ------------------------------------------------------------------ */
/* Устойчивость к перефразировке                                       */
/* ------------------------------------------------------------------ */

interface ParaphraseGroup {
  id: string;
  module: string;
  expected: string;
  variants: [string, string, string, string];
  run: (q: string) => string;
}

function measureParaphrase(groups: ParaphraseGroup[]): { stable: number; total: number } {
  console.log(`\n${'='.repeat(78)}`);
  console.log('УСТОЙЧИВОСТЬ К ПЕРЕФРАЗИРОВКЕ (4 формулировки одного вопроса)');
  console.log('='.repeat(78));
  let stable = 0;
  for (const g of groups) {
    const verdicts = g.variants.map((v) => {
      evaluations++;
      return g.run(v);
    });
    const same = verdicts.every((v) => v === verdicts[0]);
    const correct = verdicts.every((v) => v === g.expected);
    if (same) stable++;
    console.log(
      `${same ? 'ОДИН ВЕРДИКТ' : 'РАСХОЖДЕНИЕ '}  ${g.module} / ${g.id}  (ожидался ${g.expected}${correct ? '' : ', НЕ достигнут'})`
    );
    if (!same || !correct) {
      for (let i = 0; i < 4; i++) {
        console.log(`      ${verdicts[i].padEnd(18)} «${g.variants[i]}»`);
      }
    }
  }
  console.log(`\nОдин вердикт на всех четырёх: ${stable}/${groups.length} ${pct(stable, groups.length)}`);
  return { stable, total: groups.length };
}

/* ================================================================== */
/* 1. Территориальность апостиля: resolveApostilleTerritoriality        */
/* ================================================================== */

type Verdict = 'accept' | 'reject_original' | 'unknown';

const VERDICT_CASES: Array<Case<Verdict>> = [
  /* --- положительные: accept --- */
  { q: 'Можно ли поставить апостиль на диплом, выданный в Саратове?', expected: 'accept', bucket: 'pos' },
  { q: 'нужен апостиль на диплом с приложением, вуз в Перми', expected: 'accept', bucket: 'pos' },
  { q: 'Апостиль на аттестат, выданный в Москве, можно у вас?', expected: 'accept', bucket: 'pos' },
  { q: 'Поставите апостиль на диплом ДПО?', expected: 'accept', bucket: 'pos' },
  { q: 'апостиль на удостоверение о переквалификации', expected: 'accept', bucket: 'pos' },
  { q: 'Нужно апостилировать свидетельство о рождении, выданное в Санкт-Петербурге', expected: 'accept', bucket: 'pos' },
  { q: 'апостиль на СОР, выдано в СПб', expected: 'accept', bucket: 'pos' },
  { q: 'Справка о несудимости получена в Петербурге, нужен апостиль', expected: 'accept', bucket: 'pos' },
  { q: 'Апостиль на нотариальную доверенность, оформлена в Санкт-Петербурге', expected: 'accept', bucket: 'pos' },
  { q: 'апостиль на СОБ, выдано в Ленинградской области', expected: 'accept', bucket: 'pos' },
  { q: 'Нужен апостиль на диплом', expected: 'accept', bucket: 'pos' },
  { q: 'Можно ли поставить апостиль на диплом вуза, который закрылся / ликвидируется?', expected: 'accept', bucket: 'pos', src: 'корпус #33' },
  { q: 'Нужен апостиль на СОР, я живу в Москве, но документ выдан в Петербурге', expected: 'accept', bucket: 'pos' },
  { q: 'апостиль на дипллом', expected: 'accept', bucket: 'pos', src: 'опечатка' },
  { q: 'нада апостиль на атестат', expected: 'accept', bucket: 'pos', src: 'опечатка' },
  { q: 'Нужен апостиль на свид-во о рождении, выдано в СПб', expected: 'accept', bucket: 'pos', src: 'сокращение' },
  { q: 'Нужен апостиль на справку об отсутствии судимости, получена в СПб', expected: 'accept', bucket: 'pos', src: 'официальное название' },
  { q: 'Апостиль на свидетельство о рождении, выдано в Питере', expected: 'accept', bucket: 'pos', src: 'разговорное' },

  /* --- положительные: reject_original --- */
  { q: 'Свидетельство о рождении выдано в Москве, можно ли поставить апостиль у вас в Петербурге?', expected: 'reject_original', bucket: 'pos' },
  { q: 'апостиль на СОР, выдано в Екатеринбурге', expected: 'reject_original', bucket: 'pos' },
  { q: 'Справка о несудимости выдана в Саратове, нужен апостиль', expected: 'reject_original', bucket: 'pos' },
  { q: 'Нужен апостиль на СОН, справка получена в Казани', expected: 'reject_original', bucket: 'pos', src: 'сокращение' },
  { q: 'Апостиль на свидетельство о браке из Краснодара', expected: 'reject_original', bucket: 'pos' },
  { q: 'Свидетельство о смерти выдано в другом регионе — поставите апостиль?', expected: 'reject_original', bucket: 'pos' },
  { q: 'Нотариальная доверенность оформлена в Новосибирске, нужен апостиль', expected: 'reject_original', bucket: 'pos' },
  { q: 'апостиль на СОРБ, выдано в Волгограде', expected: 'reject_original', bucket: 'pos' },
  { q: 'Апостиль на справку о несудимости, документ выдан во Владивостоке', expected: 'reject_original', bucket: 'pos' },
  { q: 'Нужен апостиль на свидетельство о перемене имени, выдано в Уфе', expected: 'reject_original', bucket: 'pos' },
  { q: 'нужен апостиль на сор из москвы', expected: 'reject_original', bucket: 'pos', src: 'разговорное' },
  { q: 'Справка об отсутствии судимости выдана в Москве, нужен апостиль', expected: 'reject_original', bucket: 'pos', src: 'официальное название' },
  { q: 'Апостиль на свидетельство о рождении, выдано в Твери', expected: 'reject_original', bucket: 'pos' },
  { q: 'Нужен апостиль на СОН, выдана в Оренбурге', expected: 'reject_original', bucket: 'pos' },

  /* --- положительные: unknown (обязан промолчать) --- */
  { q: 'Нужен апостиль на свидетельство о рождении', expected: 'unknown', bucket: 'pos' },
  { q: 'Апостиль на справку о несудимости — сколько по времени?', expected: 'unknown', bucket: 'pos' },
  { q: 'Можно ли поставить апостиль на нотариально заверенную копию трудовой книжки?', expected: 'unknown', bucket: 'pos', src: 'корпус #96' },
  { q: 'Как поставить апостиль на свидетельство о рождении старого образца?', expected: 'unknown', bucket: 'pos', src: 'корпус #97' },
  { q: 'Справка из Саратова, можно ли апостилировать в СПб?', expected: 'unknown', bucket: 'pos' },
  { q: 'Можно ли поставить апостиль на выписки ЕГРЮЛ и ЕГРИП?', expected: 'unknown', bucket: 'pos', src: 'корпус #27' },
  { q: 'Можно ли поставить апостиль на сам перевод?', expected: 'unknown', bucket: 'pos', src: 'корпус #28' },
  { q: 'На каком языке проставляется апостиль в России?', expected: 'unknown', bucket: 'pos', src: 'корпус #32' },
  { q: 'Сколько по времени ставится апостиль?', expected: 'unknown', bucket: 'pos', src: 'корпус #85' },
  { q: 'Можно ли поставить апостиль на иностранный документ, выданный другой страной?', expected: 'unknown', bucket: 'pos', src: 'корпус #29' },
  { q: 'Апостиль на военный билет — делаете?', expected: 'unknown', bucket: 'pos' },
  { q: 'Справка о несудимости выдана Иванову, нужен апостиль', expected: 'unknown', bucket: 'pos', src: 'фамилия против города' },

  /* --- близкие отрицательные к accept --- */
  { q: 'Нужен апостиль на нотариально заверенный перевод диплома', expected: 'unknown', bucket: 'near', nearOf: ['accept'], src: 'нотариальный перевод против диплома' },
  { q: 'Апостиль на нотариально удостоверенную копию диплома', expected: 'unknown', bucket: 'near', nearOf: ['accept'], src: 'нотариальная копия против диплома' },
  { q: 'Сколько стоит перевод диплома с приложением на английский?', expected: 'unknown', bucket: 'near', nearOf: ['accept'], src: 'ценовой вопрос' },
  { q: 'Нужно ли переводить приложение к диплому?', expected: 'unknown', bucket: 'near', nearOf: ['accept'] },
  { q: 'Как рассчитывается стоимость перевода аттестата?', expected: 'unknown', bucket: 'near', nearOf: ['accept'] },
  { q: 'Можно ли заверить перевод диплома нотариально?', expected: 'unknown', bucket: 'near', nearOf: ['accept'] },
  { q: 'Помогаете ли вы с нострификацией (признанием) иностранного образовательного документа в РФ?', expected: 'unknown', bucket: 'near', nearOf: ['accept'], src: 'корпус #22' },
  { q: 'Нужен апостиль на свидетельство о рождении, выданное в Москве', expected: 'reject_original', bucket: 'near', nearOf: ['accept'] },
  { q: 'Апостиль на справку о несудимости из Перми', expected: 'reject_original', bucket: 'near', nearOf: ['accept'] },
  { q: 'Что нужно уточнить перед нотариальным переводом диплома?', expected: 'unknown', bucket: 'near', nearOf: ['accept'], src: 'корпус #76' },
  { q: 'Сколько стоит нотариальный перевод диплома?', expected: 'unknown', bucket: 'near', nearOf: ['accept'] },
  { q: 'Апостиль на нотариальную копию аттестата, копия сделана в Москве', expected: 'reject_original', bucket: 'near', nearOf: ['accept'] },

  /* --- близкие отрицательные к reject_original --- */
  { q: 'Можно ли получить апостилированное свидетельство о рождении доставкой в Екатеринбург?', expected: 'unknown', bucket: 'near', nearOf: ['reject_original'], src: 'город доставки, не выдачи' },
  { q: 'Нужен апостиль на справку о несудимости для консульства Италии в Москве', expected: 'unknown', bucket: 'near', nearOf: ['reject_original'], src: 'город консульства' },
  { q: 'Можно ли поставить апостиль на свидетельство о рождении, если я потом поеду в Москву?', expected: 'unknown', bucket: 'near', nearOf: ['reject_original'] },
  { q: 'Апостиль на свидетельство о браке, сейчас я в Москве, документ со мной', expected: 'unknown', bucket: 'near', nearOf: ['reject_original'] },
  { q: 'Отправите готовое свидетельство о рождении с апостилем в Казань?', expected: 'unknown', bucket: 'near', nearOf: ['reject_original'] },
  { q: 'Нужен апостиль на СОР, потом повезу его в Краснодар', expected: 'unknown', bucket: 'near', nearOf: ['reject_original'] },
  { q: 'Нужен апостиль на справку о несудимости, отправьте её потом в Москву почтой', expected: 'unknown', bucket: 'near', nearOf: ['reject_original'] },
  { q: 'апостиль на СОР — можно оплатить из Москвы?', expected: 'unknown', bucket: 'near', nearOf: ['reject_original'] },
  { q: 'Нужен апостиль на свидетельство о рождении, выданное в Петербурге, но я сейчас в Самаре', expected: 'accept', bucket: 'near', nearOf: ['reject_original'] },
  { q: 'Апостиль на диплом Владимира Петрова, выдан в Петербурге', expected: 'accept', bucket: 'near', nearOf: ['reject_original'], src: 'имя против города' },
  { q: 'Нужен апостиль на СОР, курьером в Мурманск отправите?', expected: 'unknown', bucket: 'near', nearOf: ['reject_original'] },
  { q: 'Свидетельство о рождении, нужен апостиль, консульство в Екатеринбурге', expected: 'unknown', bucket: 'near', nearOf: ['reject_original'] },

  /* --- близкие отрицательные к unknown (обязан был решить, а не молчать) --- */
  { q: 'Апостиль на свидетельство о рождении, выдано в Мск', expected: 'reject_original', bucket: 'near', nearOf: ['unknown'], src: 'сокращение города' },
  { q: 'Нужен апостиль на справку об отсутствии судимости, документ из Ростова', expected: 'reject_original', bucket: 'near', nearOf: ['unknown'], src: 'официальное название' },
  { q: 'Апостиль на свидетельство о рождении, выдано в Рязани', expected: 'reject_original', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Апостиль на свидетельство о рождении, выдано в Кемерове', expected: 'reject_original', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Нужен апостиль на СОН, выдана в Брянске', expected: 'reject_original', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Апостиль на свидетельство о рождении, выдано в Астрахани', expected: 'reject_original', bucket: 'near', nearOf: ['unknown'] },
  { q: 'нужен апостил на свидетельство о раждении, выдано в Москве', expected: 'reject_original', bucket: 'near', nearOf: ['unknown'], src: 'опечатки' },
  { q: 'Апостиль на метрику, выдана в Москве', expected: 'reject_original', bucket: 'near', nearOf: ['unknown'], src: 'разговорное' },
  { q: 'Нужен апостиль на справку о несудимости, выдана в Липецке', expected: 'reject_original', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Апостиль на свидетельство о рождении, выдано в Сургуте', expected: 'reject_original', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Нужен апостиль на свидетельство о повышении квалификации', expected: 'accept', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Апостиль на диплом о профессиональной переподготовке', expected: 'accept', bucket: 'near', nearOf: ['unknown'] },

  /* --- дальние отрицательные --- */
  { q: 'В каком режиме (часы) работают офисы?', expected: 'unknown', bucket: 'far', src: 'корпус #175' },
  { q: 'Нужна ли предоплата для запуска заказа в работу и можно ли оплатить частями?', expected: 'unknown', bucket: 'far', src: 'корпус #144' },
  { q: 'Где находится офис на Чёрной Речке и какой у него график?', expected: 'unknown', bucket: 'far', src: 'корпус #170' },
  { q: 'Куда обращаться по вопросам рекламы и сотрудничества?', expected: 'unknown', bucket: 'far', src: 'корпус #167' },
  { q: 'Можете ли вы предоставить скидку за отзыв?', expected: 'unknown', bucket: 'far', src: 'корпус #41' },
  { q: 'Оказываете ли вы услуги тифлосурдоперевода / перевода жестового языка?', expected: 'unknown', bucket: 'far', src: 'корпус #49' },
  { q: 'Можно ли общаться по телефону в WhatsApp или перейти в Telegram?', expected: 'unknown', bucket: 'far', src: 'корпус #55' },
];

measure(
  '1. resolveApostilleTerritoriality — территориальность апостиля (чистая функция)',
  ['accept', 'reject_original', 'unknown'] as const,
  VERDICT_CASES,
  (q) => resolveApostilleTerritoriality(q).kind,
  'unknown'
);

/**
 * Тот же набор, но с продовым гейтом: в enhanced-answering-engine.ts вердикт
 * используется только при `/апостил/`. Без этого замера цифры чистой функции
 * преувеличивают риск для клиента.
 */
measure(
  '1a. Тот же маршрут, как он работает В ПРОДЕ (гейт /апостил/ из движка)',
  ['accept', 'reject_original', 'unknown'] as const,
  VERDICT_CASES,
  (q) => (/апостил/iu.test(q) ? resolveApostilleTerritoriality(q).kind : 'unknown'),
  'unknown'
);

/* ================================================================== */
/* 1b. Какой орган: classifyApostilleDocument                          */
/* ================================================================== */

type Authority = 'min_justice' | 'zags' | 'mvd' | 'education' | 'none';

const AUTHORITY_CASES: Array<Case<Authority>> = [
  /* --- положительные: mvd --- */
  { q: 'Нужен апостиль на справку о несудимости', expected: 'mvd', bucket: 'pos' },
  { q: 'апостиль на СОН для Италии', expected: 'mvd', bucket: 'pos', src: 'сокращение' },
  { q: 'справка о несудимости — нужен апостиль', expected: 'mvd', bucket: 'pos' },
  { q: 'апостиль на сон', expected: 'mvd', bucket: 'pos', src: 'сокращение строчными' },
  { q: 'апостиль на справку о несудимости на синем бланке', expected: 'mvd', bucket: 'pos' },
  { q: 'Можно ли получить справку об отсутствии судимости, в том числе с апостилем и при наличии судимости?', expected: 'mvd', bucket: 'pos', src: 'корпус #34' },
  { q: 'Можно ли срочно получить справку об отсутствии судимости с апостилем?', expected: 'mvd', bucket: 'pos', src: 'корпус #102' },
  { q: 'Что нужно для истребования справки об отсутствии судимости с апостилем?', expected: 'mvd', bucket: 'pos', src: 'корпус #118' },
  { q: 'Какие виды апостиля бывают для справки об отсутствии судимости: на оригинал и на перевод?', expected: 'mvd', bucket: 'pos', src: 'корпус #123' },
  { q: 'Как оплачивается истребование справки о несудимости с апостилем?', expected: 'mvd', bucket: 'pos', src: 'корпус #166' },
  { q: 'Как сделать консульскую легализацию справки о несудимости из электронного документа с Госуслуг?', expected: 'mvd', bucket: 'pos', src: 'корпус #116' },
  { q: 'нужна справка об отсутсвии судимости с апостилем', expected: 'mvd', bucket: 'pos', src: 'опечатка' },

  /* --- положительные: education --- */
  { q: 'Апостиль на диплом с приложением', expected: 'education', bucket: 'pos' },
  { q: 'апостиль на аттестат о среднем образовании', expected: 'education', bucket: 'pos' },
  { q: 'апостиль на удостоверение о переквалификации', expected: 'education', bucket: 'pos' },
  { q: 'Можно ли узнать про апостиль на диплом и где его поставить?', expected: 'education', bucket: 'pos', src: 'корпус #106' },
  { q: 'Можно ли поставить апостиль на диплом вуза, который закрылся / ликвидируется?', expected: 'education', bucket: 'pos', src: 'корпус #33' },
  { q: 'апостиль на диплом ДПО', expected: 'education', bucket: 'pos', src: 'сокращение' },
  { q: 'Нужен апостиль на образовательный документ', expected: 'education', bucket: 'pos' },
  { q: 'апостиль на диплом бакалавра', expected: 'education', bucket: 'pos' },
  { q: 'апостиль на атестат', expected: 'education', bucket: 'pos', src: 'опечатка' },
  { q: 'нужен апостил на диплом магистра и приложение', expected: 'education', bucket: 'pos', src: 'опечатка' },
  { q: 'Апостиль на диплом о профессиональной переподготовке', expected: 'education', bucket: 'pos' },
  { q: 'Нужен апостиль на свидетельство о повышении квалификации', expected: 'education', bucket: 'pos' },
  // Классификатор отвечает на вопрос «документ какого органа назван», а не «о
  // чём вопрос». Поэтому ценовые и процедурные формулировки с образовательным
  // документом — тоже положительные для education.
  { q: 'Сколько стоит перевод диплома с приложением на английский?', expected: 'education', bucket: 'pos' },
  { q: 'Нужно ли переводить приложение к диплому?', expected: 'education', bucket: 'pos' },
  { q: 'Как рассчитывается стоимость перевода аттестата?', expected: 'education', bucket: 'pos' },
  { q: 'Помогаете ли вы с нострификацией (признанием) иностранного образовательного документа в РФ?', expected: 'education', bucket: 'pos', src: 'корпус #22' },
  { q: 'Что нужно для нострификации диплома и подачи документов?', expected: 'education', bucket: 'pos', src: 'корпус #61' },
  { q: 'Можно ли заверить перевод диплома нотариально?', expected: 'education', bucket: 'pos' },

  /* --- положительные: zags --- */
  { q: 'Апостиль на свидетельство о рождении', expected: 'zags', bucket: 'pos' },
  { q: 'апостиль на свидетельство о расторжении брака', expected: 'zags', bucket: 'pos' },
  { q: 'апостиль на СОР', expected: 'zags', bucket: 'pos', src: 'сокращение' },
  { q: 'апостиль на СОБ', expected: 'zags', bucket: 'pos', src: 'сокращение' },
  { q: 'апостиль на СОРБ', expected: 'zags', bucket: 'pos', src: 'сокращение' },
  { q: 'апостиль на СОС', expected: 'zags', bucket: 'pos', src: 'сокращение' },
  { q: 'апостиль на СОПИ', expected: 'zags', bucket: 'pos', src: 'сокращение' },
  { q: 'Как получают дубликат документа ЗАГС с апостилем и в какие сроки?', expected: 'zags', bucket: 'pos', src: 'корпус #109' },
  { q: 'Как поставить апостиль на свидетельство о рождении старого образца?', expected: 'zags', bucket: 'pos', src: 'корпус #97' },
  { q: 'апостиль на свидетельство о смерти', expected: 'zags', bucket: 'pos' },
  { q: 'апостиль на свид-во о браке', expected: 'zags', bucket: 'pos', src: 'сокращение' },
  { q: 'Апостиль на метрику', expected: 'zags', bucket: 'pos', src: 'разговорное' },
  { q: 'Сколько стоит перевод свидетельства о рождении?', expected: 'zags', bucket: 'pos' },

  /* --- положительные: min_justice --- */
  { q: 'апостиль на нотариальную доверенность', expected: 'min_justice', bucket: 'pos' },
  { q: 'апостиль на справку из вуза', expected: 'min_justice', bucket: 'pos' },
  { q: 'апостиль на судебный документ', expected: 'min_justice', bucket: 'pos' },
  { q: 'Можно ли поставить апостиль на нотариально заверенную копию трудовой книжки?', expected: 'min_justice', bucket: 'pos', src: 'корпус #96' },
  { q: 'апостиль на нотариальную копию паспорта', expected: 'min_justice', bucket: 'pos' },
  { q: 'апостиль на нотариальный перевод диплома', expected: 'min_justice', bucket: 'pos' },
  { q: 'апостиль на справку из налоговой', expected: 'min_justice', bucket: 'pos' },
  { q: 'апостиль на документы из МФЦ', expected: 'min_justice', bucket: 'pos' },
  { q: 'апостиль на сертификат из вуза', expected: 'min_justice', bucket: 'pos' },
  { q: 'апостиль на нотариальную копию диплома', expected: 'min_justice', bucket: 'pos' },
  { q: 'Какой документ нужен, чтобы поставить апостиль на выписку ЕГРЮЛ или судебное решение?', expected: 'min_justice', bucket: 'pos', src: 'корпус #67' },
  { q: 'Как подать на апостиль документ, требующий подтверждения подписавшего лица?', expected: 'min_justice', bucket: 'pos', src: 'корпус #107' },
  { q: 'Можно ли сделать нотариальную копию иностранного документа в России?', expected: 'min_justice', bucket: 'pos', src: 'корпус #36' },
  { q: 'Как оплачивается изготовление нотариальной копии?', expected: 'min_justice', bucket: 'pos', src: 'корпус #110' },
  { q: 'Какие требования к документу для изготовления нотариальной копии?', expected: 'min_justice', bucket: 'pos', src: 'корпус #66' },
  { q: 'Нужен ли оригинал для нотариального перевода?', expected: 'min_justice', bucket: 'pos' },
  { q: 'К чему подшивается нотариальный перевод?', expected: 'min_justice', bucket: 'pos', src: 'корпус #87' },
  { q: 'Можно ли у вас оформить доверенность? Есть ли услуги нотариуса?', expected: 'min_justice', bucket: 'pos', src: 'корпус #53' },
  { q: 'Апостиль на налоговую декларацию', expected: 'min_justice', bucket: 'pos' },

  /* --- положительные: none (обязан не классифицировать) --- */
  { q: 'Сколько стоит перевод паспорта?', expected: 'none', bucket: 'pos' },
  { q: 'Можно ли поставить апостиль на выписки ЕГРЮЛ и ЕГРИП?', expected: 'none', bucket: 'pos', src: 'корпус #27' },
  { q: 'Можно ли поставить апостиль на сам перевод?', expected: 'none', bucket: 'pos', src: 'корпус #28' },
  { q: 'На каком языке проставляется апостиль в России?', expected: 'none', bucket: 'pos', src: 'корпус #32' },
  { q: 'Апостиль на военный билет', expected: 'none', bucket: 'pos' },
  { q: 'Апостиль на медицинскую справку', expected: 'none', bucket: 'pos' },
  { q: 'Апостиль на водительское удостоверение', expected: 'none', bucket: 'pos' },
  { q: 'Апостиль на паспорт', expected: 'none', bucket: 'pos' },
  { q: 'Сколько по времени ставится апостиль?', expected: 'none', bucket: 'pos', src: 'корпус #85' },
  { q: 'Можно ли поставить апостиль на иностранный документ, выданный другой страной?', expected: 'none', bucket: 'pos', src: 'корпус #29' },
  { q: 'Апостиль на свидетельство о собственности на квартиру', expected: 'none', bucket: 'pos' },
  { q: 'Апостиль на трудовую книжку', expected: 'none', bucket: 'pos' },

  /* --- близкие отрицательные к education --- */
  { q: 'Нужен апостиль на нотариально заверенный перевод диплома', expected: 'min_justice', bucket: 'near', nearOf: ['education'], src: 'нотариальный перевод против диплома' },
  { q: 'Апостиль на нотариально удостоверенную копию диплома', expected: 'min_justice', bucket: 'near', nearOf: ['education'], src: 'нотариальная копия против диплома' },
  { q: 'апостиль на справку из вуза о периоде обучения', expected: 'min_justice', bucket: 'near', nearOf: ['education'], src: 'справка из вуза против диплома' },
  { q: 'апостиль на сертификат из вуза о прослушанном курсе', expected: 'min_justice', bucket: 'near', nearOf: ['education'] },
  { q: 'Что нужно уточнить перед нотариальным переводом диплома?', expected: 'min_justice', bucket: 'near', nearOf: ['education'], src: 'корпус #76' },
  { q: 'Сколько стоит нотариальная копия диплома?', expected: 'min_justice', bucket: 'near', nearOf: ['education'] },
  { q: 'Апостиль на нотариальный перевод аттестата', expected: 'min_justice', bucket: 'near', nearOf: ['education'] },
  { q: 'Апостиль на справку из вуза об обучении по программе ДПО', expected: 'min_justice', bucket: 'near', nearOf: ['education'], src: 'ДПО внутри справки из вуза' },
  { q: 'Апостиль на удостоверение личности', expected: 'none', bucket: 'near', nearOf: ['education'] },
  { q: 'Апостиль на удостоверение ветерана', expected: 'none', bucket: 'near', nearOf: ['education'] },
  { q: 'Апостиль на пенсионное удостоверение', expected: 'none', bucket: 'near', nearOf: ['education'] },
  { q: 'Нужен апостиль на студенческий билет', expected: 'none', bucket: 'near', nearOf: ['education'] },

  /* --- близкие отрицательные к mvd --- */
  { q: 'апостиль на справку из вуза', expected: 'min_justice', bucket: 'near', nearOf: ['mvd'], src: 'справка против справки' },
  { q: 'справка о рождении — нужен апостиль', expected: 'zags', bucket: 'near', nearOf: ['mvd'], src: 'справка против справки' },
  { q: 'апостиль на справку из налоговой', expected: 'min_justice', bucket: 'near', nearOf: ['mvd'] },
  { q: 'Апостиль на медицинскую справку из поликлиники', expected: 'none', bucket: 'near', nearOf: ['mvd'] },
  { q: 'Апостиль на справку о составе семьи', expected: 'none', bucket: 'near', nearOf: ['mvd'] },
  { q: 'Апостиль на справку 2-НДФЛ', expected: 'none', bucket: 'near', nearOf: ['mvd'] },
  { q: 'Апостиль на справку о доходах', expected: 'none', bucket: 'near', nearOf: ['mvd'] },
  { q: 'Как получить справку о состоянии счёта с апостилем?', expected: 'none', bucket: 'near', nearOf: ['mvd'] },
  { q: 'Апостиль на справку из банка', expected: 'none', bucket: 'near', nearOf: ['mvd'] },
  { q: 'Нужен апостиль на архивную справку', expected: 'none', bucket: 'near', nearOf: ['mvd'] },
  { q: 'Апостиль на справку с места работы', expected: 'none', bucket: 'near', nearOf: ['mvd'] },
  { q: 'Апостиль на справку об обучении', expected: 'none', bucket: 'near', nearOf: ['mvd'] },

  /* --- близкие отрицательные к zags --- */
  { q: 'Нужно ли переводить свидетельство о собственности?', expected: 'none', bucket: 'near', nearOf: ['zags'], src: 'СОБ против «собственности»' },
  { q: 'Апостиль на свидетельство о постановке на налоговый учёт', expected: 'min_justice', bucket: 'near', nearOf: ['zags'] },
  { q: 'Апостиль на свидетельство о регистрации ИП', expected: 'none', bucket: 'near', nearOf: ['zags'] },
  { q: 'Апостиль на свидетельство о повышении квалификации', expected: 'education', bucket: 'near', nearOf: ['zags'] },
  { q: 'Апостиль на свидетельство о праве на наследство', expected: 'none', bucket: 'near', nearOf: ['zags'] },
  { q: 'Соберите пожалуйста документы к пятнице', expected: 'none', bucket: 'near', nearOf: ['zags'], src: 'СОБ внутри слова' },
  { q: 'Апостиль на нотариальную копию свидетельства о рождении', expected: 'min_justice', bucket: 'near', nearOf: ['zags'], src: 'нотариальная копия против СОР' },
  { q: 'Нужен нотариальный перевод свидетельства о браке', expected: 'min_justice', bucket: 'near', nearOf: ['zags'], src: 'нотариальный перевод против СОБ' },
  { q: 'Апостиль на свидетельство о регистрации транспортного средства', expected: 'none', bucket: 'near', nearOf: ['zags'] },
  { q: 'Апостиль на свидетельство ИНН', expected: 'none', bucket: 'near', nearOf: ['zags'] },
  { q: 'Свидетельство о рождении потеряно, как истребовать дубликат?', expected: 'zags', bucket: 'near', nearOf: ['min_justice'] },
  { q: 'Апостиль на свидетельство о членстве в СРО', expected: 'none', bucket: 'near', nearOf: ['zags'] },

  /* --- близкие отрицательные к min_justice --- */
  { q: 'Апостиль на диплом с нотариально заверенным приложением', expected: 'education', bucket: 'near', nearOf: ['min_justice'], src: 'спорная граница' },
  { q: 'Сколько стоит нотариальное заверение перевода?', expected: 'none', bucket: 'near', nearOf: ['min_justice'], src: 'ценовой вопрос' },
  { q: 'Нужна ли доверенность, чтобы забрать готовый заказ?', expected: 'none', bucket: 'near', nearOf: ['min_justice'], src: 'доверенность на получение, не документ' },
  { q: 'Можно ли получить заказ организации по доверенности и нужен ли оригинал?', expected: 'none', bucket: 'near', nearOf: ['min_justice'], src: 'корпус #150' },
  { q: 'Можно ли оставить доверенность в офисе для будущих заказов на истребование?', expected: 'none', bucket: 'near', nearOf: ['min_justice'], src: 'корпус #80' },
  { q: 'Что нужно для истребования документов из-за рубежа и проставления апостиля по доверенности?', expected: 'none', bucket: 'near', nearOf: ['min_justice'], src: 'корпус #63' },
  { q: 'Можно ли истребовать документ по скану доверенности, без оригинала?', expected: 'none', bucket: 'near', nearOf: ['min_justice'], src: 'корпус #122' },
  { q: 'Ваш офис рядом с МФЦ?', expected: 'none', bucket: 'near', nearOf: ['min_justice'], src: 'МФЦ как ориентир' },
  { q: 'Можно ли получить документы в МФЦ и сразу у вас перевести?', expected: 'none', bucket: 'near', nearOf: ['min_justice'] },
  { q: 'Сколько стоит услуга налогового консультанта?', expected: 'none', bucket: 'near', nearOf: ['min_justice'], src: '«налогов» вне документа' },
  { q: 'Апостиль на нотариально заверенную справку о несудимости', expected: 'mvd', bucket: 'near', nearOf: ['min_justice'], src: 'нотариальное против несудимости' },
  { q: 'Апостиль на справку о несудимости, полученную через МФЦ', expected: 'mvd', bucket: 'near', nearOf: ['min_justice'], src: 'МФЦ против несудимости' },
  { q: 'Нужен ли нотариус для апостиля на диплом?', expected: 'education', bucket: 'near', nearOf: ['min_justice'] },

  /* --- близкие отрицательные к none (обязан был определить орган) --- */
  { q: 'Нужен апостиль на справку об отсутствии судимости', expected: 'mvd', bucket: 'near', nearOf: ['none'], src: 'официальное название' },
  { q: 'Апостиль на свид-во о рождении', expected: 'zags', bucket: 'near', nearOf: ['none'], src: 'сокращение' },
  { q: 'апостиль на дипллом', expected: 'education', bucket: 'near', nearOf: ['none'], src: 'опечатка' },
  { q: 'Апостиль на свидетельство о заключении брака', expected: 'zags', bucket: 'near', nearOf: ['none'], src: 'официальное название' },
  { q: 'Апостиль на свидетельство об установлении отцовства', expected: 'zags', bucket: 'near', nearOf: ['none'] },
  { q: 'Апостиль на свидетельство об усыновлении', expected: 'zags', bucket: 'near', nearOf: ['none'] },
  { q: 'Апостиль на справку о несудимости из МВД', expected: 'mvd', bucket: 'near', nearOf: ['none'] },
  { q: 'Апостиль на решение суда', expected: 'min_justice', bucket: 'near', nearOf: ['none'] },
  { q: 'Апостиль на доверенность от нотариуса', expected: 'min_justice', bucket: 'near', nearOf: ['none'] },
  { q: 'Апостиль на школьный аттестат', expected: 'education', bucket: 'near', nearOf: ['none'] },
  { q: 'Нужен апостиль на диплом об окончании университета', expected: 'education', bucket: 'near', nearOf: ['none'] },
  { q: 'Апостиль на справку о смене фамилии', expected: 'zags', bucket: 'near', nearOf: ['none'] },

  /* --- дальние отрицательные --- */
  { q: 'В каком режиме (часы) работают офисы?', expected: 'none', bucket: 'far', src: 'корпус #175' },
  { q: 'Нужна ли предоплата для запуска заказа в работу и можно ли оплатить частями?', expected: 'none', bucket: 'far', src: 'корпус #144' },
  { q: 'Где находится офис на Чёрной Речке и какой у него график?', expected: 'none', bucket: 'far', src: 'корпус #170' },
  { q: 'Куда обращаться по вопросам рекламы и сотрудничества?', expected: 'none', bucket: 'far', src: 'корпус #167' },
  { q: 'Можете ли вы предоставить скидку за отзыв?', expected: 'none', bucket: 'far', src: 'корпус #41' },
  { q: 'Оказываете ли вы услуги тифлосурдоперевода / перевода жестового языка?', expected: 'none', bucket: 'far', src: 'корпус #49' },
  { q: 'Можно ли общаться по телефону в WhatsApp или перейти в Telegram?', expected: 'none', bucket: 'far', src: 'корпус #55' },
];

measure(
  '1b. classifyApostilleDocument — какой орган ставит апостиль',
  ['min_justice', 'zags', 'mvd', 'education', 'none'] as const,
  AUTHORITY_CASES,
  (q) => classifyApostilleDocument(q) ?? 'none',
  'none'
);

/* ================================================================== */
/* 1c. Регион выдачи: detectIssuingRegion                              */
/* ================================================================== */

type Region = 'local' | 'other' | 'unknown';

const REGION_CASES: Array<Case<Region>> = [
  /* --- положительные: other --- */
  { q: 'справка выдана в Саратове', expected: 'other', bucket: 'pos' },
  { q: 'документ из Москвы', expected: 'other', bucket: 'pos' },
  { q: 'свидетельство выдано в другом регионе', expected: 'other', bucket: 'pos' },
  { q: 'справка получена в Казани', expected: 'other', bucket: 'pos' },
  { q: 'диплом выдан во Владивостоке', expected: 'other', bucket: 'pos' },
  { q: 'документ из Краснодара', expected: 'other', bucket: 'pos' },
  { q: 'свидетельство выдано в Уфе', expected: 'other', bucket: 'pos' },
  { q: 'справка выдана в Нижнем Новгороде', expected: 'other', bucket: 'pos' },
  { q: 'документ выдан в другом городе', expected: 'other', bucket: 'pos' },
  { q: 'свидетельство выдано в Перми', expected: 'other', bucket: 'pos' },
  { q: 'документ выдан в Иваново', expected: 'other', bucket: 'pos', src: 'город против фамилии' },
  { q: 'справка оформлена в Челябинске', expected: 'other', bucket: 'pos' },

  /* --- положительные: local --- */
  { q: 'выдано в Санкт-Петербурге', expected: 'local', bucket: 'pos' },
  { q: 'документ из Ленинградской области', expected: 'local', bucket: 'pos' },
  { q: 'справка выдана в СПб', expected: 'local', bucket: 'pos', src: 'сокращение' },
  { q: 'свидетельство получено в Петербурге', expected: 'local', bucket: 'pos' },
  { q: 'документ выдан в Лен. области', expected: 'local', bucket: 'pos', src: 'сокращение' },
  { q: 'справка получена в Санкт-Петербурге', expected: 'local', bucket: 'pos' },
  { q: 'свидетельство выдано в Ленинградской области', expected: 'local', bucket: 'pos' },
  { q: 'документ выдан в спб', expected: 'local', bucket: 'pos', src: 'строчными' },
  { q: 'доверенность оформлена в Санкт-Петербурге', expected: 'local', bucket: 'pos' },
  { q: 'диплом выдан в Санкт-Петербурге в 2015 году', expected: 'local', bucket: 'pos' },
  { q: 'справка выписана в Петербурге', expected: 'local', bucket: 'pos' },
  { q: 'документ составлен в Санкт-Петербурге', expected: 'local', bucket: 'pos' },

  /* --- положительные: unknown --- */
  { q: 'нужен апостиль на диплом', expected: 'unknown', bucket: 'pos' },
  { q: 'справка из Саратова, можно ли апостилировать в СПб', expected: 'unknown', bucket: 'pos' },
  { q: 'справка о несудимости выдана Иванову', expected: 'unknown', bucket: 'pos', src: 'фамилия против города' },
  { q: 'перевод на имя Владимира Иванова', expected: 'unknown', bucket: 'pos', src: 'имя против города' },
  { q: 'справка выдана в 2019 году', expected: 'unknown', bucket: 'pos' },
  { q: 'сколько стоит апостиль', expected: 'unknown', bucket: 'pos' },
  { q: 'нужен апостиль на свидетельство о рождении', expected: 'unknown', bucket: 'pos' },
  { q: 'документ выдан на имя Иванова Ивана Ивановича', expected: 'unknown', bucket: 'pos', src: 'фамилия против города' },
  { q: 'работаю в Москве, документ петербургский', expected: 'unknown', bucket: 'pos' },
  { q: 'справка на имя Владимира', expected: 'unknown', bucket: 'pos' },
  { q: 'какие документы нужны для апостиля', expected: 'unknown', bucket: 'pos' },
  { q: 'сколько времени занимает апостиль', expected: 'unknown', bucket: 'pos' },

  /* --- близкие отрицательные к other --- */
  { q: 'отправьте готовый документ доставкой в Москву', expected: 'unknown', bucket: 'near', nearOf: ['other'], src: 'город доставки' },
  { q: 'потом поеду в Казань, нужен апостиль', expected: 'unknown', bucket: 'near', nearOf: ['other'] },
  { q: 'консульство Италии в Москве требует апостиль', expected: 'unknown', bucket: 'near', nearOf: ['other'], src: 'город консульства' },
  { q: 'отправьте курьером в Краснодар', expected: 'unknown', bucket: 'near', nearOf: ['other'] },
  { q: 'можно ли оплатить из Москвы', expected: 'unknown', bucket: 'near', nearOf: ['other'] },
  { q: 'я сейчас в Самаре, но документ выдан в Петербурге', expected: 'local', bucket: 'near', nearOf: ['other'] },
  { q: 'диплом Владимира Петрова выдан в Петербурге', expected: 'local', bucket: 'near', nearOf: ['other'], src: 'имя против города' },
  { q: 'справка о несудимости, выданная Иванову', expected: 'unknown', bucket: 'near', nearOf: ['other'], src: 'фамилия против города' },
  { q: 'нужно подать документы в Москве, а выданы они в СПб', expected: 'local', bucket: 'near', nearOf: ['other'] },
  { q: 'приеду к вам из Мурманска, документ выдан в Санкт-Петербурге', expected: 'local', bucket: 'near', nearOf: ['other'] },
  { q: 'вышлите заказ в Тулу', expected: 'unknown', bucket: 'near', nearOf: ['other'] },
  { q: 'подавать документы буду в Омске', expected: 'unknown', bucket: 'near', nearOf: ['other'] },

  /* --- близкие отрицательные к local --- */
  { q: 'офис на Чёрной Речке в Петербурге — какой график?', expected: 'unknown', bucket: 'near', nearOf: ['local'], src: 'город офиса' },
  { q: 'нужно отправить в Санкт-Петербург, документ выдан в Омске', expected: 'other', bucket: 'near', nearOf: ['local'] },
  { q: 'я живу в Санкт-Петербурге, свидетельство выдано в Москве', expected: 'other', bucket: 'near', nearOf: ['local'] },
  { q: 'какие у вас офисы в Санкт-Петербурге?', expected: 'unknown', bucket: 'near', nearOf: ['local'], src: 'корпус #169' },
  { q: 'приеду в ваш офис в СПб, документ из Ростова', expected: 'other', bucket: 'near', nearOf: ['local'] },
  { q: 'работаете ли вы в Ленинградской области?', expected: 'unknown', bucket: 'near', nearOf: ['local'] },
  { q: 'доставка по Санкт-Петербургу есть?', expected: 'unknown', bucket: 'near', nearOf: ['local'] },
  { q: 'нотариус в Петербурге заверит перевод документа из Казани', expected: 'other', bucket: 'near', nearOf: ['local'] },
  { q: 'сколько стоит курьер по Санкт-Петербургу', expected: 'unknown', bucket: 'near', nearOf: ['local'] },
  { q: 'мой муж родом из Петербурга, свидетельство выдано в Твери', expected: 'other', bucket: 'near', nearOf: ['local'] },
  { q: 'ваш офис у площади Ленина работает в субботу?', expected: 'unknown', bucket: 'near', nearOf: ['local'] },
  { q: 'я петербуржец, документ получен в Волгограде', expected: 'other', bucket: 'near', nearOf: ['local'] },

  /* --- близкие отрицательные к unknown (регион назван, а модуль молчит) --- */
  { q: 'свидетельство выдано в Твери', expected: 'other', bucket: 'near', nearOf: ['unknown'] },
  { q: 'справка выдана в Мск', expected: 'other', bucket: 'near', nearOf: ['unknown'], src: 'сокращение' },
  { q: 'документ выдан в Оренбурге', expected: 'other', bucket: 'near', nearOf: ['unknown'] },
  { q: 'свидетельство выдано в Питере', expected: 'local', bucket: 'near', nearOf: ['unknown'], src: 'разговорное' },
  { q: 'справка выдана в Кемерове', expected: 'other', bucket: 'near', nearOf: ['unknown'] },
  { q: 'документ выдан в Брянске', expected: 'other', bucket: 'near', nearOf: ['unknown'] },
  { q: 'свидетельство выдано в Липецке', expected: 'other', bucket: 'near', nearOf: ['unknown'] },
  { q: 'справка выдана в Сургуте', expected: 'other', bucket: 'near', nearOf: ['unknown'] },
  { q: 'документ выдан в Астрахани', expected: 'other', bucket: 'near', nearOf: ['unknown'] },
  { q: 'свидетельство выдано в Рязани', expected: 'other', bucket: 'near', nearOf: ['unknown'] },
  { q: 'справка выдана в Спб', expected: 'local', bucket: 'near', nearOf: ['unknown'], src: 'сокращение' },
  { q: 'документ выдан в ленобласти', expected: 'local', bucket: 'near', nearOf: ['unknown'], src: 'слитно' },

  /* --- дальние отрицательные --- */
  { q: 'В каком режиме (часы) работают офисы?', expected: 'unknown', bucket: 'far', src: 'корпус #175' },
  { q: 'Нужна ли предоплата для запуска заказа в работу?', expected: 'unknown', bucket: 'far', src: 'корпус #144' },
  { q: 'Куда обращаться по вопросам рекламы и сотрудничества?', expected: 'unknown', bucket: 'far', src: 'корпус #167' },
  { q: 'Можете ли вы предоставить скидку за отзыв?', expected: 'unknown', bucket: 'far', src: 'корпус #41' },
  { q: 'Оказываете ли вы услуги тифлосурдоперевода?', expected: 'unknown', bucket: 'far', src: 'корпус #49' },
  { q: 'Можно ли общаться по телефону в WhatsApp?', expected: 'unknown', bucket: 'far', src: 'корпус #55' },
  { q: 'Какие способы подписания закрывающих документов вы поддерживаете?', expected: 'unknown', bucket: 'far', src: 'корпус #88' },
];

measure(
  '1c. detectIssuingRegion — регион выдачи документа',
  ['local', 'other', 'unknown'] as const,
  REGION_CASES,
  detectIssuingRegion,
  'unknown'
);

/* ================================================================== */
/* 2. Маршруты исходника: resolveSourceDocumentRoute                   */
/* ================================================================== */

type SourceRoute = 'explain_routes' | 'strict_destination' | 'unknown';

const SOURCE_CASES: Array<Case<SourceRoute>> = [
  /* --- положительные: explain_routes --- */
  { q: 'К чему подшивается нотариальный перевод — к оригиналу, копии или нотариальной копии?', expected: 'explain_routes', bucket: 'pos', src: 'корпус #56, частота 9' },
  { q: 'К чему подшивается готовый нотариальный перевод?', expected: 'explain_routes', bucket: 'pos', src: 'корпус #87, частота 6' },
  { q: 'Нужен ли оригинал документа для заверения и сшития перевода?', expected: 'explain_routes', bucket: 'pos', src: 'корпус #57, частота 9' },
  { q: 'Нужен ли оригинал для нотариального перевода или хватит скана?', expected: 'explain_routes', bucket: 'pos' },
  { q: 'Можно ли сделать нотариальный перевод по скану, оригинал не привезу?', expected: 'explain_routes', bucket: 'pos' },
  { q: 'Я в другом городе, могу прислать только фото — сделаете нотариальный перевод?', expected: 'explain_routes', bucket: 'pos' },
  { q: 'Что нужно предоставить для нотариального перевода — оригинал или копию?', expected: 'explain_routes', bucket: 'pos' },
  { q: 'К чему подшивают нотариальный перевод?', expected: 'explain_routes', bucket: 'pos' },
  { q: 'Перевод у нотариуса подшивается к оригиналу или к ксерокопии?', expected: 'explain_routes', bucket: 'pos' },
  { q: 'Мне нужно заверить перевод нотариально, оригинал обязательно везти?', expected: 'explain_routes', bucket: 'pos' },
  { q: 'нужен ли оригенал для нотариального перевода?', expected: 'explain_routes', bucket: 'pos', src: 'опечатка' },
  { q: 'Достаточно ли скана для нотариального перевода?', expected: 'explain_routes', bucket: 'pos' },
  { q: 'К чему пришивается нотариальный перевод?', expected: 'explain_routes', bucket: 'pos', src: 'разговорное' },
  { q: 'Хватит ли фотографии документа для нотариального перевода?', expected: 'explain_routes', bucket: 'pos' },
  { q: 'Можно ли прислать документ в PDF для нотариального перевода?', expected: 'explain_routes', bucket: 'pos' },
  { q: 'Обязательно ли привозить оригинал для нотариального перевода?', expected: 'explain_routes', bucket: 'pos' },

  /* --- положительные: strict_destination --- */
  { q: 'Нужен ли оригинал для нотариального перевода, если документ идёт на консульскую легализацию?', expected: 'strict_destination', bucket: 'pos' },
  { q: 'Для посольства нотариальный перевод подшивают к оригиналу или к копии?', expected: 'strict_destination', bucket: 'pos' },
  { q: 'Нужен ли оригинал для нотариального перевода справки для суда?', expected: 'strict_destination', bucket: 'pos' },
  { q: 'Документы на ВНЖ — нотариальный перевод к чему подшивается?', expected: 'strict_destination', bucket: 'pos' },
  { q: 'Для подачи на гражданство нужен оригинал при нотариальном переводе?', expected: 'strict_destination', bucket: 'pos' },
  { q: 'Нотариальный перевод для ГУВМ МВД — можно по скану?', expected: 'strict_destination', bucket: 'pos' },
  { q: 'Для консульства можно ли сделать нотариальный перевод по копии?', expected: 'strict_destination', bucket: 'pos' },
  { q: 'Нужен ли оригинал для нотариального перевода при легализации документа?', expected: 'strict_destination', bucket: 'pos' },
  { q: 'Нотариальный перевод для миграционной службы — что подшивается?', expected: 'strict_destination', bucket: 'pos' },
  { q: 'Для суда нотариальный перевод подшивают к оригиналу?', expected: 'strict_destination', bucket: 'pos' },
  { q: 'Нужен ли оригинал для нотариального перевода судебного решения?', expected: 'strict_destination', bucket: 'pos' },
  { q: 'Перевод для РВП: нужен ли оригинал документа?', expected: 'strict_destination', bucket: 'pos' },
  { q: 'Нужен ли оригинал для нотариального перевода трудовой книжки для суда?', expected: 'strict_destination', bucket: 'pos' },
  { q: 'Нужен ли оригинал для нотариального перевода решения суда о разводе?', expected: 'strict_destination', bucket: 'pos' },

  /* --- положительные: unknown --- */
  { q: 'Сколько стоит нотариальный перевод по скану?', expected: 'unknown', bucket: 'pos' },
  { q: 'Какие требования к документу для изготовления нотариальной копии?', expected: 'unknown', bucket: 'pos', src: 'корпус #66' },
  { q: 'Можно ли потом проставить апостиль на перевод, подшитый к ксерокопии?', expected: 'unknown', bucket: 'pos', src: 'корпус #112' },
  { q: 'Какой стандартный срок выполнения перевода и можно ли его ускорить?', expected: 'unknown', bucket: 'pos', src: 'корпус #83' },
  { q: 'Сколько стоит нотариальное заверение?', expected: 'unknown', bucket: 'pos' },
  { q: 'Как согласовывается написание ФИО и имён собственных в переводе?', expected: 'unknown', bucket: 'pos', src: 'корпус #89' },
  { q: 'Сколько страниц паспорта переводить и можно ли перевести только главную страницу?', expected: 'unknown', bucket: 'pos', src: 'корпус #47' },
  { q: 'Заверяете ли вы перевод, выполненный не у вас?', expected: 'unknown', bucket: 'pos', src: 'корпус #2' },
  { q: 'Можно ли изготовить дубликат / повторный экземпляр ранее сделанного перевода?', expected: 'unknown', bucket: 'pos', src: 'корпус #15' },
  { q: 'Нужно ли заранее согласовывать написание ФИО (и адреса/терминов) в переводе?', expected: 'unknown', bucket: 'pos', src: 'корпус #58' },
  { q: 'Сколько стоит нотариальное заверение копии?', expected: 'unknown', bucket: 'pos' },
  { q: 'Можно ли заверить перевод документа с электронным апостилем?', expected: 'unknown', bucket: 'pos', src: 'корпус #12' },

  /* --- близкие отрицательные к explain_routes --- */
  { q: 'Что нужно для заверения перевода штампами компании и нужен ли оригинал?', expected: 'unknown', bucket: 'near', nearOf: ['explain_routes'], src: 'корпус #68 — штамп бюро, не нотариус' },
  { q: 'Нужен ли оригинал паспорта для заверения перевода штампом бюро?', expected: 'unknown', bucket: 'near', nearOf: ['explain_routes'], src: 'штамп бюро против нотариуса' },
  { q: 'Сколько ждать нотариальное заверение после того, как привезли оригиналы?', expected: 'unknown', bucket: 'near', nearOf: ['explain_routes'], src: 'корпус #92 — вопрос про срок' },
  { q: 'Можно ли сделать нотариальный перевод удалённо и получить его курьером в другом городе?', expected: 'unknown', bucket: 'near', nearOf: ['explain_routes'], src: 'вопрос про доставку' },
  { q: 'Можно ли оформить заказ на нотариальный перевод онлайн?', expected: 'unknown', bucket: 'near', nearOf: ['explain_routes'], src: 'вопрос про оформление' },
  { q: 'Нотариальный перевод — можно оплатить онлайн?', expected: 'unknown', bucket: 'near', nearOf: ['explain_routes'], src: 'вопрос про оплату' },
  { q: 'Что нужно принести, чтобы забрать готовый нотариальный перевод?', expected: 'unknown', bucket: 'near', nearOf: ['explain_routes'], src: 'вопрос про выдачу' },
  { q: 'В каком виде и какого качества нужно прислать скан/фото документа для перевода и заверения?', expected: 'unknown', bucket: 'near', nearOf: ['explain_routes'], src: 'корпус #59 — качество скана' },
  { q: 'Можно ли перешить ранее сделанный перевод к оригиналу документа?', expected: 'unknown', bucket: 'near', nearOf: ['explain_routes'], src: 'корпус #19' },
  { q: 'Сколько стоит нотариальный перевод, если пришлю скан?', expected: 'unknown', bucket: 'near', nearOf: ['explain_routes'], src: 'ценовой вопрос' },
  { q: 'Нужно ли присылать документ целиком и в правильном порядке страниц?', expected: 'unknown', bucket: 'near', nearOf: ['explain_routes'], src: 'корпус #73' },
  { q: 'Можно ли нотариально заверить перевод скриншотов?', expected: 'unknown', bucket: 'near', nearOf: ['explain_routes'], src: 'корпус #70' },
  { q: 'Нотариальный перевод удалённо — как оплатить и когда будет готов?', expected: 'unknown', bucket: 'near', nearOf: ['explain_routes'] },
  { q: 'Можно ли забрать нотариальный перевод в другом офисе, не в том, где он готовится?', expected: 'unknown', bucket: 'near', nearOf: ['explain_routes'], src: 'корпус #177' },

  /* --- близкие отрицательные к strict_destination --- */
  { q: 'Нужен ли оригинал для нотариального перевода справки из МВД о регистрации автомобиля?', expected: 'explain_routes', bucket: 'near', nearOf: ['strict_destination'], src: 'МВД как источник, не инстанция' },
  { q: 'Нужен ли оригинал для нотариального перевода документа, выданного МВД?', expected: 'explain_routes', bucket: 'near', nearOf: ['strict_destination'], src: 'МВД как источник' },
  { q: 'К чему подшивается нотариальный перевод справки о несудимости из МВД?', expected: 'explain_routes', bucket: 'near', nearOf: ['strict_destination'], src: 'МВД как источник' },
  { q: 'Нужен ли оригинал для нотариального перевода, у меня гражданство Узбекистана?', expected: 'explain_routes', bucket: 'near', nearOf: ['strict_destination'], src: 'гражданство клиента, не цель подачи' },
  { q: 'Можно ли по скану сделать нотариальный перевод паспорта, у меня уже есть ВНЖ Испании?', expected: 'explain_routes', bucket: 'near', nearOf: ['strict_destination'], src: 'ВНЖ уже есть' },
  { q: 'Нужен ли оригинал для нотариального перевода справки о несудимости?', expected: 'explain_routes', bucket: 'near', nearOf: ['strict_destination'], src: 'суд против судимости' },
  { q: 'К чему подшивается нотариальный перевод для подачи в вуз?', expected: 'explain_routes', bucket: 'near', nearOf: ['strict_destination'] },
  { q: 'Нужен ли оригинал для нотариального перевода диплома для университета?', expected: 'explain_routes', bucket: 'near', nearOf: ['strict_destination'] },
  { q: 'Нужен ли оригинал для нотариального перевода, документ нужен для консультации юриста?', expected: 'explain_routes', bucket: 'near', nearOf: ['strict_destination'], src: 'консультация против консульства' },
  { q: 'Я гражданин Молдовы, нужен ли оригинал для нотариального перевода?', expected: 'explain_routes', bucket: 'near', nearOf: ['strict_destination'] },
  { q: 'Нужен ли оригинал для нотариального перевода судового журнала?', expected: 'explain_routes', bucket: 'near', nearOf: ['strict_destination'], src: 'судовой против суда' },
  { q: 'К чему подшивается нотариальный перевод свидетельства о гражданстве ребёнка?', expected: 'explain_routes', bucket: 'near', nearOf: ['strict_destination'], src: 'гражданство как тип документа' },

  /* --- близкие отрицательные к unknown (обязан был ответить) --- */
  { q: 'Нотариальный перевод сшивается с оригиналом?', expected: 'explain_routes', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Нужны ли оригиналы для нотариального перевода?', expected: 'explain_routes', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Можно ли сделать нотариальный перевод, если оригинал в другой стране?', expected: 'explain_routes', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Что подшивают к нотариальному переводу?', expected: 'explain_routes', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Нотариальный перевод делается с оригинала или с копии?', expected: 'explain_routes', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Нужно ли везти оригинал, если перевод заверяет нотариус?', expected: 'explain_routes', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Оригинал нужен для нотариального перевода?', expected: 'explain_routes', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Достаточно ли ксерокопии для нотариального перевода?', expected: 'explain_routes', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Могу ли я прислать электронную копию для нотариального перевода?', expected: 'explain_routes', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Нотариальный перевод для консульства — нужен ли оригинал?', expected: 'strict_destination', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Что нужно предоставить для нотариального перевода на легализацию?', expected: 'strict_destination', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Я не могу привезти оригинал — сделаете нотариальный перевод?', expected: 'explain_routes', bucket: 'near', nearOf: ['unknown'] },

  /* --- дальние отрицательные --- */
  { q: 'В каком режиме (часы) работают офисы?', expected: 'unknown', bucket: 'far', src: 'корпус #175' },
  { q: 'Куда обращаться по вопросам рекламы и сотрудничества?', expected: 'unknown', bucket: 'far', src: 'корпус #167' },
  { q: 'Можете ли вы предоставить скидку за отзыв?', expected: 'unknown', bucket: 'far', src: 'корпус #41' },
  { q: 'Можно ли получить готовый документ доставкой/курьером в другой город?', expected: 'unknown', bucket: 'far', src: 'корпус #178' },
  { q: 'Оказываете ли вы услуги тифлосурдоперевода / перевода жестового языка?', expected: 'unknown', bucket: 'far', src: 'корпус #49' },
  { q: 'Можно ли общаться по телефону в WhatsApp или перейти в Telegram?', expected: 'unknown', bucket: 'far', src: 'корпус #55' },
  { q: 'График работы в конце года: до какого числа работаете?', expected: 'unknown', bucket: 'far', src: 'корпус #168' },
];

measure(
  '2. resolveSourceDocumentRoute — к чему подшивается нотариальный перевод',
  ['explain_routes', 'strict_destination', 'unknown'] as const,
  SOURCE_CASES,
  (q) => resolveSourceDocumentRoute(q).kind,
  'unknown'
);

/* ================================================================== */
/* 3. Перевод для суда: resolveCourtTranslation                        */
/* ================================================================== */

type Court = 'russian_court' | 'foreign_court' | 'unknown';

const COURT_CASES: Array<Case<Court>> = [
  /* --- положительные: russian_court --- */
  { q: 'Какой пакет документов нужен для подачи перевода в суд?', expected: 'russian_court', bucket: 'pos', src: 'живой вопрос, забракованный ответ 31.07' },
  { q: 'Нужен ли нотариальный перевод для суда?', expected: 'russian_court', bucket: 'pos' },
  { q: 'Как заверить перевод для подачи в районный суд?', expected: 'russian_court', bucket: 'pos' },
  { q: 'Перевод паспорта для суда — нужен нотариус?', expected: 'russian_court', bucket: 'pos' },
  { q: 'Для суда достаточно перевода со штампом бюро?', expected: 'russian_court', bucket: 'pos' },
  { q: 'Какой перевод примет суд — нотариальный или присяжный?', expected: 'russian_court', bucket: 'pos' },
  { q: 'Нужен ли присяжный перевод для суда в Москве?', expected: 'russian_court', bucket: 'pos' },
  { q: 'Мне в суд нужен перевод свидетельства о рождении', expected: 'russian_court', bucket: 'pos' },
  { q: 'Суд требует перевод документа, что делать?', expected: 'russian_court', bucket: 'pos' },
  { q: 'Как правильно оформить перевод для арбитражного суда?', expected: 'russian_court', bucket: 'pos' },
  { q: 'Что нужно для подачи документов в суд с переводом?', expected: 'russian_court', bucket: 'pos' },
  { q: 'нужен перевот для суда', expected: 'russian_court', bucket: 'pos', src: 'опечатка' },
  { q: 'Судья требует нотариально заверенные копии — поможете?', expected: 'russian_court', bucket: 'pos', src: 'разговорное' },
  { q: 'Мировому судье нужен перевод паспорта', expected: 'russian_court', bucket: 'pos' },
  { q: 'Нужен перевод документов для судопроизводства', expected: 'russian_court', bucket: 'pos' },
  { q: 'Перевод для подачи иска — какой нужен?', expected: 'russian_court', bucket: 'pos' },

  /* --- положительные: foreign_court --- */
  { q: 'Нужен ли перевод для суда в Германии?', expected: 'foreign_court', bucket: 'pos' },
  { q: 'Суд в Италии требует перевод — что делать?', expected: 'foreign_court', bucket: 'pos' },
  { q: 'Как оформить перевод документов для суда за рубежом?', expected: 'foreign_court', bucket: 'pos' },
  { q: 'Перевод для суда в Испании — делаете?', expected: 'foreign_court', bucket: 'pos' },
  { q: 'Нужен ли присяжный перевод для суда за границей?', expected: 'foreign_court', bucket: 'pos' },
  { q: 'Иностранный суд требует перевод документа', expected: 'foreign_court', bucket: 'pos' },
  { q: 'Перевод для суда в Польше', expected: 'foreign_court', bucket: 'pos' },
  { q: 'Нужен ли перевод для суда в Узбекистане?', expected: 'foreign_court', bucket: 'pos' },
  { q: 'Нужен ли нотариальный перевод для зарубежного суда?', expected: 'foreign_court', bucket: 'pos' },
  { q: 'Перевод документов для суда в Казахстане', expected: 'foreign_court', bucket: 'pos' },
  { q: 'Суд в Черногории требует перевод документов', expected: 'foreign_court', bucket: 'pos' },
  { q: 'Перевод для суда в Грузии — сделаете?', expected: 'foreign_court', bucket: 'pos' },

  /* --- положительные: unknown --- */
  { q: 'Сколько стоит перевод паспорта?', expected: 'unknown', bucket: 'pos' },
  { q: 'Как рассчитывается стоимость письменного перевода и что такое условная страница?', expected: 'unknown', bucket: 'pos', src: 'корпус #125' },
  { q: 'Можно ли поставить апостиль на диплом?', expected: 'unknown', bucket: 'pos' },
  { q: 'Нужен ли оригинал для нотариального перевода?', expected: 'unknown', bucket: 'pos' },
  { q: 'Какие у вас офисы в Санкт-Петербурге и где они находятся?', expected: 'unknown', bucket: 'pos', src: 'корпус #169' },
  { q: 'Сколько хранятся готовые заверенные переводы в офисе?', expected: 'unknown', bucket: 'pos', src: 'корпус #140' },
  { q: 'Что писать в назначении платежа при оплате по карте?', expected: 'unknown', bucket: 'pos', src: 'корпус #143' },
  { q: 'Делаете ли вы апостиль на документы (свидетельства, справки) и сколько это занимает?', expected: 'unknown', bucket: 'pos', src: 'корпус #26' },
  { q: 'Справка о судимости — нужен перевод?', expected: 'unknown', bucket: 'pos', src: 'судимость против суда' },
  { q: 'Можно ли перевести судовой журнал?', expected: 'unknown', bucket: 'pos', src: 'судовой против суда' },
  { q: 'Нужен ли присяжный перевод в России?', expected: 'unknown', bucket: 'pos', src: 'вопрос вне суда' },
  { q: 'Можно ли получить дубликат судебного приказа?', expected: 'unknown', bucket: 'pos' },

  /* --- близкие отрицательные к russian_court --- */
  { q: 'Какой документ нужен, чтобы поставить апостиль на выписку ЕГРЮЛ или судебное решение?', expected: 'unknown', bucket: 'near', nearOf: ['russian_court'], src: 'корпус #67 — вопрос про апостиль' },
  { q: 'Как поставить апостиль на судебный документ?', expected: 'unknown', bucket: 'near', nearOf: ['russian_court'], src: 'вопрос про апостиль' },
  { q: 'Сколько стоит перевод судебного решения?', expected: 'unknown', bucket: 'near', nearOf: ['russian_court'], src: 'ценовой вопрос' },
  { q: 'Предоставляете ли переводчика для присутствия в суде?', expected: 'unknown', bucket: 'near', nearOf: ['russian_court'], src: 'корпус #50 — устный перевод' },
  { q: 'Нужен ли апостиль на судебное решение для Германии?', expected: 'unknown', bucket: 'near', nearOf: ['russian_court'], src: 'вопрос про апостиль' },
  { q: 'Сколько по времени ставится апостиль на судебные документы?', expected: 'unknown', bucket: 'near', nearOf: ['russian_court'], src: 'вопрос про срок' },
  { q: 'Как долго Минюст ставит апостиль на судебные документы?', expected: 'unknown', bucket: 'near', nearOf: ['russian_court'] },
  { q: 'Как оформить перевод судебной практики для научной работы?', expected: 'unknown', bucket: 'near', nearOf: ['russian_court'], src: 'не подача в суд' },
  { q: 'Судебные приставы требуют перевод документа', expected: 'unknown', bucket: 'near', nearOf: ['russian_court'], src: 'приставы, не суд' },
  { q: 'Нужен ли перевод для суда в Германии?', expected: 'foreign_court', bucket: 'near', nearOf: ['russian_court'] },
  { q: 'Сколько стоит нотариальное заверение судебного документа?', expected: 'unknown', bucket: 'near', nearOf: ['russian_court'], src: 'ценовой вопрос' },
  { q: 'Можно ли перевести судебно-медицинское заключение?', expected: 'unknown', bucket: 'near', nearOf: ['russian_court'], src: 'судебно-медицинский, не суд' },

  /* --- близкие отрицательные к foreign_court --- */
  { q: 'Нужен ли нотариальный перевод для суда, если ответчик за границей?', expected: 'russian_court', bucket: 'near', nearOf: ['foreign_court'], src: 'суд российский' },
  { q: 'Документы для суда получены за рубежом, нужен перевод', expected: 'russian_court', bucket: 'near', nearOf: ['foreign_court'], src: 'место получения, не место суда' },
  { q: 'Перевод для суда, истец живёт за границей', expected: 'russian_court', bucket: 'near', nearOf: ['foreign_court'] },
  { q: 'Свидетель за рубежом — нужен перевод документов для суда', expected: 'russian_court', bucket: 'near', nearOf: ['foreign_court'] },
  { q: 'Суд запросил перевод документов, полученных за границей', expected: 'russian_court', bucket: 'near', nearOf: ['foreign_court'] },
  { q: 'Нужен ли перевод для суда в Москве?', expected: 'russian_court', bucket: 'near', nearOf: ['foreign_court'] },
  { q: 'Мой диплом из Германии, нужен перевод для российского суда', expected: 'russian_court', bucket: 'near', nearOf: ['foreign_court'] },
  { q: 'Для российского суда нужен перевод иностранного документа с апостилем', expected: 'russian_court', bucket: 'near', nearOf: ['foreign_court'] },
  { q: 'Нужен ли перевод для суда, если я гражданин Испании?', expected: 'russian_court', bucket: 'near', nearOf: ['foreign_court'] },
  { q: 'Нужен перевод справки для суда в Санкт-Петербурге', expected: 'russian_court', bucket: 'near', nearOf: ['foreign_court'] },
  { q: 'Как перевести документы для суда в Крыму?', expected: 'russian_court', bucket: 'near', nearOf: ['foreign_court'] },
  { q: 'Перевод для суда, документы привезены из Германии', expected: 'russian_court', bucket: 'near', nearOf: ['foreign_court'] },

  /* --- близкие отрицательные к unknown (обязан был ответить) --- */
  { q: 'Судья запросил перевод документа', expected: 'russian_court', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Перевод для мирового судьи — какой нужен?', expected: 'russian_court', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Нужен перевод документов для арбитража', expected: 'russian_court', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Перевод для судебного заседания', expected: 'russian_court', bucket: 'near', nearOf: ['unknown'] },
  { q: 'В мировой суд нужен перевод', expected: 'russian_court', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Суд в Финляндии требует перевод документов', expected: 'foreign_court', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Нужен перевод для суда в Сербии', expected: 'foreign_court', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Перевод для суда на Кипре', expected: 'foreign_court', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Какие бумаги нужны для суда с переводом?', expected: 'russian_court', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Нужен перевод для подачи в суд Санкт-Петербурга', expected: 'russian_court', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Перевод документа для суда, заверенный нотариусом — подойдёт?', expected: 'russian_court', bucket: 'near', nearOf: ['unknown'] },
  { q: 'Что требует суд от перевода документа?', expected: 'russian_court', bucket: 'near', nearOf: ['unknown'] },

  /* --- дальние отрицательные --- */
  { q: 'В каком режиме (часы) работают офисы?', expected: 'unknown', bucket: 'far', src: 'корпус #175' },
  { q: 'Куда обращаться по вопросам рекламы и сотрудничества?', expected: 'unknown', bucket: 'far', src: 'корпус #167' },
  { q: 'Можете ли вы предоставить скидку за отзыв?', expected: 'unknown', bucket: 'far', src: 'корпус #41' },
  { q: 'Можно ли общаться по телефону в WhatsApp или перейти в Telegram?', expected: 'unknown', bucket: 'far', src: 'корпус #55' },
  { q: 'Оказываете ли вы услуги тифлосурдоперевода?', expected: 'unknown', bucket: 'far', src: 'корпус #49' },
  { q: 'Можно ли оплатить по безналичному расчёту и выставить счёт на компанию?', expected: 'unknown', bucket: 'far', src: 'корпус #158' },
  { q: 'Где находится офис на Ладожской и какой график?', expected: 'unknown', bucket: 'far', src: 'корпус #171' },
];

measure(
  '3. resolveCourtTranslation — перевод для суда',
  ['russian_court', 'foreign_court', 'unknown'] as const,
  COURT_CASES,
  (q) => resolveCourtTranslation(q).kind,
  'unknown'
);

/* ================================================================== */
/* 3b. Присяжный перевод в ответе: checkSwornTranslationClaim           */
/* ================================================================== */

type Sworn = 'violation' | 'safe';

const SWORN_CASES: Array<Case<Sworn>> = [
  /* --- положительные: violation (обязан поймать) --- */
  { q: 'Мы можем сделать присяжный перевод документа.', expected: 'violation', bucket: 'pos' },
  { q: 'Для суда подойдёт присяжный перевод.', expected: 'violation', bucket: 'pos' },
  { q: 'Стоимость присяжного перевода — 2500 рублей за страницу.', expected: 'violation', bucket: 'pos' },
  { q: 'Вы можете выбрать нотариальный или присяжный перевод.', expected: 'violation', bucket: 'pos', src: 'забракованный ответ 31.07' },
  { q: 'Присяжный перевод делается за 3 рабочих дня.', expected: 'violation', bucket: 'pos' },
  { q: 'Присяжный переводчик заверит перевод своей печатью, оформим за вас.', expected: 'violation', bucket: 'pos' },
  { q: 'Рекомендуем присяжный перевод — он принимается везде.', expected: 'violation', bucket: 'pos' },
  { q: 'Мы оформим присяжный перевод удалённо.', expected: 'violation', bucket: 'pos' },
  { q: 'Присяжный перевод у нас стоит дешевле нотариального.', expected: 'violation', bucket: 'pos' },
  { q: 'Есть два варианта: нотариальное заверение и присяжный перевод.', expected: 'violation', bucket: 'pos' },
  { q: 'Для подачи в консульство подойдёт присяжный перевод, мы его сделаем.', expected: 'violation', bucket: 'pos' },
  { q: 'Мы можем сделать присяжный перевод для другой страны.', expected: 'violation', bucket: 'pos' },
  { q: 'Присяжный перевод для иностранного суда мы оформим сами.', expected: 'violation', bucket: 'pos' },
  { q: 'Для посольства мы сделаем присяжный перевод за 3 дня.', expected: 'violation', bucket: 'pos' },
  { q: 'Если документ едет за границу, закажите у нас присяжный перевод.', expected: 'violation', bucket: 'pos' },
  { q: 'Мы не делаем нотариальный перевод, только присяжный.', expected: 'violation', bucket: 'pos' },

  /* --- положительные: safe (обязан пропустить) --- */
  { q: 'В России института присяжного перевода не существует.', expected: 'safe', bucket: 'pos' },
  { q: 'Присяжных переводчиков в России нет.', expected: 'safe', bucket: 'pos' },
  { q: 'За рубежом может действовать институт присяжного переводчика.', expected: 'safe', bucket: 'pos' },
  { q: 'Присяжный перевод возможен в другой стране, у нас — нотариальный.', expected: 'safe', bucket: 'pos' },
  { q: 'Такой перевод мы не делаем: присяжных переводчиков в РФ нет.', expected: 'safe', bucket: 'pos' },
  { q: 'Мы делаем нотариальный перевод; присяжный перевод в России не предусмотрен.', expected: 'safe', bucket: 'pos' },
  { q: 'Институт присяжного перевода в РФ отсутствует.', expected: 'safe', bucket: 'pos' },
  { q: 'Присяжный перевод — это зарубежная практика.', expected: 'safe', bucket: 'pos' },
  { q: 'Мы не оказываем услугу присяжного перевода.', expected: 'safe', bucket: 'pos' },
  { q: 'Нотариальное заверение перевода — 1100 рублей за документ.', expected: 'safe', bucket: 'pos', src: 'без упоминания присяжного' },
  { q: 'Апостиль на диплом ставит образовательный комитет.', expected: 'safe', bucket: 'pos', src: 'без упоминания присяжного' },
  { q: 'Про присяжный перевод: такой услуги у нас нет.', expected: 'safe', bucket: 'pos' },

  /* --- близкие отрицательные к violation (верные фразы, глушить нельзя) --- */
  { q: 'Присяжный перевод в России не практикуется.', expected: 'safe', bucket: 'near', nearOf: ['violation'] },
  { q: 'Присяжный перевод оформляется только за пределами России.', expected: 'safe', bucket: 'near', nearOf: ['violation'] },
  { q: 'В российском законодательстве присяжный перевод отсутствует как понятие.', expected: 'safe', bucket: 'near', nearOf: ['violation'] },
  { q: 'Присяжный перевод — институт, которого в России нет.', expected: 'safe', bucket: 'near', nearOf: ['violation'] },
  { q: 'Клиенты часто спрашивают про присяжный перевод; в России его роль выполняет нотариальное заверение.', expected: 'safe', bucket: 'near', nearOf: ['violation'] },
  { q: 'Присяжный перевод и нотариальный перевод — не одно и то же; в России применяется второй.', expected: 'safe', bucket: 'near', nearOf: ['violation'] },
  { q: 'Присяжный перевод нужен не всегда, уточните требования принимающей стороны.', expected: 'safe', bucket: 'near', nearOf: ['violation'] },
  { q: 'Аналог присяжного перевода в России — нотариально заверенный перевод.', expected: 'safe', bucket: 'near', nearOf: ['violation'] },
  { q: 'Присяжный перевод бывает нужен для документов, подаваемых в Германии.', expected: 'safe', bucket: 'near', nearOf: ['violation'] },
  { q: 'Присяжный перевод — термин из практики Евросоюза.', expected: 'safe', bucket: 'near', nearOf: ['violation'] },
  { q: 'Присяжный перевод российским законом не введён.', expected: 'safe', bucket: 'near', nearOf: ['violation'] },
  { q: 'В нашей стране присяжный перевод заменяется нотариальным заверением подписи переводчика.', expected: 'safe', bucket: 'near', nearOf: ['violation'] },

  /* --- близкие отрицательные к safe (нарушения, пропускать нельзя) --- */
  { q: 'Мы делаем присяжный перевод для другой страны за 2500 рублей.', expected: 'violation', bucket: 'near', nearOf: ['safe'] },
  { q: 'Присяжный перевод в консульство стоит 3000 рублей.', expected: 'violation', bucket: 'near', nearOf: ['safe'] },
  { q: 'Для зарубежного вуза мы оформим присяжный перевод.', expected: 'violation', bucket: 'near', nearOf: ['safe'] },
  { q: 'Присяжный перевод для той страны сделаем мы.', expected: 'violation', bucket: 'near', nearOf: ['safe'] },
  { q: 'Присяжный перевод для принимающей страны мы выполним сами.', expected: 'violation', bucket: 'near', nearOf: ['safe'] },
  { q: 'Для посольства Италии закажите у нас присяжный перевод.', expected: 'violation', bucket: 'near', nearOf: ['safe'] },
  { q: 'Мы не делаем обычный перевод, только присяжный.', expected: 'violation', bucket: 'near', nearOf: ['safe'] },
  { q: 'Присяжный перевод для иностранного документа мы выполним за два дня.', expected: 'violation', bucket: 'near', nearOf: ['safe'] },
  { q: 'Если документ едет за рубеж, мы оформим присяжный перевод.', expected: 'violation', bucket: 'near', nearOf: ['safe'] },
  { q: 'Наши присяжные переводчики работают с другими странами.', expected: 'violation', bucket: 'near', nearOf: ['safe'] },
  { q: 'Мы не можем сделать нотариальный перевод, зато сделаем присяжный.', expected: 'violation', bucket: 'near', nearOf: ['safe'] },
  { q: 'Присяжный перевод для консульства — наша обычная услуга.', expected: 'violation', bucket: 'near', nearOf: ['safe'] },

  /* --- дальние отрицательные --- */
  { q: 'Офисы работают с 10:00 до 19:00 по будням.', expected: 'safe', bucket: 'far' },
  { q: 'Готовые заказы хранятся в офисе три месяца.', expected: 'safe', bucket: 'far' },
  { q: 'Ксерокопия стоит 30 рублей за страницу.', expected: 'safe', bucket: 'far' },
  { q: 'Апостиль на справку о несудимости ставит МВД.', expected: 'safe', bucket: 'far' },
  { q: 'Доставка курьером в другой город возможна.', expected: 'safe', bucket: 'far' },
  { q: 'Предоплата нужна для запуска заказа в работу.', expected: 'safe', bucket: 'far' },
  { q: 'Условная страница — это 1800 знаков с пробелами.', expected: 'safe', bucket: 'far' },
];

measure(
  '3b. checkSwornTranslationClaim — присяжный перевод в готовом ответе',
  ['violation', 'safe'] as const,
  SWORN_CASES,
  (a) => (checkSwornTranslationClaim(a).safe ? 'safe' : 'violation'),
  'safe'
);

/* ================================================================== */
/* 4. Приписка цены услуге: checkCertificationPriceAttribution          */
/* ================================================================== */

type Price = 'contradiction' | 'consistent';

const PRICE_CASES: Array<Case<Price>> = [
  /* --- положительные: contradiction (обязан объявить) --- */
  { q: 'Нотариальное заверение перевода — 260 рублей за страницу.', expected: 'contradiction', bucket: 'pos', src: 'исходный дефект «260 вместо 1100»' },
  { q: 'Нотариальное заверение перевода стоит 300 рублей за документ.', expected: 'contradiction', bucket: 'pos' },
  { q: 'Заверение перевода у нотариуса — 500 рублей за документ.', expected: 'contradiction', bucket: 'pos' },
  { q: 'Нотариальное заверение копии — 1100 рублей за страницу.', expected: 'contradiction', bucket: 'pos' },
  { q: 'Двуязычное нотариальное заверение — 1100 рублей за документ.', expected: 'contradiction', bucket: 'pos' },
  { q: 'Срочное нотариальное заверение перевода — 1100 рублей за документ.', expected: 'contradiction', bucket: 'pos' },
  { q: 'Заверение перевода подписью переводчика и штампом бюро — 500 рублей за документ.', expected: 'contradiction', bucket: 'pos' },
  { q: 'Оформление повторного экземпляра перевода — 500 рублей за документ.', expected: 'contradiction', bucket: 'pos' },
  { q: 'Перевод отметок — 50 рублей за отметку.', expected: 'contradiction', bucket: 'pos' },
  { q: 'Перевод виз — 200 рублей за визу.', expected: 'contradiction', bucket: 'pos' },
  { q: 'Сканирование — 100 рублей за страницу.', expected: 'contradiction', bucket: 'pos' },
  { q: 'Ксерокопия — 100 рублей за страницу.', expected: 'contradiction', bucket: 'pos' },
  { q: 'Набор текста на русском языке — 300 рублей за условную страницу.', expected: 'contradiction', bucket: 'pos' },
  { q: 'Нотариальное заверение тождественности — 260 рублей за страницу.', expected: 'contradiction', bucket: 'pos' },
  { q: 'Нотариальное заверение перевода — 1100 рублей за страницу.', expected: 'contradiction', bucket: 'pos', src: 'верная сумма, чужая единица' },
  { q: 'Заверение — 260 рублей.', expected: 'contradiction', bucket: 'pos', src: 'голое «заверение»' },

  /* --- положительные: consistent (верные ответы, глушить нельзя) --- */
  { q: 'Нотариальное заверение перевода — 1100 рублей за документ.', expected: 'consistent', bucket: 'pos' },
  { q: 'Нотариальное заверение копии — 260 рублей за страницу.', expected: 'consistent', bucket: 'pos' },
  { q: 'Срочное нотариальное заверение перевода — 1250 рублей за документ.', expected: 'consistent', bucket: 'pos' },
  { q: 'Двуязычное нотариальное заверение перевода — 1300 рублей за документ.', expected: 'consistent', bucket: 'pos' },
  { q: 'Срочное двуязычное заверение — 1450 рублей за документ.', expected: 'consistent', bucket: 'pos' },
  { q: 'Заверение штампом бюро — 250 рублей за документ.', expected: 'consistent', bucket: 'pos' },
  { q: 'Ксерокопия — 30 рублей за страницу.', expected: 'consistent', bucket: 'pos' },
  { q: 'Сканирование — 40 рублей за страницу.', expected: 'consistent', bucket: 'pos' },
  { q: 'Набор текста на русском языке — 180 рублей за условную страницу.', expected: 'consistent', bucket: 'pos' },
  { q: 'Оформление повторного экземпляра перевода — 150 рублей за документ.', expected: 'consistent', bucket: 'pos' },
  { q: 'Вёрстка документа — от 60 рублей за страницу А4.', expected: 'consistent', bucket: 'pos', src: 'нижняя граница, сверять нельзя' },
  { q: 'Нотариальное заверение перевода — 1100 рублей за документ, при срочности 1250 рублей.', expected: 'consistent', bucket: 'pos' },

  /* --- близкие отрицательные к contradiction (верные ответы) --- */
  { q: 'Паспорт с переводом и нотариальным заверением — 1540 рублей.', expected: 'consistent', bucket: 'near', nearOf: ['contradiction'], src: 'комплексная цена' },
  { q: 'Перевод паспорта (1 условная страница) и нотариальное заверение — 1540 рублей.', expected: 'consistent', bucket: 'near', nearOf: ['contradiction'], src: 'комплексная цена' },
  { q: 'Заверение — 250 рублей, если это штамп бюро.', expected: 'consistent', bucket: 'near', nearOf: ['contradiction'], src: 'услуга уточнена правее' },
  { q: 'Перевод свидетельства о рождении с нотариальным заверением — 1450 рублей.', expected: 'consistent', bucket: 'near', nearOf: ['contradiction'] },
  { q: 'Итого за перевод и нотариальное заверение — 1540 рублей.', expected: 'consistent', bucket: 'near', nearOf: ['contradiction'] },
  { q: 'Перевод диплома плюс нотариальное заверение — 2200 рублей.', expected: 'consistent', bucket: 'near', nearOf: ['contradiction'] },
  { q: 'Стоимость перевода паспорта под ключ, включая нотариальное заверение, — 1540 рублей.', expected: 'consistent', bucket: 'near', nearOf: ['contradiction'] },
  { q: 'Перевод, вёрстка и нотариальное заверение — 1800 рублей.', expected: 'consistent', bucket: 'near', nearOf: ['contradiction'], src: 'комплексная цена через «и»' },
  { q: 'За перевод и нотариальное заверение вы заплатите 1540 рублей.', expected: 'consistent', bucket: 'near', nearOf: ['contradiction'], src: 'комплексная цена через «и»' },
  { q: 'Нотариальное заверение перевода — 1100 рублей за документ; за срочность добавится 150 рублей.', expected: 'consistent', bucket: 'near', nearOf: ['contradiction'] },
  { q: 'Заверение перевода — 1100 рублей, а нотариальная копия — 260 рублей за страницу.', expected: 'consistent', bucket: 'near', nearOf: ['contradiction'] },
  { q: 'Комплект: перевод и нотариальное заверение — 1540 рублей.', expected: 'consistent', bucket: 'near', nearOf: ['contradiction'], src: 'комплексная цена через «и»' },
  { q: 'Перевод аттестата с нотариальным заверением обойдётся в 2000 рублей.', expected: 'consistent', bucket: 'near', nearOf: ['contradiction'] },
  { q: 'Мы берём 1100 рублей за нотариальное заверение перевода.', expected: 'consistent', bucket: 'near', nearOf: ['contradiction'], src: 'услуга правее числа' },

  /* --- близкие отрицательные к consistent (ошибки, пропускать нельзя) --- */
  { q: 'Мы берём 260 рублей за нотариальное заверение перевода.', expected: 'contradiction', bucket: 'near', nearOf: ['consistent'], src: 'услуга правее числа' },
  { q: 'Стоимость — 260 рублей за страницу, речь про нотариальное заверение перевода.', expected: 'contradiction', bucket: 'near', nearOf: ['consistent'], src: 'услуга правее числа' },
  { q: 'Нотариальное заверение перевода — 260 рублей за документ, а нотариальная копия — 260 рублей за страницу.', expected: 'contradiction', bucket: 'near', nearOf: ['consistent'], src: 'услуга правее гасит проверку' },
  { q: 'Итого нотариальное заверение перевода — 260 рублей за страницу.', expected: 'contradiction', bucket: 'near', nearOf: ['consistent'], src: 'слово «итого» гасит проверку' },
  { q: 'Нотариальное заверение перевода стоит 260 рублей, если нужна копия документа.', expected: 'contradiction', bucket: 'near', nearOf: ['consistent'], src: 'слово «копия» правее гасит проверку' },
  { q: 'Заверение перевода стоит 260 рублей, ксерокопия — 30 рублей за страницу.', expected: 'contradiction', bucket: 'near', nearOf: ['consistent'] },
  { q: 'Перевод отметок — 50 рублей за отметку, перевод виз — 100 рублей за визу.', expected: 'contradiction', bucket: 'near', nearOf: ['consistent'] },
  { q: 'Всего за нотариальное заверение перевода — 260 рублей за страницу.', expected: 'contradiction', bucket: 'near', nearOf: ['consistent'], src: 'слово «всего» гасит проверку' },
  { q: 'Нотариальное заверение перевода в сумме 260 рублей за страницу.', expected: 'contradiction', bucket: 'near', nearOf: ['consistent'] },
  { q: 'Общая стоимость нотариального заверения перевода — 260 рублей за страницу.', expected: 'contradiction', bucket: 'near', nearOf: ['consistent'] },
  { q: 'Нотариальное заверение перевода стоит 260 рублей за скан.', expected: 'contradiction', bucket: 'near', nearOf: ['consistent'] },
  { q: 'Цена — 260 рублей, это нотариальное заверение перевода.', expected: 'contradiction', bucket: 'near', nearOf: ['consistent'], src: 'услуга правее числа' },

  /* --- дальние отрицательные --- */
  { q: 'Офисы работают с 10:00 до 19:00 по будням.', expected: 'consistent', bucket: 'far' },
  { q: 'Заказ можно забрать в любом офисе по предварительному согласованию.', expected: 'consistent', bucket: 'far' },
  { q: 'Апостиль ставится в Министерстве юстиции за 3 рабочих дня.', expected: 'consistent', bucket: 'far' },
  { q: 'Готовые заказы храним три месяца.', expected: 'consistent', bucket: 'far' },
  { q: 'Доставка курьером в другой город возможна.', expected: 'consistent', bucket: 'far' },
  { q: 'Написание ФИО согласовывается с клиентом заранее.', expected: 'consistent', bucket: 'far' },
  { q: 'Оплатить можно картой или по безналичному расчёту.', expected: 'consistent', bucket: 'far' },
];

measure(
  '4. checkCertificationPriceAttribution — приписка цены услуге',
  ['contradiction', 'consistent'] as const,
  PRICE_CASES,
  (a) => (checkCertificationPriceAttribution(a).consistent ? 'consistent' : 'contradiction'),
  'consistent'
);

/* ================================================================== */
/* 5. Устойчивость к перефразировке                                    */
/* ================================================================== */

const apostille = (q: string): string => resolveApostilleTerritoriality(q).kind;
const source = (q: string): string => resolveSourceDocumentRoute(q).kind;
const court = (q: string): string => resolveCourtTranslation(q).kind;
const sworn = (a: string): string => (checkSwornTranslationClaim(a).safe ? 'safe' : 'violation');
const price = (a: string): string =>
  checkCertificationPriceAttribution(a).consistent ? 'consistent' : 'contradiction';

const PARAPHRASE_GROUPS: ParaphraseGroup[] = [
  {
    id: 'СОР из Москвы',
    module: 'апостиль',
    expected: 'reject_original',
    run: apostille,
    variants: [
      'Свидетельство о рождении выдано в Москве, нужен апостиль',
      'Нужен апостиль на СОР, выдано в Москве',
      'Апостиль на свид-во о рождении, выдано в Москве',
      'Метрика выдана в Москве, можно ли поставить апостиль?',
    ],
  },
  {
    id: 'диплом из Саратова',
    module: 'апостиль',
    expected: 'accept',
    run: apostille,
    variants: [
      'Можно ли поставить апостиль на диплом, выданный в Саратове?',
      'Нужен апостиль на диплом из Саратова',
      'Диплом саратовского вуза — поставите апостиль?',
      'Апостиль на диплом с приложением, вуз в Саратове',
    ],
  },
  {
    id: 'справка о несудимости из СПб',
    module: 'апостиль',
    expected: 'accept',
    run: apostille,
    variants: [
      'Справка о несудимости получена в Петербурге, нужен апостиль',
      'Нужен апостиль на справку об отсутствии судимости, выдана в Петербурге',
      'Апостиль на СОН, выдана в СПб',
      'Справка из МВД о несудимости выдана в Санкт-Петербурге, нужен апостиль',
    ],
  },
  {
    id: 'к чему подшивается',
    module: 'исходник',
    expected: 'explain_routes',
    run: source,
    variants: [
      'К чему подшивается нотариальный перевод?',
      'Нужен ли оригинал документа для заверения и сшития перевода?',
      'Нотариальный перевод подшивают к оригиналу или к копии?',
      'Достаточно ли скана для нотариального перевода?',
    ],
  },
  {
    id: 'исходник для легализации',
    module: 'исходник',
    expected: 'strict_destination',
    run: source,
    variants: [
      'Нужен ли оригинал для нотариального перевода на консульскую легализацию?',
      'Для консульства нотариальный перевод подшивают к оригиналу?',
      'Документ идёт в посольство — к чему подшивается нотариальный перевод?',
      'Перевод для легализации: нужен ли оригинал документа?',
    ],
  },
  {
    id: 'перевод для российского суда',
    module: 'суд',
    expected: 'russian_court',
    run: court,
    variants: [
      'Какой пакет документов нужен для подачи перевода в суд?',
      'Нужен ли нотариальный перевод для суда?',
      'Судья требует перевод документа — какой подойдёт?',
      'Перевод для подачи иска — какой нужен?',
    ],
  },
  {
    id: 'перевод для зарубежного суда',
    module: 'суд',
    expected: 'foreign_court',
    run: court,
    variants: [
      'Нужен ли перевод для суда в Германии?',
      'Перевод для суда за рубежом — как оформить?',
      'Нужен ли нотариальный перевод для зарубежного суда?',
      'Перевод для суда в Казахстане — сделаете?',
    ],
  },
  {
    id: 'обещание присяжного перевода',
    module: 'присяжный',
    expected: 'violation',
    run: sworn,
    variants: [
      'Мы можем сделать присяжный перевод документа.',
      'Для суда подойдёт присяжный перевод, мы его оформим.',
      'Для подачи в консульство подойдёт присяжный перевод, мы его сделаем.',
      'Присяжный перевод для другой страны мы выполним сами.',
    ],
  },
  {
    id: 'цена заверения названа неверно',
    module: 'цена',
    expected: 'contradiction',
    run: price,
    variants: [
      'Нотариальное заверение перевода — 260 рублей за страницу.',
      'Заверение перевода у нотариуса стоит 260 рублей за страницу.',
      'Мы берём 260 рублей за нотариальное заверение перевода.',
      'Итого нотариальное заверение перевода — 260 рублей за страницу.',
    ],
  },
  {
    id: 'цена заверения названа верно',
    module: 'цена',
    expected: 'consistent',
    run: price,
    variants: [
      'Нотариальное заверение перевода — 1100 рублей за документ.',
      'Заверение перевода у нотариуса стоит 1100 рублей за документ.',
      'Перевод паспорта с нотариальным заверением — 1540 рублей.',
      'Перевод паспорта и нотариальное заверение — 1540 рублей.',
    ],
  },
];

const paraphrase = measureParaphrase(PARAPHRASE_GROUPS);

/* ================================================================== */
/* Итог                                                                */
/* ================================================================== */

console.log(`\n${'='.repeat(78)}`);
console.log('СВОДКА');
console.log('='.repeat(78));
console.log(
  'модуль / маршрут'.padEnd(46) + 'ЛП близкие'.padEnd(14) + 'точность'
);
console.log('-'.repeat(78));
for (const m of moduleReports) {
  const short = m.title.split(' — ')[0].split(' (')[0].slice(0, 26);
  for (const r of m.rows) {
    console.log(`${short} / ${r.route}`.padEnd(46) + r.nearFp.padEnd(14) + r.precision);
  }
}
console.log('-'.repeat(78));
console.log(`Устойчивость к перефразировке: ${paraphrase.stable}/${paraphrase.total} наборов дали один вердикт`);
console.log(`Ложноположительных всего: ${allFalsePositives.length}`);
console.log(`Пропусков всего: ${allMisses.length}`);
console.log(`ФАКТИЧЕСКИ ВЫПОЛНЕНО ПРОВЕРОК: ${evaluations}`);
