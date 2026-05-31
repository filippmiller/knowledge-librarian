// Single-question diagnostic harness for the answering engine.
//
// Calls answerQuestionEnhanced directly (same path the Telegram bot + web
// playground use) and prints the answer plus its provenance: which source the
// answer came from (knowledge_base | general_ai | deterministic_guardrail),
// the confidence, the matched scenario, whether the gate asked for a
// clarification, and how many citations backed it.
//
// Run against PROD DB:
//   railway run npx tsx scripts/ask.ts "как апостилировать СОР"
//
// NOTE: pass the question as a normal shell arg. Do NOT pipe Cyrillic through
// curl on Windows Git Bash — it corrupts UTF-8 (see memory/diagnostics-harness).

import { answerQuestionEnhanced } from '../src/lib/ai/enhanced-answering-engine';

async function main() {
  const q = process.argv[2];
  if (!q) {
    console.error('usage: npx tsx scripts/ask.ts "<question>"');
    process.exit(1);
  }
  // sessionId is intentionally omitted — a one-shot diagnostic needs no chat
  // session. (Passing a non-string here is a bug: it flows into Prisma writes on
  // the regeneration path and fails with "sessionId: Expected String or Null".)
  const r = await answerQuestionEnhanced(q);
  console.log('\n========== РЕЗУЛЬТАТ ==========');
  console.log('ВОПРОС:', q);
  console.log('ИСТОЧНИК:', r.answerSource, '| УВЕРЕННОСТЬ:', Math.round((r.confidence ?? 0) * 100) + '%', '(' + r.confidenceLevel + ')');
  console.log('СЦЕНАРИЙ:', r.scenarioKey ?? '—', r.scenarioLabel ? '(' + r.scenarioLabel + ')' : '');
  console.log('НУЖНО УТОЧНЕНИЕ:', !!(r.needsClarification || r.scenarioClarification));
  console.log('ИСТОЧНИКИ(цитаты):', (r.citations || []).length, '| осн. документ:', r.primarySource ?? '—');
  console.log('--- ОТВЕТ ---');
  console.log(r.answer);
  console.log('==============================\n');
}
main().catch((e) => {
  console.error('FAIL', (e as Error).message);
  process.exit(1);
});
