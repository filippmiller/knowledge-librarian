/**
 * Isolated, read-only test of the REAL knowledge extractor
 * (streamKnowledgeExtraction from src/lib/ai/knowledge-extractor-stream.ts)
 * against an arbitrary document + an optional semantic ground-truth pack.
 * Generalizes scripts/test-extraction-synthetic.ts (which hardcoded one
 * inline document) to accept any file — in particular a "test pack" like
 * the one used to ground Beads translation-mwo's truth table.
 *
 * NOT a production run:
 *  - No Document/Rule/QAPair/DocChunk rows are created or touched.
 *  - streamKnowledgeExtraction() itself never writes to the DB.
 *  - Uses the exact same system prompt, model, and JSON contract as production
 *    (via the same function), and the same file parser as document upload
 *    (src/lib/document-parser.ts), so results reflect real behavior.
 *
 * Purpose: verify whether the extractor preserves rule *applicability
 * conditions* (who/when/exception/numeric-limit) as checkable data, or
 * dissolves them into free text — see .claude/audits/2026-08-05-extraction-quality-review.md
 * and the translation-2n9 comment this script's predecessor was built to test.
 *
 * Usage:
 *   npx tsx scripts/test-extraction-pack.ts --doc=path/to/source.docx
 *   npx tsx scripts/test-extraction-pack.ts --doc=path/to/source.docx --cases=path/to/cases.jsonl
 *
 * The --cases file is JSONL, one object per line:
 *   {"id": "Q01", "question": "...", "expected_rule_ids": [1], "expected_answer": "...", "match_reason": "..."}
 * `expected_rule_ids` refer to the NUMBERED rules in the source document (1-based,
 * as written by a human), not the extractor's generated ruleCode (R-1, R-2, ...) —
 * the whole point is to check whether the extractor's output, read by a human,
 * still lets someone answer the question correctly.
 *
 * Needs: ANTHROPIC_API_KEY (or OPENAI_API_KEY + AI_PROVIDER=openai) in .env —
 * same contract as chat-provider.ts. No Railway / no production DB access
 * required for the document parsing + extraction step. The optional grading
 * step also calls the LLM (read-only judgment call, no DB).
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { parseDocument, detectMimeType } from '../src/lib/document-parser';
import { streamKnowledgeExtraction, type KnowledgeExtractionStreamResult } from '../src/lib/ai/knowledge-extractor-stream';
import { createChatCompletion } from '../src/lib/ai/chat-provider';

interface TestCase {
  id: string;
  question: string;
  expected_rule_ids: number[];
  expected_answer: string;
  match_reason: string;
}

interface GradeResult {
  caseId: string;
  verdict: 'PRESERVED' | 'DEGRADED' | 'LOST';
  reasoning: string;
}

function parseArgs(): { docPath: string; casesPath: string | null } {
  const args = process.argv.slice(2);
  const docArg = args.find((a) => a.startsWith('--doc='));
  const casesArg = args.find((a) => a.startsWith('--cases='));
  if (!docArg) {
    console.error('Usage: npx tsx scripts/test-extraction-pack.ts --doc=path/to/source.docx [--cases=path/to/cases.jsonl]');
    process.exit(1);
  }
  return {
    docPath: docArg.slice('--doc='.length),
    casesPath: casesArg ? casesArg.slice('--cases='.length) : null,
  };
}

function loadCases(casesPath: string): TestCase[] {
  return readFileSync(casesPath, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

async function runExtraction(documentText: string): Promise<KnowledgeExtractionStreamResult> {
  let result: KnowledgeExtractionStreamResult | null = null;
  let tokenCount = 0;

  for await (const event of streamKnowledgeExtraction(documentText, [])) {
    if (event.type === 'batch_progress') {
      console.log('[batch_progress]', event.data);
    } else if (event.type === 'batch_skipped') {
      console.warn('[batch_skipped]', event.data);
    } else if (event.type === 'token') {
      tokenCount++;
    } else if (event.type === 'result') {
      result = event.data as KnowledgeExtractionStreamResult;
    }
  }
  console.log(`Streamed ${tokenCount} token chunks.\n`);
  if (!result) throw new Error('no result event received from streamKnowledgeExtraction');
  return result;
}

/**
 * Grades whether a source rule's applicability condition survived extraction —
 * by asking the model to judge the EXTRACTED output alone (no source text),
 * simulating what a bot answering from the base would actually see. If the
 * extracted rules can't answer the test question correctly, the condition was
 * lost regardless of what the source document said.
 */
