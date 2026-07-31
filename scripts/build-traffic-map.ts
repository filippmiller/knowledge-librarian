/**
 * Сборка карты живого потока из разметки: распределения, кросс-таблица,
 * топ по частоте, сверка с ручной разметкой.
 * Запуск: npx tsx scripts/build-traffic-map.ts
 */
import * as fs from 'fs';
import * as path from 'path';

type Item = { category: string; question: string; answer: string; price_dependent: boolean; freq: number; confidence: number };
type Label = { i: number; mechanism: string; error_cost: string; autonomy: string; needs_external_data?: string };

const root = process.cwd();
const corpus = JSON.parse(fs.readFileSync(path.join(root, 'docs/email-bot/may2026-knowledge-base-final.json'), 'utf8')) as Item[];
const labels = JSON.parse(fs.readFileSync(path.join(root, 'scratchpad/labels-model-v2.json'), 'utf8')) as Record<string, Label>;

const MECH_ORDER = ['stable_fact', 'conditional_rule', 'calculation', 'dynamic_data', 'order_state', 'consultation', 'unknown_to_us'];
const COST_ORDER = ['money', 'lost_order', 'reputation', 'low'];
const AUTO_ORDER = ['auto_safe', 'auto_risky', 'human_only'];

const totalQ = corpus.length;
const totalF = corpus.reduce((s, x) => s + x.freq, 0);

function dist(axis: 'mechanism' | 'error_cost' | 'autonomy', order: string[]) {
  const q: Record<string, number> = {};
  const f: Record<string, number> = {};
  for (const k of order) { q[k] = 0; f[k] = 0; }
  corpus.forEach((item, i) => {
    const l = labels[String(i)];
    if (!l) return;
    q[l[axis]] = (q[l[axis]] || 0) + 1;
    f[l[axis]] = (f[l[axis]] || 0) + item.freq;
  });
  return order.map((k) => ({
    key: k, q: q[k], qp: (100 * q[k] / totalQ), f: f[k], fp: (100 * f[k] / totalF),
  }));
}

function pct(x: number) { return x.toFixed(1).replace('.', ',') + '%'; }

function mdTable(rows: Array<{ key: string; q: number; qp: number; f: number; fp: number }>, header: string) {
  const lines = [`| ${header} | вопросов | % вопросов | частота | % частоты |`, '|---|---:|---:|---:|---:|'];
  for (const r of rows) lines.push(`| \`${r.key}\` | ${r.q} | ${pct(r.qp)} | ${r.f} | ${pct(r.fp)} |`);
  const sq = rows.reduce((s, r) => s + r.q, 0);
  const sf = rows.reduce((s, r) => s + r.f, 0);
  lines.push(`| **всего** | **${sq}** | **${pct(100 * sq / totalQ)}** | **${sf}** | **${pct(100 * sf / totalF)}** |`);
  return lines.join('\n');
}

// кросс-таблица механизм × цена ошибки (по частоте)
function cross() {
  const cell: Record<string, Record<string, { q: number; f: number }>> = {};
  for (const m of MECH_ORDER) { cell[m] = {}; for (const c of COST_ORDER) cell[m][c] = { q: 0, f: 0 }; }
  corpus.forEach((item, i) => {
    const l = labels[String(i)];
    if (!l) return;
    cell[l.mechanism][l.error_cost].q += 1;
    cell[l.mechanism][l.error_cost].f += item.freq;
  });
  return cell;
}

// сверка с ручной разметкой
function reconcile(manualFile: string, modelFile: string) {
  const man = JSON.parse(fs.readFileSync(path.join(root, manualFile), 'utf8')).labels as Record<string, Label>;
  const mod = JSON.parse(fs.readFileSync(path.join(root, modelFile), 'utf8')) as Record<string, Label>;
  const axes = ['mechanism', 'error_cost', 'autonomy'] as const;
  const agree: Record<string, number> = { mechanism: 0, error_cost: 0, autonomy: 0 };
  const keys = Object.keys(man);
  const diffs: string[] = [];
  for (const k of keys) {
    const a = mod[k];
    if (!a) { diffs.push(`${k}: НЕТ разметки модели`); continue; }
    for (const ax of axes) if (man[k][ax] === a[ax]) agree[ax]++;
    const bad = axes.filter((ax) => man[k][ax] !== a[ax]);
    if (bad.length) diffs.push(`${k} | ${corpus[Number(k)].question.slice(0, 70)} | ` + bad.map((ax) => `${ax}: рука=${man[k][ax]} модель=${a[ax]}`).join('; '));
  }
  const all3 = keys.filter((k) => mod[k] && axes.every((ax) => man[k][ax] === mod[k][ax])).length;
  return { n: keys.length, agree, all3, diffs };
}

