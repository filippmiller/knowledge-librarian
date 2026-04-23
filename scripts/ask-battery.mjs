import fs from 'node:fs/promises';

const BASE = 'https://avrora-library-production.up.railway.app';
const AUTH = 'Basic ' + Buffer.from('filipp:Airbus380+').toString('base64');

const TESTS = [
  { id: 'T1-single-word',     q: 'АПОСТИЛЬ',
    expect: 'ambiguous: 3 scenarios possible — should ask clarification' },
  { id: 'T2-zags-spb',        q: 'апостиль на свидетельство о браке в Санкт-Петербурге',
    expect: 'must route to КЗАГС СПб (Фурштатская 52), NOT МЮ or ЛО' },
  { id: 'T3-zags-lo',         q: 'апостиль свидетельство о рождении Ленинградская область',
    expect: 'must route to Управление ЗАГС ЛО (Смольного 3), NOT КЗАГС СПб' },
  { id: 'T4-notary',          q: 'апостиль на нотариальную доверенность',
    expect: 'must route to МЮ, mention that МЮ accepts both СПб+ЛО (R-5)' },
  { id: 'T5-price',           q: 'сколько стоит апостиль',
    expect: 'common fact across 3 docs — should give single answer 2500₽, not triple' },
  { id: 'T6-generic-zags',    q: 'апостиль на документ ЗАГС',
    expect: 'missing region → should ask clarification: СПб or ЛО?' },
  { id: 'T7-policy',          q: 'где ставить апостиль на оригинал или на перевод',
    expect: 'cross-document policy rule — consistent answer' },
  { id: 'T8-out-of-scope',    q: 'апостиль в Москве',
    expect: 'NOT in KB — should honestly say no data (not hallucinate)' },
];

async function ask(question) {
  const r = await fetch(`${BASE}/api/ask`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: AUTH,
    },
    body: JSON.stringify({ question, includeDebug: true }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function unique(arr) { return [...new Set(arr)]; }

function compact(res) {
  const docs = unique(
    [
      res.primarySource?.documentTitle,
      ...(res.supplementarySources ?? []).map((s) => s.documentTitle),
    ].filter(Boolean)
  );
  const citeDocs = unique((res.citations ?? []).map((c) => c.documentTitle).filter(Boolean));
  const chunkScores = [
    res.primarySource?.relevanceScore,
    ...(res.supplementarySources ?? []).map((s) => s.relevanceScore),
  ].filter((x) => typeof x === 'number');
  const spread = chunkScores.length >= 2
    ? (Math.max(...chunkScores) - Math.min(...chunkScores))
    : null;
  return {
    answer: res.answer,
    confidence: res.confidence,
    confidenceLevel: res.confidenceLevel,
    needsClarification: res.needsClarification,
    suggestedClarification: res.suggestedClarification,
    clarificationQuestion: res.clarificationQuestion,
    isAmbiguous: res.queryAnalysis?.isAmbiguous,
    expandedQueries: res.queryAnalysis?.expandedQueries,
    entities: res.queryAnalysis?.extractedEntities,
    domainsUsed: res.domainsUsed,
    docsInSources: docs,
    docsInCitations: citeDocs,
    chunkScoreSpread: spread,
    chunkScores,
  };
}

async function main() {
  const results = [];
  for (const t of TESTS) {
    console.error(`[run] ${t.id}: ${t.q}`);
    const started = Date.now();
    try {
      const r = await ask(t.q);
      const took = Date.now() - started;
      results.push({ test: t, took, result: compact(r) });
    } catch (e) {
      results.push({ test: t, error: String(e.message) });
    }
  }
  await fs.writeFile('tmp-upload/battery-raw.json', JSON.stringify(results, null, 2), 'utf8');

  // Human-readable summary
  const out = [];
  out.push('# Apostille Q&A battery — diagnostic report');
  out.push('');
  for (const { test, result, error, took } of results) {
    out.push(`## ${test.id} — "${test.q}"`);
    out.push(`**Expected:** ${test.expect}`);
    out.push('');
    if (error) { out.push(`ERROR: ${error}`); out.push(''); continue; }
    out.push(`**confidence:** ${result.confidence?.toFixed(3)} (${result.confidenceLevel})`);
    out.push(`**needsClarification:** ${result.needsClarification}`);
    out.push(`**isAmbiguous:** ${result.isAmbiguous}`);
    out.push(`**clarificationQuestion:** ${JSON.stringify(result.clarificationQuestion) ?? 'none'}`);
    out.push(`**suggestedClarification:** ${result.suggestedClarification ?? 'none'}`);
    out.push(`**domainsUsed:** ${(result.domainsUsed ?? []).join(', ')}`);
    out.push(`**docs in sources:** ${result.docsInSources.join(' | ')}`);
    out.push(`**docs in citations:** ${result.docsInCitations.join(' | ')}`);
    out.push(`**chunk score spread:** ${result.chunkScoreSpread?.toFixed(4) ?? 'n/a'} (all: ${result.chunkScores.map(x => x.toFixed(4)).join(', ')})`);
    out.push(`**expanded queries:** ${(result.expandedQueries ?? []).join(' || ')}`);
    out.push(`**latency:** ${took}ms`);
    out.push('');
    out.push('**ANSWER:**');
    out.push('```');
    out.push(result.answer);
    out.push('```');
    out.push('');
    out.push('---');
    out.push('');
  }
  await fs.writeFile('tmp-upload/battery-report.md', out.join('\n'), 'utf8');
  console.error('[done] wrote tmp-upload/battery-report.md + battery-raw.json');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
