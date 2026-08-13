/**
 * Golden regression corpus runner (Beads translation-2n9, gate-семантика —
 * translation-toh / план 2026-08-06 §3 PR A3).
 *
 * Гоняет каждый кейс из src/lib/ai/__tests__/fixtures/eval-corpus.json через
 * answerQuestionEnhanced(), вычисляет РАСПОЛОЖЕНИЕ ответа (прямой ответ /
 * удержание / ошибка) решением продовой политики доставки и сверяет его с
 * явной `expectedDisposition` кейса по матрице из плана.
 *
 * Два режима, и разница между ними принципиальная:
 *
 *   --mode=baseline   снять снимок текущего состояния. НИКОГДА не падает из-за
 *                     содержимого кейсов: свежий корпус законно содержит
 *                     известные провалы (категория "retrieval-gap").
 *   --mode=gate       регрессионный шлюз. exit 1 ровно по матрице: FAIL любого
 *                     кейса и XPASS у KNOWN_FAIL (последний требует ручного
 *                     пересмотра baseline). PASS и XFAIL шлюз не роняют.
 *
 * Нужна продовая база (retrieval + канонические Q&A), поэтому в CI не заведён —
 * запускается вручную после любой правки горячего пути v1
 * (enhanced-answering-engine.ts / vector-search.ts / chat-provider.ts):
 *
 *   railway run npx tsx scripts/run-eval-corpus.ts --mode=baseline
 *   railway run npx tsx scripts/run-eval-corpus.ts --mode=gate
 *   railway run npx tsx scripts/run-eval-corpus.ts --id=wrongscope-minsk-claude11
 *
 * Прогон НЕ пишет продовую телеметрию: движок зовётся с
 * `telemetryMode: 'disabled'`, поэтому HallucinationLog не пополняется
 * синтетикой корпуса (см. src/lib/ai/answer-telemetry.ts).
 *
 * Сам корпус — плоская JSON-фикстура, а не таблица Prisma: это статические
 * регрессионные кейсы под git, не рантайм-данные. См.
 * docs/plans/2026-08-05-aurora-knowledge-engine-v2.md, Задача 0.1.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { answerQuestionEnhanced } from '../src/lib/ai/enhanced-answering-engine';
import {
  createEngineAsk,
  indexById,
  parseCorpus,
  runCorpus,
  summarize,
  type CaseRecord,
  type EvalCase,
} from '../src/lib/eval/corpus';
import { parseRunArgs } from '../src/lib/eval/cli-args';
import { computeExitCode } from '../src/lib/eval/disposition';

const CORPUS_PATH = path.join(__dirname, '../src/lib/ai/__tests__/fixtures/eval-corpus.json');
const DEFAULT_OUT_DIR = path.join(__dirname, '../scratchpad/eval-corpus');

function gitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function formatCaseLine(record: CaseRecord): string {
  const delivery = record.deliveryDecision ? `, delivery=${record.deliveryDecision}` : '';
  return (
    `${record.caseResult} ` +
    `(ожидали ${record.expectedDisposition}, получили ${record.actualDisposition}${delivery})`
  );
}

function printCase(record: CaseRecord): void {
  console.log(formatCaseLine(record));
  for (const failure of record.safetyFailures) console.log(`    ✗ SAFETY: ${failure}`);
  for (const failure of record.assertionFailures) console.log(`    ✗ ${failure}`);
  for (const warning of record.draftSafetyWarnings) console.log(`    ⚠ ${warning}`);
  if (record.engineError) console.log(`    ✗ движок упал: ${record.engineError}`);
}

async function main(): Promise<void> {
  const options = parseRunArgs(process.argv.slice(2));

  const corpus: EvalCase[] = parseCorpus(JSON.parse(readFileSync(CORPUS_PATH, 'utf8')));
  const selected = options.idFilter
    ? corpus.filter((c) => c.id === options.idFilter)
    : corpus;

  if (selected.length === 0) {
    // Операционная ошибка, а не содержимое кейсов: падаем в обоих режимах,
    // иначе опечатка в --id выглядела бы как успешный прогон.
    throw new Error(`--id=${options.idFilter} не совпал ни с одним кейсом корпуса.`);
  }

  console.log(`Golden regression corpus: ${selected.length} кейс(ов), режим ${options.mode}.\n`);

  const ask = createEngineAsk((request) => answerQuestionEnhanced(request));
  const records = await runCorpus(selected, ask, (record) => {
    process.stdout.write(`[${record.category}] ${record.id} … `);
    printCase(record);
  });

  const summary = summarize(records);
  const exitCode = computeExitCode(options.mode, records.map((r) => r.caseResult));

  console.log('\n' + '─'.repeat(60));
  console.log('Агрегат:');
  console.log(
    `  вердикты:         PASS ${summary.byCaseResult.PASS} · FAIL ${summary.byCaseResult.FAIL} · ` +
      `XFAIL ${summary.byCaseResult.XFAIL} · XPASS ${summary.byCaseResult.XPASS} (из ${summary.total})`
  );
  console.log(
    `  расположения:     DIRECT_ANSWER ${summary.byActualDisposition.DIRECT_ANSWER} · ` +
      `HOLD ${summary.byActualDisposition.HOLD} · ERROR ${summary.byActualDisposition.ERROR}`
  );
  console.log(`  hold rate:        ${(summary.holdRate * 100).toFixed(1)}%`);
  if (summary.failedIds.length > 0) console.log(`  FAIL:             ${summary.failedIds.join(', ')}`);
  if (summary.xpassIds.length > 0) {
    console.log(`  XPASS:            ${summary.xpassIds.join(', ')} — снять KNOWN_FAIL или объяснить`);
  }
  if (summary.xfailIds.length > 0) console.log(`  XFAIL (ожидаемо): ${summary.xfailIds.join(', ')}`);
  if (summary.errorIds.length > 0) console.log(`  ОШИБКИ ДВИЖКА:    ${summary.errorIds.join(', ')}`);

  const ranAt = new Date().toISOString();
  const outPath =
    options.outPath ?? path.join(DEFAULT_OUT_DIR, `eval-corpus-${ranAt.replace(/[:.]/g, '-')}.json`);
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        meta: {
          ranAt,
          gitSha: gitSha(),
          mode: options.mode,
          argv: process.argv.slice(2),
          corpusPath: path.relative(path.join(__dirname, '..'), CORPUS_PATH),
          caseCount: records.length,
          telemetryMode: 'disabled',
          exitCode,
        },
        summary,
        // По СТАБИЛЬНЫМ id, а не по порядку в файле: перестановка кейсов не
        // должна сдвигать diff двух снимков.
        cases: indexById(records),
      },
      null,
      2
    ),
    'utf8'
  );
  console.log(`\nСнимок: ${outPath}`);

  if (options.mode === 'baseline' && summary.blockingIds.length > 0) {
    console.log(
      `\nВ режиме gate этот прогон упал бы на: ${summary.blockingIds.join(', ')} (baseline не падает by design).`
    );
  }

  process.exit(exitCode);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
