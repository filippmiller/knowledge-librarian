// Multi-step clarification test. Simulates the mini-app flow:
// 1. User types "АПОСТИЛЬ" → gate returns needs_clarification @ apostille
// 2. User clicks "Свидетельство ЗАГС..." → sends with clarificationAnswer
//    → gate returns needs_clarification @ apostille.zags
// 3. User clicks "Санкт-Петербург" → sends with chained clarificationAnswer
//    → gate returns scenario_clear → apostille.zags.spb → full answer

import https from 'node:https';

const BASE = 'https://avrora-library-production.up.railway.app';
const AUTH = 'Basic ' + Buffer.from('filipp:Airbus380+').toString('base64');

function ask(body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const req = https.request(`${BASE}/api/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: AUTH,
        'Content-Length': payload.length,
      },
      timeout: 180000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

function describe(step, r) {
  const j = r.body;
  console.log(`\n━━━ STEP ${step} (HTTP ${r.status}) ━━━`);
  if (j.scenarioClarification) {
    console.log(`GATE: needs_clarification @ ${j.scenarioClarification.atNodeKey}`);
    console.log(`Q: ${j.scenarioClarification.prompt}`);
    for (const o of j.scenarioClarification.options) {
      console.log(`   [${o.id}] ${o.label}  → ${o.targetScenarioKey}`);
    }
  } else if (j.scenarioKey) {
    console.log(`GATE: scenario_clear → ${j.scenarioKey} ("${j.scenarioLabel}")`);
    console.log(`ANSWER (first 400):\n${(j.answer || '').slice(0, 400)}...`);
  } else {
    console.log('OUT_OF_SCOPE or error:', (j.answer || j).toString().slice(0, 200));
  }
}

async function main() {
  const q = 'АПОСТИЛЬ';
  console.log(`User question: "${q}"`);

  // Step 1: bare question
  const r1 = await ask({ question: q });
  describe(1, r1);

  // Step 2: user picks "Свидетельство ЗАГС..."
  const firstChoice = r1.body.scenarioClarification?.options.find((o) => o.id === 'zags')?.label;
  if (!firstChoice) { console.error('no zags option found'); return; }
  const r2 = await ask({ question: q, clarificationAnswer: firstChoice });
  describe(2, r2);

  // Step 3: chain contains BOTH answers, separated by " → "
  const secondChoice = r2.body.scenarioClarification?.options.find((o) => o.id === 'spb')?.label;
  if (!secondChoice) { console.error('no spb option found'); return; }
  const chain = `${firstChoice} → ${secondChoice}`;
  const r3 = await ask({ question: q, clarificationAnswer: chain });
  describe(3, r3);

  console.log('\n━━━ VERDICT ━━━');
  const ok = r3.body.scenarioKey === 'apostille.zags.spb';
  console.log(ok ? '✅ Multi-step clarification works — landed on apostille.zags.spb'
                 : `❌ Ended at ${r3.body.scenarioKey ?? '(none)'} instead of apostille.zags.spb`);
}
main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
