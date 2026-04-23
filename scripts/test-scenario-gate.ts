// End-to-end test of the scenario decision gate.
// Runs each of our 8 diagnostic questions through classifyScenario and
// reports the decision, so we can see if the gate makes the right call
// BEFORE pushing the engine change to production.

import 'dotenv/config';
import { classifyScenario } from '../src/lib/knowledge/scenario-classifier';
import { assertTaxonomyConsistency } from '../src/lib/knowledge/scenarios';

const TESTS = [
  { id: 'T1', q: 'АПОСТИЛЬ',                                                          expect: 'needs_clarification @ apostille' },
  { id: 'T2', q: 'апостиль на свидетельство о браке в Санкт-Петербурге',              expect: 'scenario_clear → apostille.zags.spb' },
  { id: 'T3', q: 'апостиль свидетельство о рождении Ленинградская область',           expect: 'scenario_clear → apostille.zags.lo' },
  { id: 'T4', q: 'апостиль на нотариальную доверенность',                             expect: 'scenario_clear → apostille.min_justice' },
  { id: 'T5', q: 'сколько стоит апостиль',                                            expect: 'needs_clarification @ apostille  OR  scenario_clear with cross-cutting fallback' },
  { id: 'T6', q: 'апостиль на документ ЗАГС',                                         expect: 'needs_clarification @ apostille.zags' },
  { id: 'T7', q: 'где ставить апостиль на оригинал или на перевод',                   expect: 'needs_clarification @ apostille  OR  scenario_clear (cross-cutting)' },
  { id: 'T8', q: 'апостиль в Москве',                                                 expect: 'out_of_scope' },
];

async function main() {
  assertTaxonomyConsistency();
  console.log('Scenario decision gate — 8-query battery\n');

  for (const t of TESTS) {
    const started = Date.now();
    const d = await classifyScenario(t.q);
    const took = Date.now() - started;
    const kind = d.kind;
    const body =
      d.kind === 'scenario_clear'
        ? `${d.scenarioKey} — "${d.scenarioLabel}" (conf=${d.confidence})`
        : d.kind === 'needs_clarification'
          ? `@ ${d.atNodeKey} — "${d.disambiguation.prompt}" [${d.disambiguation.options.map(o => o.id).join('/')}]`
          : `reason: ${d.reasoning}`;
    const reasoning = 'reasoning' in d ? d.reasoning : '';
    console.log(`${t.id}  ${t.q}`);
    console.log(`  decision: ${kind}  ${body}  (${took}ms)`);
    if (reasoning && d.kind !== 'out_of_scope') console.log(`  reasoning: ${reasoning}`);
    console.log(`  expected: ${t.expect}`);
    console.log();
  }
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
