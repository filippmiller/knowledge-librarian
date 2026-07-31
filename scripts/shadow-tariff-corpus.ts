/**
 * Теневой прогон тарифной сетки по корпусу реальных вопросов.
 *
 * ЗАЧЕМ ИМЕННО ТАК, А НЕ ЖУРНАЛОМ В ПРОДЕ
 *
 * Хендофф предполагал теневой режим внутри движка: сетка отвечает параллельно
 * живому потоку, расхождения копятся в журнале. Замер трафика этот план убил:
 * за 30 дней в базе 319 вопросов, из них подавляющая часть — прогоны моих же
 * скриптов (источник `API`), а живых сообщений в Телеграме за всю историю 48.
 * При таком потоке журнал накопил бы единицы наблюдений за месяц, и решение
 * «включать сетку или нет» пришлось бы принимать по трём строкам.
 *
 * Здесь вместо этого берётся корпус, который уже собран: 180 вопросов клиентов
 * из переписки Битрикса за май 2026 с ответами живых операторов и частотами.
 * Тот же корпус, на котором измерены 64% покрытия и 7,4% ошибок, — значит
 * результаты сравнимы с базовой точкой.
 *
 * ЧТО ЭТОТ ЗАМЕР СПОСОБЕН ДОКАЗАТЬ, А ЧТО НЕТ
 *
 * Ответ оператора — наземная истина о том, ЧЕГО клиент хотел, но не о цене:
 * предыдущий аудит показал, что сверяемой цены нет ни в одном из 180 ответов.
 * Поэтому замер отвечает на вопрос «в ту ли услугу попадает сетка», а не «верна
 * ли её цена». Цена сетки уже сверена с бумагой отдельно (12 проверок,
 * 0 провалов, `scripts/verify-tariffs.ts`) — здесь проверяется маршрутизация,
 * потому что именно на ней прошлый замер потерял всё: детерминированные ветки
 * дали 6 отправленных и 0 верных.
 *
 * ЗНАМЕНАТЕЛЬ СОХРАНЯЕТСЯ ЦЕЛИКОМ. Строка пишется на КАЖДЫЙ вопрос корпуса, в
 * том числе на те, где сетка промолчала. Иначе доля промахов считается от числа
 * срабатываний, а промахи молчания — самые дорогие — не видны вовсе.
 *
 * Запуск:  railway run npx tsx scripts/shadow-tariff-corpus.ts
 * Смоук:   LIMIT=10 railway run npx tsx scripts/shadow-tariff-corpus.ts
 * Заново:  FRESH=1 railway run npx tsx scripts/shadow-tariff-corpus.ts
 * Без ИИ:  NO_JUDGE=1 … — только детерминированная часть, мгновенно
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createChatCompletion, normalizeJsonResponse } from '../src/lib/ai/chat-provider';
import { getTariffs } from '../src/lib/knowledge/tariff-store';
import {
  lookupTariffForQuestion,
  describeTariff,
  questionAsksPrice,
} from '../src/lib/knowledge/tariff-lookup';
import { checkStalePrice } from '../src/lib/knowledge/stale-price-check';
import type { TariffRecord } from '../src/lib/knowledge/tariffs';
import prisma from '../src/lib/db';

const CORPUS = 'docs/email-bot/may2026-knowledge-base-final.json';
const RESULTS = 'docs/bot-audit/.tariff-shadow-results.jsonl';
const LIMIT = Number(process.env.LIMIT ?? 1000);
const NO_JUDGE = process.env.NO_JUDGE === '1';
const PACE_MS = 1200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CorpusCase {
  category: string;
  question: string;
  answer: string;
  price_dependent: boolean;
  freq: number;
  confidence: number;
}

type ShadowClass =
  /** Сетка назвала одну услугу — есть что проверять. */
  | 'FIRED_SINGLE'
  /** Сетка назвала одну услугу в нескольких вариантах по сроку. */
  | 'FIRED_VARIANTS'
  /** Вопрос про цену, а услуга не опознана — кандидат в промахи молчания. */
  | 'SILENT_ON_PRICE'
  /** Вопрос не про цену: молчание сетки здесь и есть верное поведение. */
  | 'SILENT_OFF_TOPIC';

