import fs from 'node:fs/promises';

const BASE = 'https://avrora-library-production.up.railway.app';
const AUTH = 'Basic ' + Buffer.from('filipp:Airbus380+').toString('base64');

const TESTS = [
  { id: 'T1-single-word', q: 'АПОСТИЛЬ',
    expect: 'ambiguous: 3 scenarios possible — should ask clarification' },
  { id: 'T2-zags-spb',    q: 'апостиль на свидетельство о браке в Санкт-Петербурге',
    expect: 'must route to КЗАГС СПб (Фурштатская 52), NOT МЮ or ЛО' },
];

async function ask(question, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r = await fetch(`${BASE}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: AUTH },
        body: JSON.stringify({ question, includeDebug: true }),
      });
      if (r.status === 429) {
        console.error(`  rate-limited, sleep 20s (attempt ${attempt})`);
        await new Promise((res) => setTimeout(res, 20000));
        continue;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    } catch (e) {
      console.error(`  fetch err ${e.message}, sleep 10s (attempt ${attempt})`);
      await new Promise((res) => setTimeout(res, 10000));
    }
  }
  throw new Error('all retries failed');
}

async function main() {
  const existing = JSON.parse(await fs.readFile('tmp-upload/battery-raw.json', 'utf8'));
  for (const t of TESTS) {
    console.error(`[retry] ${t.id}: ${t.q}`);
    const started = Date.now();
    await new Promise((res) => setTimeout(res, 5000));
    try {
      const r = await ask(t.q);
      const took = Date.now() - started;
      const i = existing.findIndex((x) => x.test.id === t.id);
      const compact = {
        answer: r.answer,
        confidence: r.confidence,
        confidenceLevel: r.confidenceLevel,
        needsClarification: r.needsClarification,
        suggestedClarification: r.suggestedClarification,
        clarificationQuestion: r.clarificationQuestion,
        isAmbiguous: r.queryAnalysis?.isAmbiguous,
        expandedQueries: r.queryAnalysis?.expandedQueries,
        domainsUsed: r.domainsUsed,
        docsInSources: [...new Set([r.primarySource?.documentTitle, ...(r.supplementarySources ?? []).map(s => s.documentTitle)].filter(Boolean))],
        docsInCitations: [...new Set((r.citations ?? []).map((c) => c.documentTitle).filter(Boolean))],
        chunkScoreSpread: (() => {
          const scores = [r.primarySource?.relevanceScore, ...(r.supplementarySources ?? []).map(s => s.relevanceScore)].filter(x => typeof x === 'number');
          return scores.length >= 2 ? Math.max(...scores) - Math.min(...scores) : null;
        })(),
        chunkScores: [r.primarySource?.relevanceScore, ...(r.supplementarySources ?? []).map(s => s.relevanceScore)].filter(x => typeof x === 'number'),
      };
      if (i >= 0) existing[i] = { test: t, took, result: compact };
      else existing.push({ test: t, took, result: compact });
    } catch (e) {
      console.error(`  FAILED: ${e.message}`);
    }
  }
  await fs.writeFile('tmp-upload/battery-raw.json', JSON.stringify(existing, null, 2), 'utf8');
  console.error('[done] updated tmp-upload/battery-raw.json');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
