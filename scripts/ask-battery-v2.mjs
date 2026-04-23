// v2 — same 8 questions, but captures the new scenarioKey/scenarioClarification
// fields so we can see the gate in action end-to-end.

import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';

const BASE = 'https://avrora-library-production.up.railway.app';
const AUTH = 'Basic ' + Buffer.from('filipp:Airbus380+').toString('base64');

const TESTS = [
  { id: 'T1', q: 'АПОСТИЛЬ' },
  { id: 'T2', q: 'апостиль на свидетельство о браке в Санкт-Петербурге' },
  { id: 'T3', q: 'апостиль свидетельство о рождении Ленинградская область' },
  { id: 'T4', q: 'апостиль на нотариальную доверенность' },
  { id: 'T5', q: 'сколько стоит апостиль' },
  { id: 'T6', q: 'апостиль на документ ЗАГС' },
  { id: 'T7', q: 'где ставить апостиль на оригинал или на перевод' },
  { id: 'T8', q: 'апостиль в Москве' },
];

// Use Node http module so we can control timeout properly (fetch default 30s).
function ask(question) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ question, includeDebug: false }), 'utf8');
    const req = https.request(`${BASE}/api/ask`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: AUTH,
        'Content-Length': body.length,
      },
      timeout: 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, body: JSON.parse(text) });
        } catch (e) { reject(new Error('parse: ' + e.message + '\nbody: ' + Buffer.concat(chunks).toString('utf8').slice(0, 400))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function unique(arr) { return [...new Set(arr)]; }

async function main() {
  const rows = [];
  for (const t of TESTS) {
    console.error(`[run] ${t.id}: ${t.q}`);
    const started = Date.now();
    try {
      // Gentle throttle to avoid rate limits
      if (rows.length > 0) await new Promise((r) => setTimeout(r, 3000));
      const r = await ask(t.q);
      const took = Date.now() - started;
      const j = r.body;
      const docs = unique([j.primarySource?.documentTitle, ...(j.supplementarySources ?? []).map(s => s.documentTitle)].filter(Boolean));
      rows.push({
        id: t.id, q: t.q, took,
        scenarioKey: j.scenarioKey ?? null,
        scenarioLabel: j.scenarioLabel ?? null,
        scenarioClarification: j.scenarioClarification ?? null,
        needsClarification: j.needsClarification,
        confidence: j.confidence,
        confidenceLevel: j.confidenceLevel,
        docsInSources: docs,
        answer: j.answer,
      });
    } catch (e) {
      rows.push({ id: t.id, q: t.q, error: String(e.message) });
    }
  }

  await fs.writeFile('tmp-upload/battery-v2-raw.json', JSON.stringify(rows, null, 2), 'utf8');

  const out = ['# Scenario-aware battery — post-deploy verification', ''];
  for (const r of rows) {
    out.push(`## ${r.id} — "${r.q}"`);
    if (r.error) { out.push(`ERROR: ${r.error}`); out.push(''); continue; }
    if (r.scenarioClarification) {
      out.push(`**GATE → needs_clarification** @ \`${r.scenarioClarification.atNodeKey}\``);
      out.push(`**Prompt:** ${r.scenarioClarification.prompt}`);
      out.push(`**Options:** ${r.scenarioClarification.options.map(o => `\`${o.id}\` → \`${o.targetScenarioKey}\` (${o.label})`).join(' | ')}`);
    } else if (r.scenarioKey) {
      out.push(`**GATE → scenario_clear** → \`${r.scenarioKey}\` ("${r.scenarioLabel}")`);
      out.push(`**confidence:** ${r.confidence?.toFixed?.(3) ?? r.confidence} (${r.confidenceLevel})`);
      out.push(`**docs retrieved:** ${r.docsInSources.join(' | ') || '(none)'}`);
    } else {
      out.push(`**GATE → out_of_scope** (no scenarioKey in response)`);
      out.push(`**confidence:** ${r.confidence?.toFixed?.(3) ?? r.confidence} (${r.confidenceLevel})`);
    }
    out.push(`**latency:** ${r.took}ms`);
    out.push('');
    out.push('**ANSWER:**');
    out.push('```');
    out.push(r.answer);
    out.push('```');
    out.push('');
    out.push('---');
    out.push('');
  }
  await fs.writeFile('tmp-upload/battery-v2-report.md', out.join('\n'), 'utf8');
  console.error('[done] tmp-upload/battery-v2-report.md');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