interface Row {
  n: number;
  question: string;
  operator: string;
  category: string;
  freq: number;
  priceDependent: boolean;
  asksPrice: boolean;
  cls: ShadowClass;
  /** Что сетка выдала бы клиенту — техническая строка, не готовый ответ. */
  gridService?: string;
  gridSection?: string;
  gridAmountKind?: string;
  gridText?: string;
  gridVariants?: number;
  /** Контроль сетки ответом оператора: суммы оператора против сетки. */
  operatorStaleFindings?: unknown;
  /** Оценка судьи — только для срабатываний. */
  serviceCorrect?: 'yes' | 'partial' | 'no' | 'JUDGE_FAILED';
  contradictsOperator?: boolean;
  judgeReason?: string;
  /** Оценка судьи — только для молчания на ценовом вопросе. */
  missedAnswerable?: 'yes' | 'no' | 'JUDGE_FAILED';
  missedService?: string;
}

/**
 * Судья опознания. Спрашивается ровно об одном: та ли услуга.
 *
 * Полноту и тон строки прайса судить запрещено намеренно. `describeTariff` —
 * это техническая печать строки, а не готовый ответ клиенту; если позволить
 * судить её как ответ, замер маршрутизации превратится в замер формулировок,
 * а решать надо первое.
 */
const JUDGE_MATCH = `Ты проверяешь, верно ли автомат опознал услугу бюро переводов по вопросу клиента.

Дано: вопрос клиента, строка прайса, которую выбрал автомат, и ответ живого оператора на этот же вопрос. Оператор — эталон того, ЧЕГО клиент хотел.

Оцени две вещи ОТДЕЛЬНО.

1. service_correct — та ли услуга выбрана:
   · "yes" — выбрана ровно та услуга, о цене которой спрашивает клиент;
   · "partial" — клиент спрашивал о нескольких услугах или шире, автомат назвал одну из них верно;
   · "no" — выбрана другая услуга.

2. contradicts_operator — противоречит ли строка прайса ответу оператора по существу: другая цена за то же самое, другой срок, «делаем» против «не делаем». Отсутствие цены у оператора противоречием НЕ является.

НЕ оценивай полноту, тон и оформление строки прайса: это техническая строка из таблицы, а не готовый ответ клиенту.

Ответ строго JSON:
{"service_correct":"yes"|"partial"|"no","contradicts_operator":true|false,"reason":""}`;

/**
 * Судья промахов молчания.
 *
 * Матрица перевода (52 языка × 3 категории × 5 сроков) в список не входит и
 * входить не должна: цена перевода зависит от языка, категории и объёма, а
 * граница 2 и 3 категории не разрешена в самом прайсе. Судью надо об этом
 * предупредить прямо, иначе он засчитает промахом каждый вопрос про перевод и
 * доля промахов взлетит на пустом месте.
 */
const JUDGE_MISS = `Ты проверяешь, можно ли было ответить на вопрос клиента ценой из прайса бюро переводов.

Дано: вопрос клиента, ответ живого оператора и СПИСОК услуг прайса с фиксированными ценами.

Вопрос: есть ли в списке услуга, ценой которой этот вопрос закрывается ПОЛНОСТЬЮ и ОДНОЗНАЧНО?

Отвечай "no", если:
· вопрос о цене письменного перевода (она зависит от языка, категории сложности и объёма и в список намеренно не входит);
· подходят несколько услуг сразу и выбрать одну по тексту вопроса нельзя;
· вопрос не о цене конкретной услуги, а о порядке расчёта, скидках, условиях оплаты;
· ответ оператора показывает, что нужны уточняющие сведения.

Ответ строго JSON:
{"answerable":"yes"|"no","service":"","reason":""}`;

