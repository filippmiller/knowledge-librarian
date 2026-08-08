/**
 * Extraction-only runner (Step 2, continuation session Aurora v2, Beads
 * translation-2j8 / translation-yz9).
 *
 * ГРАНИЦА ОТВЕТСТВЕННОСТИ. `--stage=extraction` — единственная поддержанная
 * стадия. НЕ запускает retrieval, applicability, synthesis или grader. Путь:
 *
 *   DOCX -> CanonicalDocument -> SourceBlock[] -> extractKnowledgeUnits()
 *   -> (parent resolution уже внутри extractKnowledgeUnits, validateParentRefs)
 *   -> assignIdentity() -> evidence offset diagnostics -> артефакты.
 *
 * ORACLE ISOLATION (жёсткое требование): этот файл не имеет права
 * импортировать НИЧЕГО из `src/lib/eval/` и не имеет права упоминать имя
 * учебного пакета/файлов oracle строковым литералом — источник документа
 * передаётся раннеру через `--doc=`, не зашивается сюда. Проверяется тем же
 * механизмом, что и продуктовый код (`oracle-isolation.test.ts` сканирует
 * ВЕСЬ `src/`, но этот файл живёт в `scripts/` — вне автоматических ворот,
 * поэтому дисциплина здесь имеет то же значение, что и код: ничего из
 * `@/lib/eval` не импортируется, полное имя пакета/oracle-файлов не
 * встречается нигде ниже).
 *
 * Runner НЕ создаёт человеческое решение accept/reject/edit — та сессия,
 * что писала этот раннер, уже видела oracle (готовя грейдер) и потому
 * дисквалифицирована как ревьюер. Вместо committed review manifest раннер
 * производит oracle-blind review packet (units + их evidence, БЕЗ каких-либо
 * оценок) и останавливается со статусом REVIEW_REQUIRED.
 *
 * Usage:
 *   npx tsx scripts/run-extraction.ts --stage=extraction --doc=path/to/source.docx --out=path/to/dir
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  extractCanonicalDocument,
  toSourceBlockLocation,
  type CanonicalDocument,
} from '../src/lib/knowledge/docx-canonical-blocks';
import {
  extractKnowledgeUnits,
  type ExtractKnowledgeUnitsOptions,
  type ExtractKnowledgeUnitsResult,
  type SourceBlock,
} from '../src/lib/knowledge/knowledge-unit-extractor';
import { StructuredOutputError } from '../src/lib/ai/structured-output';
import { ChatCompletionError } from '../src/lib/ai/chat-provider';
import {
  assignIdentity,
  type IdentityAssignmentResult,
  type PersistedKnowledgeUnit,
  type SourceBlockLocation,
} from '../src/lib/knowledge/applicability/identity-assignment';
import { resolveEvidenceOffsets } from '../src/lib/knowledge/applicability/identity';
import { resolveExtractionRunConfig } from '../src/lib/ai/extraction-run';
import type { ExtractedKnowledgeUnit } from '../src/lib/knowledge/applicability/extraction';

// ─────────────────────────────────── CLI ────────────────────────────────────

const SUPPORTED_STAGES = ['extraction'] as const;
type Stage = (typeof SUPPORTED_STAGES)[number];

interface CliArgs {
  stage: Stage;
  docPath: string;
  outDir: string;
}

const USAGE =
  'Usage: npx tsx scripts/run-extraction.ts --stage=extraction --doc=path/to/source.docx --out=path/to/dir';

function parseArgs(argv: readonly string[]): CliArgs {
  const known = ['--stage=', '--doc=', '--out='];
  const unknown = argv.filter((a) => !known.some((k) => a.startsWith(k)));
  if (unknown.length > 0) {
    throw new Error(`Неизвестные аргументы: ${unknown.join(', ')}\n${USAGE}`);
  }

  const stageArg = argv.find((a) => a.startsWith('--stage='))?.slice('--stage='.length);
  const docArg = argv.find((a) => a.startsWith('--doc='))?.slice('--doc='.length);
  const outArg = argv.find((a) => a.startsWith('--out='))?.slice('--out='.length);

  if (!stageArg || !docArg || !outArg) {
    throw new Error(`--stage, --doc и --out обязательны.\n${USAGE}`);
  }
  if (!(SUPPORTED_STAGES as readonly string[]).includes(stageArg)) {
    throw new Error(
      `Неподдержанная стадия "${stageArg}". Поддержана только: ${SUPPORTED_STAGES.join(', ')}.`
    );
  }

  return { stage: stageArg as Stage, docPath: docArg, outDir: outArg };
}

function gitSha(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

// ─────────────────────── retry on schema/truncation failure ─────────────────

interface ExtractionAttemptLog {
  readonly attempt: number;
  readonly outcome: 'SUCCESS' | 'SCHEMA_MISMATCH' | 'TRUNCATED_JSON' | 'NETWORK_ERROR' | 'OTHER_ERROR';
  readonly message: string | null;
}

/**
 * `structured()` намеренно НЕ повторяет вызов при `SCHEMA_MISMATCH`/
 * `TRUNCATED_JSON` — комментарий в `structured-output.ts` явно называет это
 * решением ВЫЗЫВАЮЩЕГО кода, не механикой адаптера. Первый реальный прогон
 * этой сессии (claude-haiku-4-5) поймал оба класса на живом вызове:
 * пропущенные (не `null`, а вовсе отсутствующие) `triggerCondition`/
 * `numericConstraint`, `privacyContext` (ключ триггер-фактов), положенный в
 * `facets`, и `facets.scenario`, присланный МАССИВОМ вместо одной строки —
 * все три пофиксены в схеме/промпте (см. commit), но сетевые обрывы
 * (`ChatCompletionError`, `UND_ERR_SOCKET`) на этом же прогоне тоже
 * встретились и НЕ связаны с содержанием ответа — тоже разумно повторить.
 * Ограниченный повтор — стандартная, документированная здесь практика для
 * ЭТИХ классов сбоев, не попытка скрыть нестабильность: КАЖДАЯ попытка,
 * включая неудачные, попадает в `attemptLog` и уходит в
 * extraction-summary.json.
 */