const out = {
  totalQ, totalF,
  labeled: Object.keys(labels).length,
  mechanism: dist('mechanism', MECH_ORDER),
  error_cost: dist('error_cost', COST_ORDER),
  autonomy: dist('autonomy', AUTO_ORDER),
  cross: cross(),
  reconcile_v1: reconcile('scratchpad/manual-labels.json', 'scratchpad/labels-model.json'),
  reconcile_v2: reconcile('scratchpad/manual-labels2.json', 'scratchpad/labels-model-v2.json'),
};

console.log('=== labeled:', out.labeled, '/', totalQ, ' freq total:', totalF);
console.log('\n--- MECHANISM ---\n' + mdTable(out.mechanism, 'механизм'));
console.log('\n--- ERROR COST ---\n' + mdTable(out.error_cost, 'цена ошибки'));
console.log('\n--- AUTONOMY ---\n' + mdTable(out.autonomy, 'автономность'));

console.log('\n--- CROSS mechanism x error_cost (вопросов / частота) ---');
console.log('| механизм | ' + COST_ORDER.join(' | ') + ' |');
console.log('|---|' + COST_ORDER.map(() => '---:').join('|') + '|');
for (const m of MECH_ORDER) {
  console.log(`| ${m} | ` + COST_ORDER.map((c) => `${out.cross[m][c].q} / ${out.cross[m][c].f}`).join(' | ') + ' |');
}

console.log('\n--- TOP 15 by freq ---');
const top = corpus.map((x, i) => ({ i, ...x })).sort((a, b) => b.freq - a.freq || a.i - b.i).slice(0, 15);
for (const t of top) {
  const l = labels[String(t.i)];
  console.log(`${t.freq}\t${l?.mechanism}\t${l?.error_cost}\t${l?.autonomy}\t${l?.needs_external_data}\t${t.question}`);
}

console.log('\n--- needs_external_data ---');
const ned: Record<string, { q: number; f: number }> = {};
corpus.forEach((item, i) => {
  const k = labels[String(i)]?.needs_external_data || 'none';
  ned[k] = ned[k] || { q: 0, f: 0 };
  ned[k].q++; ned[k].f += item.freq;
});
for (const [k, v] of Object.entries(ned).sort((a, b) => b[1].f - a[1].f)) {
  console.log(`${k}\t${v.q} q (${pct(100 * v.q / totalQ)})\t${v.f} f (${pct(100 * v.f / totalF)})`);
}

console.log('\n--- RECONCILE v1 (первая выборка, рубрика v1) ---');
console.log(JSON.stringify({ n: out.reconcile_v1.n, agree: out.reconcile_v1.agree, all3: out.reconcile_v1.all3 }));
console.log('\n--- RECONCILE v2 (свежая выборка, рубрика v2) ---');
console.log(JSON.stringify({ n: out.reconcile_v2.n, agree: out.reconcile_v2.agree, all3: out.reconcile_v2.all3 }));
console.log(out.reconcile_v2.diffs.join('\n'));

// машиночитаемая карта
const machine = corpus.map((x, i) => ({
  i,
  question: x.question,
  category: x.category,
  freq: x.freq,
  price_dependent: x.price_dependent,
  mechanism: labels[String(i)]?.mechanism ?? null,
  error_cost: labels[String(i)]?.error_cost ?? null,
  autonomy: labels[String(i)]?.autonomy ?? null,
  needs_external_data: labels[String(i)]?.needs_external_data ?? null,
}));
fs.writeFileSync(path.join(root, 'docs/bot-audit/traffic-map.json'), JSON.stringify(machine, null, 1) + '\n');
fs.writeFileSync(path.join(root, 'scratchpad/traffic-map-stats.json'), JSON.stringify(out, null, 1));
console.log('\nwritten: docs/bot-audit/traffic-map.json');