async function judgeMatch(
  question: string,
  gridLine: string,
  operator: string
): Promise<{ service_correct?: string; contradicts_operator?: boolean; reason?: string }> {
  const raw = await createChatCompletion({
    messages: [
      { role: 'system', content: JUDGE_MATCH },
      {
        role: 'user',
        content: `ВОПРОС КЛИЕНТА:\n${question}\n\nСТРОКА ПРАЙСА, ВЫБРАННАЯ АВТОМАТОМ:\n${gridLine}\n\nОТВЕТ ОПЕРАТОРА (эталон смысла):\n${operator}`,
      },
    ],
    temperature: 0,
  });
  return JSON.parse(normalizeJsonResponse(raw ?? '{}'));
}

async function judgeMiss(
  question: string,
  operator: string,
  services: string[]
): Promise<{ answerable?: string; service?: string; reason?: string }> {
  const raw = await createChatCompletion({
    messages: [
      { role: 'system', content: JUDGE_MISS },
      {
        role: 'user',
        content: `ВОПРОС КЛИЕНТА:\n${question}\n\nОТВЕТ ОПЕРАТОРА:\n${operator}\n\nУСЛУГИ ПРАЙСА:\n${services.map((s) => `· ${s}`).join('\n')}`,
      },
    ],
    temperature: 0,
  });
  return JSON.parse(normalizeJsonResponse(raw ?? '{}'));
}

/**
 * Интервал Уилсона. Нормальное приближение при десятке наблюдений врёт и может
 * выйти за границы отрезка, а срабатываний сетки заведомо мало.
 */