async function extractKnowledgeUnitsWithRetry(
  options: ExtractKnowledgeUnitsOptions,
  maxAttempts: number
): Promise<{ result: ExtractKnowledgeUnitsResult; attemptLog: ExtractionAttemptLog[] }> {
  const attemptLog: ExtractionAttemptLog[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await extractKnowledgeUnits(options);
      attemptLog.push({ attempt, outcome: 'SUCCESS', message: null });
      return { result, attemptLog };
    } catch (error) {
      const outcome: ExtractionAttemptLog['outcome'] =
        error instanceof StructuredOutputError
          ? error.reason === 'SCHEMA_MISMATCH'
            ? 'SCHEMA_MISMATCH'
            : error.reason === 'TRUNCATED_JSON'
              ? 'TRUNCATED_JSON'
              : 'OTHER_ERROR'
          : error instanceof ChatCompletionError
            ? 'NETWORK_ERROR'
            : 'OTHER_ERROR';
      const retryable = outcome !== 'OTHER_ERROR';
      attemptLog.push({
        attempt,
        outcome,
        message: error instanceof Error ? error.message : String(error),
      });
      console.warn(`[extraction attempt ${attempt}/${maxAttempts}] failed (${outcome}): ${attemptLog[attemptLog.length - 1].message}`);
      if (!retryable || attempt === maxAttempts) throw error;
    }
  }
  // Недостижимо — цикл либо возвращает, либо бросает на последней попытке.
  throw new Error('extractKnowledgeUnitsWithRetry: unreachable');
}

// ──────────────────────── evidence-resolution diagnostics ───────────────────

type QuoteMatchCount = 'ZERO' | 'ONE' | 'MULTIPLE';

interface EvidenceResolutionEntry {
  readonly extractionRef: string;
  readonly blockAnchor: string;
  readonly quote: string;
  readonly matchCount: QuoteMatchCount;
  readonly blockRelativeOffsets: { readonly start: number; readonly end: number } | null;
  readonly canonicalAbsoluteOffsets: { readonly start: number; readonly end: number } | null;
  readonly failureReason: string | null;
}

