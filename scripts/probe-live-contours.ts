/**
 * Боевая проверка обоих контуров: что бот реально отвечает и какие цены называет.
 *
 * Рядом с каждым ответом печатается то, чего сам движок не знает:
 * · цена из тарифной сетки — единственный сверенный с бумагой источник;
 * · вердикт сторожа устаревших цен по тексту ответа.
 *
 * Движок сетку НЕ читает (модули не вызываются ни из одного пути ответа), и
 * смысл этой проверки — увидеть, расходятся ли названные ботом цены с прайсом.
 *
 * Внутренний контур гоняется в процессе — ровно тот же вызов, что делает
 * Telegram-бот. Клиентский бьётся в ПРОД по HTTP, потому что там участвует ещё
 * и политика отправки: клиенту часть ответов не уходит вовсе.
 *
 * Запуск: railway run npx tsx scripts/probe-live-contours.ts
 *         ONLY=client|internal railway run npx tsx scripts/probe-live-contours.ts
 */
import { answerQuestionEnhanced } from '../src/lib/ai/enhanced-answering-engine';
import { resolveDelivery } from '../src/lib/ai/delivery';
import { getTariffs } from '../src/lib/knowledge/tariff-store';
import { lookupTariffForQuestion, describeTariff } from '../src/lib/knowledge/tariff-lookup';
import { checkStalePrice } from '../src/lib/knowledge/stale-price-check';
import type { TariffRecord } from '../src/lib/knowledge/tariffs';
import prisma from '../src/lib/db';

const PROD = 'https://avrora-library-production.up.railway.app';
const ONLY = process.env.ONLY ?? 'both';
const PACE_MS = 3000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Probe {
  q: string;
  /** Какую услугу прайса вопрос имеет в виду — для печати эталона рядом. */
  expect?: string;
  note?: string;
}

/**
 * Вопросы делятся на два сорта нарочно.
 *
 * Прямые ценовые — там, где у прайса есть однозначный ответ, и расхождение
 * измеримо в рублях. Условные — самая частая часть живого потока (35,7% по
 * частоте), где верный ответ содержит развилку, и проверять надо не число, а
 * не соврал ли бот условием.
 */
const PROBES: Probe[] = [
  { q: 'Сколько стоит нотариальное заверение перевода?', expect: 'Нотариальное заверение перевода' },
  { q: 'Сколько стоит нотариальное заверение копии документа?', expect: 'Нотариальное заверение копии' },
  { q: 'Сколько стоит апостиль в Санкт-Петербурге?', expect: 'МЮ СПб' },
  { q: 'Сколько стоит срочный апостиль на свидетельство о рождении в ЗАГСе?', expect: 'СРОЧНЫЙ АПОСТИЛЬ ЗАГС СПБ' },
  {
    q: 'Сколько стоит справка об отсутствии судимости за 3 рабочих дня?',
    expect: 'СОН без апостиля — 3 рабочих дня',
    note: 'здесь прошлым замером бот дважды из пяти называл 20 000 ₽ вместо 22 000 ₽',
  },
  { q: 'Сколько стоит консульская легализация без подачи в посольство?', expect: 'МЮ + МИД без подачи в Посольство' },
  { q: 'Сколько стоит заверение в Торгово-промышленной палате?', expect: 'ТПП СПб' },
  { q: 'Сколько стоит сканирование документов?', expect: 'Сканирование' },
  { q: 'Сколько стоит перевод паспорта с английского на русский?', note: 'матрица: цена зависит от категории и срока' },
  { q: 'Как рассчитывается стоимость письменного перевода и что такое условная страница?', note: 'самый частый вопрос корпуса, 11 повторов' },
  { q: 'Как срочность влияет на стоимость перевода и заверения?', note: 'условное правило, частота 8' },
  { q: 'Нужна ли предоплата и можно ли оплатить частями?', note: 'условное правило, частота 10' },
  { q: 'К чему подшивается нотариальный перевод — к оригиналу или копии?', note: 'условное правило, частота 9' },
];

