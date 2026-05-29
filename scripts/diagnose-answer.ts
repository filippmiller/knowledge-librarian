/**
 * Diagnostic tracer for the enhanced answering engine.
 *
 * For each question it prints, in order:
 *   1. Scenario-gate decision (kind + reasoning) — this is WHERE the source is chosen
 *   2. answerSource — knowledge_base | general_ai | deterministic_guardrail | (none)
 *   3. Confidence (raw % + level) and how it was composed
 *   4. The document chunks that actually entered the context (semantic/keyword/combined)
 *   5. The rules/citations shown to the user
 *   6. The primary source document
 *   7. The final answer text
 *
 * Why this exists: the engine silently switches between answering FROM YOUR
 * DOCUMENTS (RAG) and FROM THE MODEL'S GENERAL KNOWLEDGE ("the internet"),
 * and that switch is invisible in the Telegram UI. This script makes the
 * switch — and the reason for it — explicit so we can see exactly when and
 * why the bot stops using the knowledge base.
 *
 * Usage (DB lives on Railway, so wrap with `railway run`):
 *   railway run npx tsx scripts/diagnose-answer.ts "вопрос 1" "вопрос 2"
 *   railway run npx tsx scripts/diagnose-answer.ts --runs=3 "один вопрос"   # detect non-determinism
 *   railway run npx tsx scripts/diagnose-answer.ts --file=scripts/questions.txt
 *
 * Questions can come from argv, from --file=<path> (one per line, # = comment),
 * or from stdin (one per line) if neither is given.
 */

import { readFileSync } from 'node:fs';
import { answerQuestionEnhanced, type EnhancedAnswerResult } from '../src/lib/ai/enhanced-answering-engine';
import { classifyScenario, type ScenarioDecision } from '../src/lib/knowledge/scenario-classifier';

const SOURCE_BADGE: Record<string, string> = {
  knowledge_base: '🟢 ИЗ ДОКУМЕНТОВ (RAG: чанки + правила + Q&A)',
  general_ai: '🔴 ИЗ ОБЩЕГО ЗНАНИЯ МОДЕЛИ (НЕ из документов!)',
  deterministic_guardrail: '🟡 ХАРДКОД-GUARDRAIL (захардкожено в коде)',
};

function badgeForResult(r: EnhancedAnswerResult): string {
  if (r.answerSource && SOURCE_BADGE[r.answerSource]) return SOURCE_BADGE[r.answerSource];
  if (r.scenarioClarification || (r.needsClarification && r.confidenceLevel === 'insufficient')) {
    return '⚪ НЕ ОТВЕТИЛ — просит уточнение / out_of_scope';
  }
  return `❔ источник не помечен (answerSource=${r.answerSource ?? 'undefined'})`;
}

function describeGate(d: ScenarioDecision): string {
  switch (d.kind) {
    case 'scenario_clear':
      return `scenario_clear → ${d.scenarioKey} ("${d.scenarioLabel}"), conf=${d.confidence}\n     причина: ${d.reasoning ?? '—'}`;
    case 'needs_clarification':
      return `needs_clarification @ ${d.atNodeKey}\n     причина: ${d.reasoning ?? '—'}`;
    case 'knowledge_lookup':
      return `knowledge_lookup ("${d.label}")\n     причина: ${d.reasoning}`;
    case 'out_of_scope':
      return `out_of_scope\n     причина: ${d.reasoning}`;
  }
}

function fmtScore(n: number): string {
  return n.toFixed(4);
}