/**
 * Независимая от `resolveEvidenceOffsets()` диагностика — та функция
 * специально возвращает `null` одинаково и на "не найдено", и на "найдено
 * больше одного раза" (план §3 PR F: и то, и другое — ошибка экстракции, не
 * повод для эвристики). Раннеру же для отчёта нужно РАЗЛИЧИЕ этих двух
 * причин, поэтому подсчёт вхождений — здесь, отдельно, не меняя identity.ts.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    count++;
    from = idx + 1;
  }
  return count;
}

function resolveEvidenceDiagnostics(
  unit: ExtractedKnowledgeUnit,
  blocksByAnchor: ReadonlyMap<string, SourceBlockLocation>
): EvidenceResolutionEntry {
  const block = blocksByAnchor.get(unit.sourceSpan.anchor);
  if (!block) {
    return {
      extractionRef: unit.extractionRef,
      blockAnchor: unit.sourceSpan.anchor,
      quote: unit.sourceSpan.quote,
      matchCount: 'ZERO',
      blockRelativeOffsets: null,
      canonicalAbsoluteOffsets: null,
      failureReason: `sourceSpan.anchor "${unit.sourceSpan.anchor}" не найден среди известных блоков документа`,
    };
  }

  const occurrences = countOccurrences(block.text, unit.sourceSpan.quote);
  const matchCount: QuoteMatchCount =
    occurrences === 0 ? 'ZERO' : occurrences === 1 ? 'ONE' : 'MULTIPLE';
  const offsets = resolveEvidenceOffsets(block.text, unit.sourceSpan.quote);

  return {
    extractionRef: unit.extractionRef,
    blockAnchor: unit.sourceSpan.anchor,
    quote: unit.sourceSpan.quote,
    matchCount,
    blockRelativeOffsets: offsets,
    canonicalAbsoluteOffsets:
      offsets === null
        ? null
        : { start: block.blockStart + offsets.start, end: block.blockStart + offsets.end },
    failureReason:
      matchCount === 'ZERO'
        ? 'цитата не найдена дословно в тексте блока'
        : matchCount === 'MULTIPLE'
          ? `цитата встречается ${occurrences} раз(а) в тексте блока — неоднозначно, какое вхождение имелось в виду`
          : null,
  };
}

// ──────────────────────────── extraction-summary gate ───────────────────────

type StageResult = 'EXTRACTION_READY_FOR_REVIEW' | 'EXTRACTION_GATE_FAIL';

/**
 * Ворота этой стадии оценивают ТОЛЬКО структурную самосогласованность
 * извлечения (evidence резолвится, identity не коллизирует, parent-ссылки не
 * сломаны) — раннеру запрещено читать oracle, поэтому "покрыто ли смысловое
 * содержание правил 1-10" здесь НЕ проверяется и не может проверяться; это
 * задача человеческого oracle-blind ревью (review packet) и, позже, retrieval
 * gate (план §0.4), не этой стадии.
 */
function computeStageResult(
  identity: IdentityAssignmentResult,
  rawUnits: readonly ExtractedKnowledgeUnit[]
): { result: StageResult; reasons: string[] } {
  const reasons: string[] = [];

  if (identity.unresolvedEvidence.length > 0) {
    reasons.push(`${identity.unresolvedEvidence.length} unit(ов) с unresolved evidence`);
  }
  if (identity.ambiguousDuplicates.length > 0) {
    reasons.push(`${identity.ambiguousDuplicates.length} ambiguous duplicate unitId`);
  }
  const danglingParentCount = rawUnits.filter((u) =>
    u.uncertainties.some((unc) => unc.kind === 'DANGLING_PARENT_REF')
  ).length;
  if (danglingParentCount > 0) {
    reasons.push(`${danglingParentCount} unit(ов) с DANGLING_PARENT_REF`);
  }
  const duplicateRefCount = rawUnits.filter((u) =>
    u.uncertainties.some((unc) => unc.kind === 'DUPLICATE_EXTRACTION_REF')
  ).length;
  if (duplicateRefCount > 0) {
    reasons.push(`${duplicateRefCount} unit(ов) с DUPLICATE_EXTRACTION_REF`);
  }

  return { result: reasons.length === 0 ? 'EXTRACTION_READY_FOR_REVIEW' : 'EXTRACTION_GATE_FAIL', reasons };
}

// ────────────────────────────── review packet ────────────────────────────────

