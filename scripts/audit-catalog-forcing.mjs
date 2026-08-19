// Замер «навязывает ли закрытый каталог значения» (translation-0lr).
//
// Совет мудрецов назвал это первым шагом: сегодня класс ошибки «значение
// выбрано, потому что каталог требовал выбрать» не измеряется вообще, а он
// опаснее отказа схемы — отказ виден и падает, а service="translation" у
// велосипедной услуги проходит валидацию и молча уходит в базу.
//
// Часть 1 (детерминированная, без LLM): покрытие. Сколько юнитов вообще несут
// структурные значения. Если ноль — «навязывание» измерять не на чем, и это
// само по себе главный вывод: машина молчит.
//
// Часть 2 (LLM-грейдер): для юнитов СО значением — следует ли значение из
// приведённой самим извлекателем цитаты, или выбрано из каталога вопреки ей.
//
//   node scripts/audit-catalog-forcing.mjs <artifact.json> [--limit=100]

import fs from 'node:fs/promises';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/audit-catalog-forcing.mjs <artifact.json> [--limit=N]');
  process.exit(1);
}
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Number(limitArg.slice('--limit='.length)) : 100;

const raw = JSON.parse(await fs.readFile(file, 'utf8'));

function findUnits(node) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findUnits(item);
      if (hit) return hit;
    }
    return null;
  }
  if (node && typeof node === 'object') {
    if (Array.isArray(node.units) && node.units.length > 0) return node.units;
    for (const value of Object.values(node)) {
      const hit = findUnits(value);
      if (hit) return hit;
    }
  }
  return null;
}

const units = findUnits(raw);
if (!units) {
  console.error('units[] в артефакте не найдены');
  process.exit(1);
}

const sample = units.slice(0, LIMIT);

// ── Часть 1: покрытие ───────────────────────────────────────────────────────
const byKind = new Map();
const facetKeyCounts = new Map();
const factKeyCounts = new Map();
let withFacets = 0;
let withTrigger = 0;
let withNumeric = 0;

const valued = []; // юниты, у которых ЕСТЬ структурное значение — только их и судим

for (const [i, u] of sample.entries()) {
  byKind.set(u.kind, (byKind.get(u.kind) ?? 0) + 1);

  const facets = u.facets && typeof u.facets === 'object' ? u.facets : {};
  const facetKeys = Object.keys(facets);
  if (facetKeys.length > 0) {
    withFacets++;
    for (const k of facetKeys) facetKeyCounts.set(k, (facetKeyCounts.get(k) ?? 0) + 1);
    for (const k of facetKeys) {
      valued.push({
        index: i, kind: u.kind, statement: u.statement,
        axis: `facets.${k}`, value: String(facets[k]),
        evidence: u.evidenceByField?.facets?.quote ?? u.sourceSpan?.quote ?? '',
      });
    }
  }

  const trig = u.triggerCondition;
  if (trig && Array.isArray(trig.all) && trig.all.length > 0) {
    withTrigger++;
    for (const cond of trig.all) {
      const fact = cond?.fact ?? '(нет)';
      factKeyCounts.set(fact, (factKeyCounts.get(fact) ?? 0) + 1);
      valued.push({
        index: i, kind: u.kind, statement: u.statement,
        axis: `triggerCondition.${fact}`,
        value: JSON.stringify(cond?.equals ?? cond),
        evidence: u.evidenceByField?.triggerCondition?.quote ?? u.sourceSpan?.quote ?? '',
      });
    }
  }

  if (u.numericConstraint) withNumeric++;
}

const pct = (n) => `${((n / sample.length) * 100).toFixed(0)}%`;

console.log('='.repeat(72));
console.log(`ЗАМЕР: ${file}`);
console.log(`Юнитов в выборке: ${sample.length} (всего в артефакте ${units.length})`);
console.log('='.repeat(72));
console.log('\n── ЧАСТЬ 1. ПОКРЫТИЕ (детерминированно, без LLM) ──\n');
console.log(`Несут хотя бы одну ось (facets):   ${withFacets}/${sample.length}  ${pct(withFacets)}`);
console.log(`Несут условие (triggerCondition):  ${withTrigger}/${sample.length}  ${pct(withTrigger)}`);
console.log(`Несут числовое ограничение:        ${withNumeric}/${sample.length}  ${pct(withNumeric)}`);
console.log('\nВиды знания:');
for (const [k, n] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(k).padEnd(20)} ${n}`);
}
console.log('\nИспользованные оси:');
if (facetKeyCounts.size === 0) console.log('  (ни одной)');
for (const [k, n] of [...facetKeyCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(20)} ${n}`);
}
console.log('\nИспользованные факты условий:');
if (factKeyCounts.size === 0) console.log('  (ни одного)');
for (const [k, n] of [...factKeyCounts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(24)} ${n}`);
}

console.log(`\nВСЕГО СТРУКТУРНЫХ ЗНАЧЕНИЙ К ПРОВЕРКЕ: ${valued.length}`);
if (valued.length === 0) {
  console.log('\n!!! Значений нет — «навязывание каталогом» измерять не на чем.');
  console.log('!!! Это и есть главный вывод: структурный слой на этих данных молчит.');
  process.exit(0);
}

await fs.writeFile('catalog-forcing-values.json', JSON.stringify(valued, null, 2), 'utf8');
console.log('Значения для ручной/LLM-проверки: catalog-forcing-values.json');