async function diagnoseOnce(question: string, runLabel: string): Promise<EnhancedAnswerResult> {
  // Run the gate separately first so we see its raw decision even when the
  // engine later overrides routing (e.g. out_of_scope → general AI fallback).
  const gate = await classifyScenario(question);
  const result = await answerQuestionEnhanced(question, undefined, /* includeDebug */ true);

  const lines: string[] = [];
  lines.push(`\n  ── ${runLabel} ──────────────────────────────────────────`);
  lines.push(`  1. ВОРОТА СЦЕНАРИЯ: ${describeGate(gate)}`);
  lines.push(`  2. ИСТОЧНИК ОТВЕТА: ${badgeForResult(result)}`);
  lines.push(
    `  3. УВЕРЕННОСТЬ: ${(result.confidence * 100).toFixed(0)}% (${result.confidenceLevel})` +
      (result.requiresHumanReview ? '  ⚠ requiresHumanReview' : '')
  );
  if (result.scenarioLabel) lines.push(`     сценарий ответа: ${result.scenarioLabel} (${result.scenarioKey ?? '—'})`);

  const chunks = result.debug?.chunks ?? [];
  lines.push(`  4. ЧАНКИ ДОКУМЕНТОВ В КОНТЕКСТЕ: ${chunks.length}` + (chunks.length === 0 ? '  ← НИЧЕГО из документов не попало' : ''));
  chunks.forEach((c, i) => {
    lines.push(
      `     [${i + 1}] sem=${fmtScore(c.semanticScore)} kw=${fmtScore(c.keywordScore)} comb=${fmtScore(c.combinedScore)}`
    );
    lines.push(`         "${c.content.replace(/\s+/g, ' ').slice(0, 140)}…"`);
  });
  if (result.debug?.searchStats) {
    const s = result.debug.searchStats;
    lines.push(`     поиск: всего найдено ${s.totalChunksSearched}, max=${fmtScore(s.maxSimilarity)}, avg=${fmtScore(s.avgSimilarity)}`);
  }

  lines.push(`  5. ИСТОЧНИКИ, ПОКАЗАННЫЕ ПОЛЬЗОВАТЕЛЮ (citations): ${result.citations.length}`);
  result.citations.slice(0, 5).forEach((c) => {
    lines.push(`     ${c.ruleCode ?? '(без кода)'}${c.documentTitle ? ` — ${c.documentTitle}` : ''}  rel=${fmtScore(c.relevanceScore)}`);
  });

  if (result.primarySource) {
    lines.push(`  6. ОСНОВНОЙ ДОКУМЕНТ: ${result.primarySource.documentTitle}  rel=${fmtScore(result.primarySource.relevanceScore)}`);
  } else {
    lines.push(`  6. ОСНОВНОЙ ДОКУМЕНТ: — (ни один документ не привязан как primary)`);
  }

  lines.push(`  7. ОТВЕТ:`);
  for (const ln of result.answer.split('\n')) lines.push(`     │ ${ln}`);

  console.log(lines.join('\n'));
  return result;
}

function loadQuestions(): string[] {
  const args = process.argv.slice(2);
  const fileArg = args.find((a) => a.startsWith('--file='));
  const inline = args.filter((a) => !a.startsWith('--'));

  if (fileArg) {
    const path = fileArg.slice('--file='.length);
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  }
  if (inline.length > 0) return inline;

  // stdin fallback
  try {
    return readFileSync(0, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  } catch {
    return [];
  }
}

async function main() {
  const runsArg = process.argv.slice(2).find((a) => a.startsWith('--runs='));
  const runs = runsArg ? Math.max(1, parseInt(runsArg.slice('--runs='.length), 10) || 1) : 1;
  const questions = loadQuestions();

  if (questions.length === 0) {
    console.error(
      'Нет вопросов. Передай их аргументами, через --file=path, или по stdin.\n' +
        'Пример: railway run npx tsx scripts/diagnose-answer.ts --runs=3 "Как поставить апостиль?"'
    );
    process.exit(1);
  }

  console.log(`Диагностика движка ответов. Вопросов: ${questions.length}, прогонов на вопрос: ${runs}.`);

  for (let q = 0; q < questions.length; q++) {
    const question = questions[q];
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`ВОПРОС ${q + 1}/${questions.length}: ${question}`);
    console.log('═'.repeat(70));

    const sources: string[] = [];
    for (let r = 0; r < runs; r++) {
      const result = await diagnoseOnce(question, `прогон ${r + 1}/${runs}`);
      sources.push(result.answerSource ?? 'none');
    }

    if (runs > 1) {
      const unique = [...new Set(sources)];
      if (unique.length > 1) {
        console.log(`\n  ⚠⚠ НЕДЕТЕРМИНИЗМ: за ${runs} прогонов источник менялся → ${sources.join(', ')}`);
        console.log('     Это и есть «то из базы, то из интернета» — один вопрос, разные источники.');
      } else {
        console.log(`\n  ✓ Стабильно: источник одинаков во всех прогонах (${unique[0]}).`);
      }
    }
  }

  console.log('\nГотово.');
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