/**
 * Oracle-blind review packet — units + их evidence в исходнике, БЕЗ единой
 * оценки. Человек, готовящий committed review manifest (translation-kup),
 * видит ТОЛЬКО этот файл + сам DOCX — вопросы и ключ ему недоступны (план
 * §0.3 №5, [R4b]). Ревьюер заполняет `reviewDecision`/`reviewedBy`/
 * `reviewedAt` вручную; раннер их не проставляет и не может — сессия,
 * писавшая раннер, уже видела oracle при подготовке грейдера.
 */
export interface ReviewPacketCanonicalSource {
  readonly sourceRevisionHash: string;
  readonly canonicalTextHash: string;
  readonly parserVersion: string;
}

/**
 * Абсолютные offsets (в `canonicalText`, не внутри блока) для evidence-цитаты
 * unit'а — та же логика, что `assignIdentity` уже применяет к `unitId`
 * (`resolveEvidenceOffsets` + `block.blockStart`), пересчитана здесь отдельно,
 * т.к. `PersistedKnowledgeUnit` не хранит offsets сам по себе (только
 * `sourceSpan.quote`, из которого их надо резолвить обратно per-unit).
 * `null` только если блок не найден — не должно происходить для units,
 * прошедших `assignIdentity` (их evidence уже резолвилось там), но эта
 * функция не полагается на это молча.
 */
function reviewPacketOffsets(
  unit: PersistedKnowledgeUnit,
  block: SourceBlockLocation | undefined
): { readonly start: number; readonly end: number } | null {
  if (!block) return null;
  const offsets = resolveEvidenceOffsets(block.text, unit.sourceSpan.quote);
  if (!offsets) return null;
  return { start: block.blockStart + offsets.start, end: block.blockStart + offsets.end };
}

/**
 * Oracle-blind review packet — units + их evidence в исходнике, БЕЗ единой
 * оценки. Человек, готовящий committed review manifest (translation-kup),
 * видит ТОЛЬКО этот файл + сам DOCX — вопросы и ключ ему недоступны (план
 * §0.3 №5, [R4b]). Ревьюер заполняет `reviewDecision`/`reviewedBy`/
 * `reviewedAt` вручную; раннер их не проставляет и не может — сессия,
 * писавшая раннер, уже видела oracle при подготовке грейдера.
 *
 * Полнота полей — Step 5, независимое ревью PR #76: `reviewedUnitHash`
 * (`review-manifest.ts`) хэширует ВЕСЬ `PersistedKnowledgeUnit`, поэтому
 * пакет обязан показывать ревьюеру ВСЁ, что попадёт под этот хэш —
 * `evidenceByField` целиком (не только `evidenceQuote` == `sourceSpan.quote`,
 * который покрывает только `statement`), `offsets` (не только `blockText`
 * целиком — координаты цитаты внутри него), и canonical source hashes на
 * верхнем уровне пакета (какая именно ревизия документа ревьюируется, не
 * заставляя ревьюера открывать отдельный `canonical-document.json`).
 */
export function buildReviewPacket(
  persistedUnits: readonly PersistedKnowledgeUnit[],
  blocksByAnchor: ReadonlyMap<string, SourceBlockLocation>,
  canonicalSource: ReviewPacketCanonicalSource
) {
  return {
    status: 'REVIEW_REQUIRED' as const,
    canonicalSource,
    instructions:
      'Ревьюер должен быть oracle-blind: видеть ТОЛЬКО исходный DOCX и это извлечение. ' +
      'Файлы вопросов/ключа ответов НЕ открывать ни до, ни во время этого ревью. ' +
      'Для каждого unit: сверить statement/facets/triggerCondition/numericConstraint с blockText ' +
      'и evidenceQuote/evidenceByField, затем проставить reviewDecision (ACCEPT|REJECT|EDIT), ' +
      'reviewedBy, reviewedAt. ' +
      'EDIT допустим только если исправление полностью выводимо из источника — это не сочинение нового текста.',
    units: persistedUnits.map((unit) => {
      const block = blocksByAnchor.get(unit.sourceSpan.anchor);
      return {
        unitId: unit.unitId,
        sourceBlockAnchor: unit.sourceBlockAnchor,
        contentHash: unit.contentHash,
        kind: unit.kind,
        title: unit.title ?? null,
        statement: unit.statement,
        facets: unit.facets,
        triggerCondition: unit.triggerCondition,
        numericConstraint: unit.numericConstraint,
        parentRuleRef: unit.parentRuleRef,
        sectionPath: block?.sectionPath ?? null,
        structuralPath: block?.structuralPath ?? null,
        evidenceQuote: unit.sourceSpan.quote,
        evidenceByField: unit.evidenceByField,
        offsets: reviewPacketOffsets(unit, block),
        blockText: block?.text ?? null,
        uncertainties: unit.uncertainties,
        reviewDecision: null,
        reviewedBy: null,
        reviewedAt: null,
      };
    }),
  };
}

