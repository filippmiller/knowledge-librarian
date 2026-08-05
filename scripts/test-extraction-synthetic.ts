/**
 * ISOLATED, READ-ONLY test of the REAL knowledge extractor (streamKnowledgeExtraction
 * from src/lib/ai/knowledge-extractor-stream.ts) against a synthetic, domain-neutral
 * document. This is NOT a production run:
 *  - No Document/Rule/QAPair/DocChunk rows are created or touched.
 *  - streamKnowledgeExtraction() itself never writes to the DB (only
 *    getExistingRuleCodesForStream() reads Rule.ruleCode, and we don't call it —
 *    we pass existingRuleCodes=[] directly).
 *  - Uses the exact same system prompt, model, and JSON contract as production.
 *
 * Purpose: verify whether the extractor preserves rule *applicability conditions*
 * (who/when/what-not) as structured, checkable data, or dissolves them into free text
 * — the same failure mode found today in real documents (Oryol apostille-partner rule
 * losing its "only education documents" scope).
 *
 * Run:  npx tsx scripts/test-extraction-synthetic.ts
 * Needs: ANTHROPIC_API_KEY (or OPENAI_API_KEY + AI_PROVIDER=openai) in .env — same
 * contract as chat-provider.ts. No Railway / no production DB access required.
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import path from 'path';
import { streamKnowledgeExtraction, type KnowledgeExtractionStreamResult } from '../src/lib/ai/knowledge-extractor-stream';

// Deliberately absurd, business-neutral topic (owner's choice) so results can't be
// confused with real Aurora translation-bureau data. Structurally it mirrors a real
// business leaflet: several rules, each with a DIFFERENT kind of applicability
// condition (who / when / exception-with-negation / prerequisite list / sequence /
// mutually exclusive alternative / hard forbidden action).
const SYNTHETIC_DOCUMENT = `
ПРАВИЛА ГИГИЕНЫ: КАК ПРАВИЛЬНО ВЫТИРАТЬ ЖОПУ
Внутренняя инструкция для дежурного персонала санатория "Ромашка"

1. Общий порядок действий. Правильное вытирание жопы предполагает следующую
последовательность: сначала снять штаны и нижнее бельё, затем убедиться, что руки
чистые, и только после этого приступать к процедуре. Нарушение порядка действий
считается грубым нарушением инструкции.

2. Необходимые материалы. Для вытирания жопы вам потребуются: туалетная бумага
(двухслойная, белая), одноразовые перчатки и терпение. Без перчаток процедуру
проводить запрещается персоналу, работающему с более чем одним пациентом в смену.

3. Если бумаги нет. Если туалетной бумаги нет в наличии — можно временно
использовать влажные салфетки без отдушки. Использовать мыло вместо туалетной
бумаги категорически запрещено: мыло вызывает раздражение кожи.

4. Дети до 5 лет. Детям в возрасте до 5 лет вытирать жопу должен исключительно
взрослый — воспитатель или родитель. Детям старше 5 лет разрешается делать это
самостоятельно под присмотром.

5. После процедуры. После вытирания жопы обязательно вымыть руки с мылом в
течение не менее 20 секунд. Это отдельное, самостоятельное действие, которое
нельзя путать с шагом 1 (мытьё рук ДО процедуры).

6. Лежачие пациенты. Для лежачих пациентов, которые не могут самостоятельно
поменять положение тела, вытирание жопы выполняет только медицинская сестра,
и только с использованием впитывающей пелёнки, подложенной заранее.

7. Что делать при раздражении кожи. Если после вытирания жопы у пациента
появилось покраснение или раздражение — использование обычной туалетной бумаги
временно прекращают и переходят на влажные салфетки с алоэ вера до исчезновения
раздражения, но не дольше 3 дней подряд; если раздражение не проходит за 3 дня,
нужно вызвать дежурного врача.

8. Ночная смена. В ночную смену (с 22:00 до 06:00) вытирание жопы лежачим
пациентам выполняется только вдвоём — младшая медсестра и санитар вместе,
для соблюдения техники безопасности при перемещении пациента.

9. Запрещённые материалы. Категорически запрещается использовать при вытирании
жопы: газеты, любые ткани многоразового использования без стирки при 90°C,
а также любые материалы с ароматизаторами при наличии у пациента аллергии.

10. Утилизация. Использованная туалетная бумага и салфетки выбрасываются в
контейнер с педальной крышкой; перчатки — в отдельный контейнер для медицинских
отходов, а не в общий мусор.
`.trim();

async function main() {
  console.log('=== SYNTHETIC EXTRACTION TEST (isolated, no DB writes) ===');
  console.log(`Document length: ${SYNTHETIC_DOCUMENT.length} chars`);
  console.log(`AI_PROVIDER=${process.env.AI_PROVIDER || '(default: anthropic if key present, else openai)'}`);
  console.log(`ANTHROPIC_API_KEY present: ${!!process.env.ANTHROPIC_API_KEY}`);
  console.log(`OPENAI_API_KEY present: ${!!process.env.OPENAI_API_KEY}`);
  console.log('');

  let result: KnowledgeExtractionStreamResult | null = null;
  let tokenCount = 0;

  for await (const event of streamKnowledgeExtraction(SYNTHETIC_DOCUMENT, [])) {
    if (event.type === 'batch_progress') {
      console.log(`[batch_progress]`, event.data);
    } else if (event.type === 'batch_skipped') {
      console.warn(`[batch_skipped]`, event.data);
    } else if (event.type === 'token') {
      tokenCount++;
      // Don't print every token; just count them for a progress signal.
    } else if (event.type === 'result') {
      result = event.data as KnowledgeExtractionStreamResult;
    }
  }

  console.log(`Streamed ${tokenCount} token chunks.`);
  console.log('');

  if (!result) {
    console.error('FAILED: no result event received from streamKnowledgeExtraction.');
    process.exit(1);
  }

  console.log(`Extracted ${result.rules.length} rules, ${result.qaPairs.length} QA pairs, ${result.uncertainties.length} uncertainties.`);
  console.log('');

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

  const outPath = path.join(__dirname, '..', 'scratchpad', 'extraction-synthetic-result.json');
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        meta: {
          ranAt: new Date().toISOString(),
          documentLength: SYNTHETIC_DOCUMENT.length,
          extractor: 'src/lib/ai/knowledge-extractor-stream.ts::streamKnowledgeExtraction',
        },
        document: SYNTHETIC_DOCUMENT,
        result,
      },
      null,
      2
    ),
    'utf-8'
  );
  console.log(`\nFull JSON written to: ${outPath}`);
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