function wilson(successes: number, total: number): [number, number] {
  if (total === 0) return [0, 0];
  const z = 1.96;
  const p = successes / total;
  const d = 1 + (z * z) / total;
  const centre = p + (z * z) / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function loadDone(): Map<number, Row> {
  const done = new Map<number, Row>();
  if (!existsSync(RESULTS)) return done;
  for (const line of readFileSync(RESULTS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Row;
      done.set(row.n, row);
    } catch {
      // Оборванная последняя строка после Ctrl-C — переспросим этот случай.
    }
  }
  return done;
}

/** Услуги с фиксированной ценой — то, чем сетка вообще способна ответить. */
function fixedServices(tariffs: TariffRecord[]): string[] {
  return [...new Set(tariffs.filter((t) => t.amountKind === 'FIXED').map((t) => t.serviceName))].sort();
}

async function main() {
  if (process.env.FRESH === '1') writeFileSync(RESULTS, '', 'utf8');

  // Прошлый замер измерил код, которого уже нет: правки шли параллельно
  // прогону. Ревизия фиксируется в шапке результатов, чтобы этого больше не
  // повторилось.
  let head = 'неизвестна';
  try {
    head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
    if (dirty) head += ' (дерево грязное)';
  } catch {
    // Без git обойдёмся — но пометим.
  }

  const all = (JSON.parse(readFileSync(CORPUS, 'utf8')) as CorpusCase[]).slice(0, LIMIT);

  // Корпус — переписка с клиентами, поэтому и сетка берётся клиентская:
  // внутренние строки клиенту не видны, и мерить надо то, что он получит.
  const tariffs = await getTariffs('client');
  const services = fixedServices(tariffs);

  console.log('\n=== ТЕНЕВОЙ ПРОГОН ТАРИФНОЙ СЕТКИ ПО КОРПУСУ ===');
  console.log(`ревизия: ${head}`);
  console.log(`корпус: ${all.length} вопросов, суммарная частота ${all.reduce((s, c) => s + c.freq, 0)}`);
  console.log(`сетка: ${tariffs.length} действующих строк для клиента, из них услуг с фиксированной ценой: ${services.length}`);
  if (tariffs.length === 0) {
    console.error('Сетка пуста — мерить нечего. Проверь DATABASE_URL и импорт тарифов.');
    process.exit(1);
  }

  const done = loadDone();

  for (const [i, c] of all.entries()) {
    const n = i + 1;
    if (done.has(n)) continue;

    const asksPrice = questionAsksPrice(c.question);
    const verdict = lookupTariffForQuestion(c.question, tariffs);

    // Контроль в обратную сторону: суммы из ответа ОПЕРАТОРА против сетки.
    // Если живой человек назвал цену, которой в действующем прайсе нет, — это
    // либо устаревшая сетка, либо ошибка оператора, и знать надо оба случая.
    const operatorStale = checkStalePrice(c.answer, tariffs);

    const row: Row = {
      n,
      question: c.question,
      operator: c.answer,
      category: c.category,
      freq: c.freq,
      priceDependent: c.price_dependent,
      asksPrice,
      cls:
        verdict.kind === 'single'
          ? 'FIRED_SINGLE'
          : verdict.kind === 'variants'
            ? 'FIRED_VARIANTS'
            : asksPrice || c.price_dependent
              ? 'SILENT_ON_PRICE'
              : 'SILENT_OFF_TOPIC',
      operatorStaleFindings: operatorStale.ok ? undefined : operatorStale.findings,
    };

    if (verdict.kind === 'single') {
      row.gridService = verdict.tariff.serviceName;
      row.gridSection = verdict.tariff.section;
      row.gridAmountKind = verdict.tariff.amountKind;
      row.gridText = describeTariff(verdict.tariff);
    } else if (verdict.kind === 'variants') {
      row.gridService = verdict.service;
      row.gridSection = verdict.tariffs[0]?.section;
      row.gridVariants = verdict.tariffs.length;
      row.gridText = verdict.tariffs.map(describeTariff).join('\n---\n');
    }

    if (!NO_JUDGE) {
      if (row.cls === 'FIRED_SINGLE' || row.cls === 'FIRED_VARIANTS') {
        await sleep(PACE_MS);
        try {
          const v = await judgeMatch(c.question, row.gridText ?? '', c.answer);
          row.serviceCorrect = (v.service_correct as Row['serviceCorrect']) ?? 'JUDGE_FAILED';
          row.contradictsOperator = Boolean(v.contradicts_operator);
          row.judgeReason = v.reason;
        } catch {
          row.serviceCorrect = 'JUDGE_FAILED';
        }
      } else if (row.cls === 'SILENT_ON_PRICE') {
        await sleep(PACE_MS);
        try {
          const v = await judgeMiss(c.question, c.answer, services);
          row.missedAnswerable = v.answerable === 'yes' ? 'yes' : 'no';
          row.missedService = v.service;
          row.judgeReason = v.reason;
        } catch {
          row.missedAnswerable = 'JUDGE_FAILED';
        }
      }
    }

    appendFileSync(RESULTS, `${JSON.stringify(row)}\n`, 'utf8');
    const mark =
      row.cls === 'FIRED_SINGLE' || row.cls === 'FIRED_VARIANTS'
        ? `СРАБОТАЛА → ${row.gridService} [${row.serviceCorrect ?? '—'}]`
        : row.cls === 'SILENT_ON_PRICE'
          ? `молчит на ценовом [промах=${row.missedAnswerable ?? '—'}]`
          : 'молчит (не про цену)';
    console.log(`[${n}/${all.length}] ${mark} · ${c.question.slice(0, 60)}…`);
  }

  report(head, all.length, tariffs.length, services.length);
  await prisma.$disconnect();
}

function report(head: string, corpusSize: number, gridRows: number, serviceCount: number): void {
  const rows = [...loadDone().values()].filter((r) => r.n <= corpusSize);
  const freqOf = (list: Row[]) => list.reduce((s, r) => s + r.freq, 0);
  const totalFreq = freqOf(rows);

  const fired = rows.filter((r) => r.cls === 'FIRED_SINGLE' || r.cls === 'FIRED_VARIANTS');
  const silentPrice = rows.filter((r) => r.cls === 'SILENT_ON_PRICE');
  const silentOff = rows.filter((r) => r.cls === 'SILENT_OFF_TOPIC');

  const judged = fired.filter((r) => r.serviceCorrect && r.serviceCorrect !== 'JUDGE_FAILED');
  const correct = judged.filter((r) => r.serviceCorrect === 'yes');
  const partial = judged.filter((r) => r.serviceCorrect === 'partial');
  const wrong = judged.filter((r) => r.serviceCorrect === 'no');
  const contradicting = fired.filter((r) => r.contradictsOperator);
  const misses = silentPrice.filter((r) => r.missedAnswerable === 'yes');
  const operatorStale = rows.filter((r) => r.operatorStaleFindings);

  const [lo, hi] = wilson(correct.length, judged.length);

  console.log('\n=== ИТОГ ===');
  console.log(`ревизия: ${head} · сетка: ${gridRows} строк, ${serviceCount} услуг с фиксированной ценой`);
  console.log(`строк в файле: ${rows.length} из ${corpusSize} (знаменатель полный: пишутся и молчания)`);
  console.log('');
  console.log('ЧАСТОТА СРАБАТЫВАНИЯ');
  console.log(`  сработала:            ${fired.length} вопросов (${pct(fired.length / rows.length)}), частота ${freqOf(fired)} (${pct(freqOf(fired) / totalFreq)})`);
  console.log(`  молчит на ценовом:    ${silentPrice.length} (${pct(silentPrice.length / rows.length)}), частота ${freqOf(silentPrice)} (${pct(freqOf(silentPrice) / totalFreq)})`);
  console.log(`  молчит не по теме:    ${silentOff.length} (${pct(silentOff.length / rows.length)})`);
  console.log('');
  console.log('ТОЧНОСТЬ ОПОЗНАНИЯ (среди срабатываний, судья по ответу оператора)');
  console.log(`  оценено:              ${judged.length}${fired.length - judged.length > 0 ? ` (судья не ответил: ${fired.length - judged.length})` : ''}`);
  console.log(`  та услуга:            ${correct.length}`);
  console.log(`  частично (шире вопрос): ${partial.length}`);
  console.log(`  ДРУГАЯ услуга:        ${wrong.length}`);
  console.log(`  точность:             ${judged.length ? pct(correct.length / judged.length) : '—'} (ДИ ${pct(lo)}–${pct(hi)})`);
  console.log(`  противоречит оператору: ${contradicting.length}`);
  console.log('');
  console.log('ПРОМАХИ МОЛЧАНИЯ (сетка могла ответить, но не опознала)');
  console.log(`  ${misses.length} из ${silentPrice.length} ценовых молчаний, частота ${freqOf(misses)}`);
  console.log('');
  console.log(`КОНТРОЛЬ СЕТКИ ОТВЕТАМИ ОПЕРАТОРОВ: сумм, противоречащих прайсу — ${operatorStale.length}`);

  if (wrong.length > 0) {
    console.log('\n--- ВСЕ СРАБАТЫВАНИЯ НЕ В ТУ УСЛУГУ (разбирать руками) ---');
    for (const r of wrong) {
      console.log(`\n[${r.n}] freq=${r.freq} ВОПРОС: ${r.question}`);
      console.log(`     СЕТКА: ${r.gridService}`);
      console.log(`     СУДЬЯ: ${r.judgeReason ?? '—'}`);
    }
  }
  if (fired.length > 0) {
    console.log('\n--- ВСЕ СРАБАТЫВАНИЯ (список для глаз владельца) ---');
    for (const r of fired) {
      console.log(`[${r.n}] ${r.serviceCorrect ?? 'без судьи'} freq=${r.freq} · «${r.question.slice(0, 60)}» → ${r.gridService}`);
    }
  }
  console.log(`\nсырые строки: ${RESULTS}`);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