function gridTruth(question: string, tariffs: TariffRecord[], expect?: string): string {
  const verdict = lookupTariffForQuestion(question, tariffs);
  if (verdict.kind === 'single') return describeTariff(verdict.tariff).split('\n')[0];
  if (verdict.kind === 'variants') return `${verdict.service}: ${verdict.tariffs.length} вариантов по сроку`;
  if (!expect) return 'сетка молчит';
  // Сетка молчит — но эталон всё равно надо показать, иначе не с чем сравнить
  // названную ботом цену. Ищем по подстроке названия, как человек глазами.
  const rows = tariffs.filter((t) => t.serviceName.toLowerCase().includes(expect.toLowerCase()));
  if (rows.length === 0) return `сетка молчит; строки «${expect}» в прайсе не нашёл`;
  return `сетка молчит; в прайсе: ${rows.slice(0, 4).map((r) => `${r.serviceName} — ${r.priceText}`).join(' | ')}`;
}

async function askProd(question: string): Promise<{ answer: string; confidence?: number; source?: string }> {
  const res = await fetch(`${PROD}/api/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) return { answer: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const data = (await res.json()) as {
    answer?: string;
    confidence?: number;
    answerSource?: string;
    needsClarification?: boolean;
  };
  return {
    answer: data.answer ?? '(пусто)',
    confidence: data.confidence,
    source: data.answerSource,
  };
}

async function main() {
  const tariffs = await getTariffs('client');
  console.log(`\n═══ БОЕВАЯ ПРОВЕРКА КОНТУРОВ ═══`);
  console.log(`сетка: ${tariffs.length} действующих строк\n`);

  for (const [i, probe] of PROBES.entries()) {
    console.log(`\n${'═'.repeat(78)}`);
    console.log(`[${i + 1}/${PROBES.length}] ${probe.q}`);
    if (probe.note) console.log(`   ⓘ ${probe.note}`);
    console.log(`   ПРАЙС: ${gridTruth(probe.q, tariffs, probe.expect)}`);

    if (ONLY !== 'client') {
      await sleep(PACE_MS);
      try {
        const result = await answerQuestionEnhanced({ question: probe.q, audience: 'internal' });
        const stale = checkStalePrice(result.answer, tariffs);
        console.log(`\n   ── СОТРУДНИК (Telegram) · ${Math.round(result.confidence * 100)}% ${result.confidenceLevel} · ${result.answerSource ?? '—'} · review=${result.requiresHumanReview}`);
        console.log(indent(result.answer));
        if (!stale.ok) {
          for (const f of stale.findings) {
            console.log(`   ⚠ СТОРОЖ ЦЕН: ${f.amount} ₽ при «${f.serviceHint}», в прайсе ${f.currentAmounts.join(', ')} ₽`);
          }
        }
      } catch (e) {
        console.log(`   ── СОТРУДНИК: движок не ответил — ${String(e).slice(0, 160)}`);
      }
    }

    if (ONLY !== 'internal') {
      await sleep(PACE_MS);
      try {
        const prod = await askProd(probe.q);
        const stale = checkStalePrice(prod.answer, tariffs);
        console.log(`\n   ── КЛИЕНТ (прод /api/ask) · ${prod.confidence !== undefined ? `${Math.round(prod.confidence * 100)}%` : '—'} · ${prod.source ?? '—'}`);
        console.log(indent(prod.answer));
        if (!stale.ok) {
          for (const f of stale.findings) {
            console.log(`   ⚠ СТОРОЖ ЦЕН: ${f.amount} ₽ при «${f.serviceHint}», в прайсе ${f.currentAmounts.join(', ')} ₽`);
          }
        }
      } catch (e) {
        console.log(`   ── КЛИЕНТ: запрос не прошёл — ${String(e).slice(0, 160)}`);
      }
    }
  }

  console.log(`\n${'═'.repeat(78)}\nготово`);
  await prisma.$disconnect();
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `      ${l}`)
    .join('\n');
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
