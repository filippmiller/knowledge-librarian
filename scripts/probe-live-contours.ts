/**
 * Пакетный прогон обоих контуров по корпусу реальных вопросов.
 *
 * Что этот прогон даёт сверх замера автономности: он гоняет ОБА контура на
 * одном и том же вопросе и кладёт рядом то, чего сам движок о себе не знает, —
 * какие контроли сработали, что помешало отправить, сколько строк прайса ушло
 * в промпт и расходятся ли названные суммы с сеткой. Замер автономности мерит
 * долю верных ответов; этот прогон отвечает на другой вопрос — ПОЧЕМУ ответ
 * получился таким и одинаково ли ведут себя сотрудник и клиент.
 *
 * Внутренний контур гоняется В ПРОЦЕССЕ — ровно тот же вызов, что делает
 * Telegram-бот, и потому меряется рабочее дерево. Клиентский бьётся в ПРОД по
 * HTTP: там участвует политика отправки целиком, включая подмену текста
 * удерживающим, а её на локальной сборке не воспроизвести честно.
 *
 * ПРОГОН НЕ ЭСКАЛИРУЕТ. Клиентские запросы идут с флагом `sandbox`, иначе
 * каждый вопрос прогона создавал бы в проде черновик пробела знаний и слал
 * уведомление супер-админам. Флаг признаётся только по сессии сотрудника —
 * поэтому нужен `PROBE_COOKIE` (см. ниже).
 *
 * Возобновляемость и диапазоны — как в measure-autonomy-150.ts: прогон режется
 * на части, каждая со своим файлом, части идут параллельно и склеиваются по `n`.
 *
 * Запуск:
 *   railway run npx tsx scripts/probe-live-contours.ts              # 30 кейсов по убыванию частоты
 *   LIMIT=60 railway run npx tsx scripts/probe-live-contours.ts
 *   RANGE=1-15 SUFFIX=.a railway run npx tsx scripts/probe-live-contours.ts
 *   ONLY=internal railway run npx tsx scripts/probe-live-contours.ts # без похода в прод
 *   FRESH=1 … — начать заново
 *   REPORT=1 npx tsx scripts/probe-live-contours.ts                  # только собрать отчёт
 *
 * Клиентский контур требует сессии сотрудника — иначе прод не примет `sandbox`
 * и прогон засыплет владельца уведомлениями:
 *   PROBE_COOKIE='session=…' railway run npx tsx scripts/probe-live-contours.ts
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { answerQuestionEnhanced } from '../src/lib/ai/enhanced-answering-engine';
import { resolveDelivery } from '../src/lib/ai/delivery';
import { getTariffs } from '../src/lib/knowledge/tariff-store';
import { lookupTariffForQuestion } from '../src/lib/knowledge/tariff-lookup';
import { checkStalePrice } from '../src/lib/knowledge/stale-price-check';
import { HUMAN_REVIEW_LABELS, type AnswerReasons } from '../src/lib/ai/answer-reasons';
import { AUTO_ANSWER_BLOCKER_LABELS, type AutoAnswerBlocker } from '../src/lib/ai/delivery-decision';
import type { TariffRecord } from '../src/lib/knowledge/tariffs';
import prisma from '../src/lib/db';

const PROD = process.env.PROBE_HOST ?? 'https://avrora-library-production.up.railway.app';
const CORPUS = 'docs/email-bot/may2026-knowledge-base-final.json';
const SUFFIX = process.env.SUFFIX ?? '';
const RESULTS = `docs/bot-audit/.contours${SUFFIX}.jsonl`;
const REPORT_HTML = 'docs/bot-audit/contours-report.html';

/** Первый заход — тридцать самых частых вопросов: 30 × 2 контура × ~60 с ≈ час. */
const LIMIT = Number(process.env.LIMIT ?? 30);
const ONLY = process.env.ONLY ?? 'both';
const [RANGE_FROM, RANGE_TO] = (process.env.RANGE ?? '1-99999').split('-').map(Number);
const PACE_MS = Number(process.env.PACE_MS ?? 3000);
const COOKIE = process.env.PROBE_COOKIE ?? '';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CorpusCase {
  category: string;
  question: string;
  answer: string;
  price_dependent: boolean;
  freq: number;
}

interface ContourResult {
  status: 'ok' | 'failed';
  error?: string;
  answer?: string;
  delivery?: string;
  blocker?: AutoAnswerBlocker | null;
  withheld?: boolean;
  confidence?: number;
  confidenceLevel?: string;
  answerSource?: string;
  requiresHumanReview?: boolean;
  reasons?: AnswerReasons;
  /** Суммы ответа, разошедшиеся с сеткой. Считается здесь, а не движком. */
  stalePrices?: string[];
}