async function gradeCase(testCase: TestCase, extraction: KnowledgeExtractionStreamResult): Promise<GradeResult> {
  const rulesText = extraction.rules
    .map((r) => `[${r.ruleCode}] ${r.title}\n${r.body}`)
    .join('\n\n');

  const prompt = `Ты — независимый экзаменатор. Ниже приведены ВСЕ правила, которые экстрактор базы знаний извлёк из документа (это единственное, что видит бот при ответе — не исходный документ).

ИЗВЛЕЧЁННЫЕ ПРАВИЛА:
${rulesText}

ВОПРОС: ${testCase.question}

ОЖИДАЕМЫЙ СМЫСЛ ОТВЕТА (из ручного ключа, для сверки — не показывать пользователю): ${testCase.expected_answer}

Можно ли, опираясь ТОЛЬКО на извлечённые правила выше, дать ответ, совпадающий по смыслу с ожидаемым (сохранены условия, исключения, числовые ограничения — не обязательно дословно)?

Ответь строго в формате:
VERDICT: PRESERVED | DEGRADED | LOST
REASONING: <одно-два предложения — что именно сохранилось или потерялось>

PRESERVED = смысл и все условия/числа воспроизводимы.
DEGRADED = общий смысл понятен, но потеряно условие, исключение или число, из-за чего ответ был бы неполным или ввёл бы в заблуждение.
LOST = извлечённые правила не позволяют ответить на вопрос вообще, или дали бы прямо неверный ответ.`;

  const text = await createChatCompletion({
    messages: [{ role: 'user', content: prompt }],
    temperature: 0,
  });
  const verdictMatch = text.match(/VERDICT:\s*(PRESERVED|DEGRADED|LOST)/i);
  const reasoningMatch = text.match(/REASONING:\s*([\s\S]+)/i);

  return {
    caseId: testCase.id,
    verdict: (verdictMatch?.[1]?.toUpperCase() as GradeResult['verdict']) ?? 'LOST',
    reasoning: reasoningMatch?.[1]?.trim() ?? text.trim(),
  };
}

async function main() {
  const { docPath, casesPath } = parseArgs();

  console.log('=== EXTRACTION PACK TEST (isolated, no DB writes) ===');
  console.log(`Document: ${docPath}`);
  console.log(`AI_PROVIDER=${process.env.AI_PROVIDER || '(default: anthropic if key present, else openai)'}`);
  console.log('');

  const buffer = readFileSync(docPath);
  const mimeType = detectMimeType(path.basename(docPath));
  const documentText = await parseDocument(buffer, mimeType, path.basename(docPath));
  console.log(`Parsed document length: ${documentText.length} chars\n`);

  const result = await runExtraction(documentText);

  console.log(`Extracted ${result.rules.length} rules, ${result.qaPairs.length} QA pairs, ${result.uncertainties.length} uncertainties.\n`);

  console.log('--- RULES ---');
  for (const rule of result.rules) {
    console.log(`\n[${rule.ruleCode}] ${rule.title}`);
    console.log(`  body: ${rule.body}`);
    console.log(`  confidence: ${rule.confidence}`);
    console.log(`  quote: "${rule.sourceSpan?.quote ?? ''}"`);
    console.log(`  locationHint: ${rule.sourceSpan?.locationHint ?? ''}`);
  }

  console.log('\n--- QA PAIRS ---');
  for (const qa of result.qaPairs) {
    console.log(`\nQ: ${qa.question}`);
    console.log(`A: ${qa.answer}`);
    console.log(`  linkedRuleCode: ${qa.linkedRuleCode}`);
  }

  console.log('\n--- UNCERTAINTIES ---');
  for (const u of result.uncertainties) {
    console.log(`\n[${u.type}] ${u.description}`);
    console.log(`  suggestedQuestion: ${u.suggestedQuestion}`);
  }

  const outDir = path.join(__dirname, '..', 'scratchpad');
  const outPath = path.join(outDir, `extraction-pack-result-${path.basename(docPath, path.extname(docPath))}.json`);
  writeFileSync(
    outPath,
    JSON.stringify({ meta: { ranAt: new Date().toISOString(), docPath, documentLength: documentText.length }, document: documentText, result }, null, 2),
    'utf-8'
  );
  console.log(`\nFull JSON written to: ${outPath}`);

  if (!casesPath) {
    console.log('\n(no --cases given, skipping semantic grading)');
    return;
  }

  console.log('\n\n=== SEMANTIC GRADING (does extracted output preserve each rule\'s condition?) ===\n');
  const cases = loadCases(casesPath);
  const grades: GradeResult[] = [];
  for (const tc of cases) {
    process.stdout.write(`${tc.id} … `);
    const grade = await gradeCase(tc, result);
    grades.push(grade);
    console.log(grade.verdict);
    if (grade.verdict !== 'PRESERVED') console.log(`    ${grade.reasoning}`);
  }

  const preserved = grades.filter((g) => g.verdict === 'PRESERVED').length;
  const degraded = grades.filter((g) => g.verdict === 'DEGRADED').length;
  const lost = grades.filter((g) => g.verdict === 'LOST').length;

  console.log('\n' + '─'.repeat(60));
  console.log('Агрегат:');
  console.log(`  PRESERVED: ${preserved}/${grades.length}`);
  console.log(`  DEGRADED:  ${degraded}/${grades.length}`);
  console.log(`  LOST:      ${lost}/${grades.length}`);
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