// ──────────────────────────────────  main  ───────────────────────────────────

function toJsonl(rows: readonly unknown[]): string {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : '');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('=== EXTRACTION-ONLY RUNNER (--stage=extraction) ===');
  console.log(`doc: ${args.docPath}`);
  console.log(`out: ${args.outDir}`);

  const runConfig = resolveExtractionRunConfig();
  console.log(
    `extraction run config: provider=${runConfig.provider} model=${runConfig.model} ` +
      `promptVersion=${runConfig.promptVersion} schema=${runConfig.extractionSchemaVersion} ` +
      `fallbackPolicy=${runConfig.fallbackPolicy}`
  );

  const buffer = readFileSync(args.docPath);
  const canonical: CanonicalDocument = await extractCanonicalDocument(buffer);
  console.log(
    `canonical document: ${canonical.blocks.length} blocks, ${canonical.canonicalText.length} chars, ` +
      `${canonical.warnings.length} canonicalization warning(s)`
  );

  const sourceBlocks: SourceBlock[] = canonical.blocks.map((b) => ({ anchor: b.anchor, text: b.text }));
  const blocksByAnchor = new Map<string, SourceBlockLocation>(
    canonical.blocks.map((b) => [b.anchor, toSourceBlockLocation(b)])
  );

  console.log('\nВызов LLM (extractKnowledgeUnits) — это платный сетевой вызов...');
  // Дефолт chat-provider.ts (defaultAnthropicMaxTokens) — 2048, рассчитан на
  // другие вызовы; v2-схема extractKnowledgeUnits многословнее v1
  // (ExtractedRuleStream): у каждого unit'а появились extractionRef/
  // parentExtractionRef/evidenceByField. Первый реальный прогон на этом
  // документе оборвался (TRUNCATED_JSON) на дефолте — реальная находка этой
  // сессии, не гипотеза. 16000 — то же значение, что v1
  // (knowledge-extractor-stream.ts) уже использует для той же причины.
  const { result: extraction, attemptLog } = await extractKnowledgeUnitsWithRetry(
    { blocks: sourceBlocks, runConfig, maxTokens: 16000 },
    6
  );
  console.log(`extracted ${extraction.units.length} raw unit(ов) after ${attemptLog.length} attempt(s)`);

  const identity = assignIdentity(extraction.units, blocksByAnchor, canonical.sourceRevisionHash);
  console.log(
    `assignIdentity: ${identity.units.length} persisted, ${identity.ambiguousDuplicates.length} ambiguous duplicate group(s), ` +
      `${identity.unresolvedEvidence.length} unresolved evidence`
  );

  const evidenceResolution = extraction.units.map((u) => resolveEvidenceDiagnostics(u, blocksByAnchor));
  const { result: stageResult, reasons: stageResultReasons } = computeStageResult(
    identity,
    extraction.units
  );

  const unitCountByKind: Record<string, number> = {};
  for (const u of identity.units) {
    unitCountByKind[u.kind] = (unitCountByKind[u.kind] ?? 0) + 1;
  }

  const danglingParentRefs = extraction.units
    .filter((u) => u.uncertainties.some((unc) => unc.kind === 'DANGLING_PARENT_REF'))
    .map((u) => ({
      extractionRef: u.extractionRef,
      parentExtractionRef: u.parentExtractionRef,
      uncertainties: u.uncertainties.filter((unc) => unc.kind === 'DANGLING_PARENT_REF'),
    }));

  const duplicateExtractionRefs = extraction.units
    .filter((u) => u.uncertainties.some((unc) => unc.kind === 'DUPLICATE_EXTRACTION_REF'))
    .map((u) => ({
      extractionRef: u.extractionRef,
      uncertainties: u.uncertainties.filter((unc) => unc.kind === 'DUPLICATE_EXTRACTION_REF'),
    }));

  const allUncertainties = extraction.units.flatMap((u) =>
    u.uncertainties.map((unc) => ({ extractionRef: u.extractionRef, ...unc }))
  );

  // ── артефакты ──
  mkdirSync(args.outDir, { recursive: true });

  writeFileSync(
    path.join(args.outDir, 'canonical-document.json'),
    JSON.stringify(
      {
        parserVersion: canonical.parserVersion,
        sourceRevisionHash: canonical.sourceRevisionHash,
        canonicalTextHash: canonical.canonicalTextHash,
        blockCount: canonical.blocks.length,
        canonicalTextLength: canonical.canonicalText.length,
        warnings: canonical.warnings,
      },
      null,
      2
    ),
    'utf8'
  );

  writeFileSync(
    path.join(args.outDir, 'canonical-blocks.jsonl'),
    toJsonl(
      canonical.blocks.map((b) => ({
        anchor: b.anchor,
        kind: b.kind,
        sectionPath: b.sectionPath,
        structuralPath: b.structuralPath,
        blockStart: b.blockStart,
        blockEnd: b.blockEnd,
        text: b.text,
      }))
    ),
    'utf8'
  );

  writeFileSync(
    path.join(args.outDir, 'extracted-units.raw.jsonl'),
    toJsonl(extraction.units),
    'utf8'
  );

  writeFileSync(
    path.join(args.outDir, 'persisted-units.candidate.jsonl'),
    toJsonl(identity.units),
    'utf8'
  );

  writeFileSync(
    path.join(args.outDir, 'evidence-resolution.json'),
    JSON.stringify(evidenceResolution, null, 2),
    'utf8'
  );

  const ranAt = new Date().toISOString();
  writeFileSync(
    path.join(args.outDir, 'extraction-summary.json'),
    JSON.stringify(
      {
        ranAt,
        gitSha: gitSha(),
        docPath: args.docPath,
        stage: args.stage,
        sourceRevisionHash: canonical.sourceRevisionHash,
        canonicalTextHash: canonical.canonicalTextHash,
        parserVersion: canonical.parserVersion,
        runConfig,
        extractionAttempts: attemptLog,
        rawUnitCount: extraction.units.length,
        persistedUnitCount: identity.units.length,
        unitCountByKind,
        unresolvedEvidenceCount: identity.unresolvedEvidence.length,
        unresolvedEvidence: identity.unresolvedEvidence.map((e) => ({
          extractionRef: e.unit.extractionRef,
          sourceSpan: e.unit.sourceSpan,
          reason: e.reason,
        })),
        ambiguousDuplicatesCount: identity.ambiguousDuplicates.length,
        ambiguousDuplicates: identity.ambiguousDuplicates,
        danglingParentRefCount: danglingParentRefs.length,
        danglingParentRefs,
        duplicateExtractionRefCount: duplicateExtractionRefs.length,
        duplicateExtractionRefs,
        uncertaintiesCount: allUncertainties.length,
        uncertainties: allUncertainties,
        stageResult,
        stageResultReasons,
      },
      null,
      2
    ),
    'utf8'
  );

  const reviewPacket = buildReviewPacket(identity.units, blocksByAnchor, {
    sourceRevisionHash: canonical.sourceRevisionHash,
    canonicalTextHash: canonical.canonicalTextHash,
    parserVersion: canonical.parserVersion,
  });
  writeFileSync(
    path.join(args.outDir, 'review-packet.json'),
    JSON.stringify(reviewPacket, null, 2),
    'utf8'
  );

  console.log(`\nСтадия: ${stageResult}`);
  if (stageResultReasons.length > 0) {
    for (const reason of stageResultReasons) console.log(`  - ${reason}`);
  }
  console.log(`\nАртефакты записаны в: ${args.outDir}`);
  console.log('Review packet: REVIEW_REQUIRED — человеческое решение НЕ создано этим прогоном.');

  process.exitCode = stageResult === 'EXTRACTION_GATE_FAIL' ? 1 : 0;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('FATAL ERROR:', err);
    process.exit(1);
  });
}