interface Row {
  n: number;
  head: string;
  question: string;
  operator: string;
  category: string;
  freq: number;
  priceDependent: boolean;
  /** Что сказала бы детерминированная ветка прайса. */
  gridVerdict: string;
  internal?: ContourResult;
  client?: ContourResult;
}

/**
 * Ревизия рабочего дерева на момент прогона.
 *
 * Прошлый замер измерил код, которого уже нет: правки шли параллельно прогону,
 * и 145 ответов из 150 оказались про несуществующую версию. Ревизия пишется в
 * КАЖДУЮ строку, а не только в шапку: части прогона идут параллельно и могут
 * начаться в разное время.
 */
function currentHead(): string {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
    return dirty ? `${head}+грязное` : head;
  } catch {
    return 'неизвестна';
  }
}

function gridVerdict(question: string, tariffs: TariffRecord[]): string {
  const verdict = lookupTariffForQuestion(question, tariffs);
  if (verdict.kind === 'single') return `${verdict.tariff.serviceName} — ${verdict.tariff.priceText}`;
  if (verdict.kind === 'variants') return `${verdict.service}: ${verdict.tariffs.length} вариантов`;
  return '—';
}

async function runInternal(question: string, tariffs: TariffRecord[]): Promise<ContourResult> {
  try {
    const result = await answerQuestionEnhanced({ question, audience: 'internal', includeDebug: true });
    const delivery = await resolveDelivery(result, 'internal');
    const stale = checkStalePrice(result.answer, tariffs);
    return {
      status: 'ok',
      answer: result.answer,
      delivery: delivery.decision,
      blocker: delivery.blocker,
      withheld: delivery.withheld,
      confidence: result.confidence,
      confidenceLevel: result.confidenceLevel,
      answerSource: result.answerSource,
      requiresHumanReview: result.requiresHumanReview,
      reasons: result.debug?.reasons,
      stalePrices: stale.ok ? [] : stale.findings.map((f) => `${f.amount} ₽ при «${f.serviceHint}»`),
    };
  } catch (e) {
    return { status: 'failed', error: String(e).slice(0, 300) };
  }
}

async function runClient(question: string, tariffs: TariffRecord[]): Promise<ContourResult> {
  try {
    const res = await fetch(`${PROD}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) },
      // `audience: 'client'` названа явно: без неё прод по сессии сотрудника
      // отдал бы внутренний контур, и колонка «клиент» врала бы.
      body: JSON.stringify({ question, audience: 'client', includeDebug: true, sandbox: true }),
    });
    if (!res.ok) return { status: 'failed', error: `HTTP ${res.status}` };
    const data = (await res.json()) as {
      answer?: string;
      delivery?: string;
      deliveryBlocker?: AutoAnswerBlocker | null;
      answerWithheld?: boolean;
      confidence?: number;
      confidenceLevel?: string;
      answerSource?: string;
      requiresHumanReview?: boolean;
      debug?: { reasons?: AnswerReasons };
    };
    const stale = checkStalePrice(data.answer ?? '', tariffs);
    return {
      status: 'ok',
      answer: data.answer,
      delivery: data.delivery,
      blocker: data.deliveryBlocker ?? null,
      withheld: data.answerWithheld,
      confidence: data.confidence,
      confidenceLevel: data.confidenceLevel,
      answerSource: data.answerSource,
      requiresHumanReview: data.requiresHumanReview,
      reasons: data.debug?.reasons,
      stalePrices: stale.ok ? [] : stale.findings.map((f) => `${f.amount} ₽ при «${f.serviceHint}»`),
    };
  } catch (e) {
    return { status: 'failed', error: String(e).slice(0, 300) };
  }
}

/**
 * Кейсы, которые переспрашивать не нужно.
 *
 * Сбойный контур сделанным НЕ считается. Сбои здесь массовые и внешние — за
 * первый заход на 30 кейсов сеть и база уронили 8 внутренних и 6 клиентских
 * запросов. Если писать их в «сделано», повторный запуск молча пройдёт мимо, и
 * возобновляемость окажется только на бумаге: дыры в замере останутся навсегда,
 * а отчёт будет выглядеть полным.
 */
function loadDone(): Map<number, Row> {
  const done = new Map<number, Row>();
  if (!existsSync(RESULTS)) return done;
  for (const line of readFileSync(RESULTS, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Row;
      const internalOk = ONLY === 'client' || row.internal?.status === 'ok';
      const clientOk = ONLY === 'internal' || row.client?.status === 'ok';
      if (internalOk && clientOk) done.set(row.n, row);
    } catch {
      // Оборванная последняя строка после Ctrl-C — вопрос переспросим.
    }
  }
  return done;
}

/**
 * Все части прогона, а не только своя: отчёт собирается по складу целиком.
 *
 * Каталог читается, а не перебирается список суффиксов. Первый вариант со
 * списком `['', '.a', … '.e']` молча терял любую часть с другим суффиксом —
 * смоук с `SUFFIX=.smoke` собрал отчёт из НУЛЯ строк, записав три.
 */
function loadAllParts(): Row[] {
  const rows = new Map<number, Row>();
  const files = readdirSync('docs/bot-audit')
    .filter((f) => f.startsWith('.contours') && f.endsWith('.jsonl'))
    .sort();
  for (const file of files) {
    const path = `docs/bot-audit/${file}`;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as Row;
        // Повтор сбойного кейса дописывается в конец, и по номеру строк
        // становится две. Побеждает та, где успешных контуров больше, а не
        // просто последняя: иначе неудачный повтор затёр бы удачный первый заход.
        const score = (r: Row) =>
          (r.internal?.status === 'ok' ? 1 : 0) + (r.client?.status === 'ok' ? 1 : 0);
        const existing = rows.get(row.n);
        if (!existing || score(row) >= score(existing)) rows.set(row.n, row);
      } catch {
        /* оборванная строка */
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.n - b.n);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function contourCell(contour: ContourResult | undefined): string {
  if (!contour) return '<td class="muted">не гонялся</td>';
  if (contour.status === 'failed') {
    return `<td class="fail">не ответил<div class="small">${escapeHtml(contour.error ?? '')}</div></td>`;
  }
  const reasons = contour.reasons?.humanReview ?? [];
  const tone =
    contour.delivery === 'answer' ? 'ok' : contour.delivery === 'clarify' ? 'clarify' : 'hold';
  const parts = [
    `<div class="badge ${tone}">${escapeHtml(contour.delivery ?? '—')}</div>`,
    `<div class="small">${Math.round((contour.confidence ?? 0) * 100)}% · ${escapeHtml(contour.answerSource ?? '—')}</div>`,
  ];
  if (contour.blocker) {
    parts.push(`<div class="small blocker">${escapeHtml(AUTO_ANSWER_BLOCKER_LABELS[contour.blocker])}</div>`);
  }
  for (const r of reasons) {
    parts.push(`<div class="small reason">${escapeHtml(HUMAN_REVIEW_LABELS[r.reason])}: ${escapeHtml(r.detail.slice(0, 160))}</div>`);
  }
  if (contour.stalePrices?.length) {
    parts.push(`<div class="small stale">расходится с прайсом: ${escapeHtml(contour.stalePrices.join('; '))}</div>`);
  }
  const tariff = contour.reasons?.tariffContext;
  if (tariff) {
    parts.push(`<div class="small muted">прайс: ${tariff.rows} строк${tariff.sections.length ? ` · ${escapeHtml(tariff.sections.join(', '))}` : ''}</div>`);
  }
  parts.push(`<details><summary>ответ</summary><div class="answer">${escapeHtml(contour.answer ?? '')}</div></details>`);
  return `<td>${parts.join('')}</td>`;
}

function buildReport(rows: Row[]): void {
  const answered = (c?: ContourResult) => c?.status === 'ok' && c.delivery === 'answer';
  const internalAnswered = rows.filter((r) => answered(r.internal)).length;
  const clientAnswered = rows.filter((r) => answered(r.client)).length;
  // Расхождение контуров — главное, ради чего они стоят рядом: один и тот же
  // вопрос, а решения разные.
  const diverged = rows.filter(
    (r) => r.internal?.status === 'ok' && r.client?.status === 'ok' && r.internal.delivery !== r.client.delivery
  );

  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Контуры бота — прогон по корпусу</title>
<style>
 body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;margin:24px;color:#111;background:#fafafa}
 h1{font-size:20px} h2{font-size:15px;margin-top:28px}
 table{border-collapse:collapse;width:100%;background:#fff}
 th,td{border:1px solid #e3e3e3;padding:8px;vertical-align:top;font-size:12px;text-align:left}
 th{background:#f3f4f6;position:sticky;top:0}
 td.q{max-width:280px} .small{font-size:11px;line-height:1.45;margin-top:3px}
 .muted{color:#888} .fail{background:#fff1f1;color:#a12}
 .badge{display:inline-block;padding:1px 7px;border-radius:9px;font-weight:600;font-size:11px}
 .badge.ok{background:#dcfce7;color:#14532d} .badge.hold{background:#fee2e2;color:#7f1d1d}
 .badge.clarify{background:#dbeafe;color:#1e3a8a}
 .blocker{color:#92400e} .reason{color:#7c2d12} .stale{color:#9f1239;font-weight:600}
 .answer{white-space:pre-wrap;margin-top:6px;padding:6px;background:#f8f8f8;border-radius:5px;max-width:420px}
 .sum{background:#fff;border:1px solid #e3e3e3;padding:12px;border-radius:6px;margin:10px 0}
 details summary{cursor:pointer;color:#2563eb;font-size:11px;margin-top:4px}
</style></head><body>
<h1>Контуры бота — прогон по корпусу</h1>
<div class="sum">
 <div>строк: <b>${rows.length}</b> · ревизия: <b>${escapeHtml(rows[0]?.head ?? '—')}</b></div>
 <div>ответ уходит: сотруднику <b>${internalAnswered}</b>, клиенту <b>${clientAnswered}</b> из ${rows.length}</div>
 <div>контуры разошлись в решении: <b>${diverged.length}</b></div>
 <div class="small muted">Прогон идёт с флагом sandbox: эскалация и черновики пробелов знаний не создаются.</div>
</div>
<table>
<thead><tr><th>#</th><th class="q">Вопрос клиента</th><th>Прайс</th><th>Сотрудник</th><th>Клиент</th></tr></thead>
<tbody>
${rows
  .map(
    (r) => `<tr>
 <td>${r.n}<div class="small muted">×${r.freq}</div></td>
 <td class="q">${escapeHtml(r.question)}<div class="small muted">${escapeHtml(r.category)}${r.priceDependent ? ' · живой расчёт' : ''}</div>
   <details><summary>ответ оператора</summary><div class="answer">${escapeHtml(r.operator)}</div></details></td>
 <td class="small">${escapeHtml(r.gridVerdict)}</td>
 ${contourCell(r.internal)}
 ${contourCell(r.client)}
</tr>`
  )
  .join('\n')}
</tbody></table></body></html>`;

  writeFileSync(REPORT_HTML, html, 'utf8');
  console.log(`\nотчёт: ${REPORT_HTML} (строк ${rows.length}, расхождений контуров ${diverged.length})`);
}

async function main() {
  if (process.env.REPORT === '1') {
    buildReport(loadAllParts());
    return;
  }
  if (process.env.FRESH === '1') writeFileSync(RESULTS, '', 'utf8');

  const head = currentHead();
  const all = (JSON.parse(readFileSync(CORPUS, 'utf8')) as CorpusCase[])
    .slice()
    .sort((a, b) => b.freq - a.freq || a.question.localeCompare(b.question))
    .slice(0, LIMIT);

  const tariffs = await getTariffs('client');
  const done = loadDone();

  console.log(`\n=== ПРОГОН КОНТУРОВ ПО КОРПУСУ ===`);
  console.log(`ревизия: ${head} · кейсов: ${all.length} · уже сделано: ${done.size} · контуры: ${ONLY}`);
  if (ONLY !== 'internal' && !COOKIE) {
    console.warn('ВНИМАНИЕ: PROBE_COOKIE не задан — прод не примет sandbox, и прогон создаст уведомления.');
  }

  for (const [i, c] of all.entries()) {
    const n = i + 1;
    if (n < RANGE_FROM || n > RANGE_TO) continue;
    if (done.has(n)) continue;

    const row: Row = {
      n,
      head,
      question: c.question,
      operator: c.answer,
      category: c.category,
      freq: c.freq,
      priceDependent: c.price_dependent,
      gridVerdict: gridVerdict(c.question, tariffs),
    };

    if (ONLY !== 'client') {
      await sleep(PACE_MS);
      row.internal = await runInternal(c.question, tariffs);
    }
    if (ONLY !== 'internal') {
      await sleep(PACE_MS);
      row.client = await runClient(c.question, tariffs);
    }

    appendFileSync(RESULTS, `${JSON.stringify(row)}\n`, 'utf8');
    console.log(
      `[${n}/${all.length}] ×${c.freq} сотрудник=${row.internal?.delivery ?? '—'} клиент=${row.client?.delivery ?? '—'} · ${c.question.slice(0, 58)}…`
    );
  }

  buildReport(loadAllParts());
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
