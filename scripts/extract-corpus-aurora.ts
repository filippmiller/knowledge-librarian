/**
 * Переизвлечение корпуса новым движком в БД (Aurora v2).
 *
 * Для каждого DOCX-документа из Prisma: канонические блоки ->
 * bounded-batch извлечение с аудитом полноты и focused-repair'ами ->
 * assignIdentity -> saveExtractionRun (таблицы KnowledgeExtractionRun /
 * KnowledgeUnitRecord). СТАРЫЙ контур (Rule/QAPair/DocChunk) не трогается
 * вообще: юниты ложатся рядом, humanReviewed=false — в ответы они не
 * попадают, пока оператор не проведёт ревью (Gate 1).
 *
 * Запуск (нужны DATABASE_URL + ключ провайдера — на сервере или через
 * `railway run`):
 *   npx tsx scripts/extract-corpus-aurora.ts --all
 *   npx tsx scripts/extract-corpus-aurora.ts --doc-id=<id>
 *   npx tsx scripts/extract-corpus-aurora.ts --all --dry-run   # без записи в БД
 * Опции: --batch-size=4 --max-docs=N --model=<model> --provider=anthropic
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import prisma from '@/lib/db';
import {
  extractCanonicalDocument,
  toSourceBlockLocation,
} from '@/lib/knowledge/docx-canonical-blocks';
import type { SourceBlockLocation } from '@/lib/knowledge/applicability/identity-assignment';
import {
  extractKnowledgeUnits,
  type ExtractKnowledgeUnitsOptions,
  type ExtractKnowledgeUnitsResult,
} from '@/lib/knowledge/knowledge-unit-extractor';
import { extractKnowledgeUnitsWithCompletenessAudit } from '@/lib/knowledge/audited-extraction';
import { assignIdentity } from '@/lib/knowledge/applicability/identity-assignment';
import { resolveExtractionRunConfig } from '@/lib/ai/extraction-run';
import { saveExtractionRun } from '@/lib/knowledge/knowledge-unit-db-store';

interface CliArgs {
  all: boolean;
  docId: string | null;
  batchSize: number;
  maxDocs: number | null;
  dryRun: boolean;
  provider: string | null;
  model: string | null;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const get = (name: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  return {
    all: argv.includes('--all'),
    docId: get('doc-id'),
    batchSize: Number(get('batch-size') ?? '4'),
    maxDocs: get('max-docs') ? Number(get('max-docs')) : null,
    dryRun: argv.includes('--dry-run'),
    provider: get('provider'),
    model: get('model'),
  };
}

/** Транспортные/схемные сбои LLM не валят весь корпус: до 4 попыток на batch
 *  с экспоненциальной паузой — та же дисциплина, что в eval-раннере, без его
 *  oracle-taint-машинерии (она нужна только бенчмарку). */
function withRetry(
  inner: (options: ExtractKnowledgeUnitsOptions) => Promise<ExtractKnowledgeUnitsResult>
): (options: ExtractKnowledgeUnitsOptions) => Promise<ExtractKnowledgeUnitsResult> {
  return async (options) => {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        return await inner(options);
      } catch (error) {
        lastError = error;
        const waitMs = 2000 * 2 ** (attempt - 1);
        console.warn(
          `  попытка ${attempt}/4 не удалась (${error instanceof Error ? error.message : error}), пауза ${waitMs}мс`
        );
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    throw lastError;
  };
}

interface DocOutcome {
  documentId: string;
  title: string;
  status: 'SAVED' | 'DRY_RUN' | 'FAILED' | 'SKIPPED';
  unitCount?: number;
  facetFillRate?: string;
  ambiguousDuplicates?: number;
  extractionRunId?: string;
  error?: string;
}

async function processDocument(
  doc: { id: string; title: string; rawBytes: Uint8Array | null },
  args: CliArgs
): Promise<DocOutcome> {
  if (doc.rawBytes === null || doc.rawBytes.length === 0) {
    return { documentId: doc.id, title: doc.title, status: 'SKIPPED', error: 'нет rawBytes' };
  }

  const canonical = await extractCanonicalDocument(Buffer.from(doc.rawBytes));
  console.log(`  канонических блоков: ${canonical.blocks.length}${canonical.warnings.length ? `, предупреждений парсера: ${canonical.warnings.length}` : ''}`);

  const runConfig = resolveExtractionRunConfig({
    ...(args.provider ? { provider: args.provider as 'anthropic' | 'openai' } : {}),
    ...(args.model ? { model: args.model } : {}),
  });
  console.log(`  извлечение: ${runConfig.provider}/${runConfig.model}, batchSize=${args.batchSize}`);

  const blocks = canonical.blocks.map((b) => ({ anchor: b.anchor, text: b.text, kind: b.kind }));
  const audited = await extractKnowledgeUnitsWithCompletenessAudit(
    blocks,
    args.batchSize,
    { runConfig },
    runConfig,
    { extractor: withRetry(extractKnowledgeUnits) }
  );

  const blocksByAnchor = new Map<string, SourceBlockLocation>(
    canonical.blocks.map((b) => [b.anchor, toSourceBlockLocation(b)])
  );
  const identity = assignIdentity(audited.units, blocksByAnchor, canonical.sourceRevisionHash);
  if (identity.units.length === 0) {
    return {
      documentId: doc.id,
      title: doc.title,
      status: 'FAILED',
      error: 'извлечение не дало ни одного юнита',
    };
  }

  // На уровне извлечения фасета «известна», если ключ вообще проставлен
  // (ExtractedFacetMap — прямые значения, без обёртки KNOWN/UNKNOWN).
  const unitsWithKnownFacets = identity.units.filter(
    (u) => Object.values(u.facets).filter((v) => v !== undefined).length > 0
  ).length;
  const facetFillRate = `${unitsWithKnownFacets}/${identity.units.length}`;

  const extractionRunId = `corpus-${doc.id}-${randomUUID().slice(0, 8)}`;
  if (args.dryRun) {
    return {
      documentId: doc.id,
      title: doc.title,
      status: 'DRY_RUN',
      unitCount: identity.units.length,
      facetFillRate,
      ambiguousDuplicates: identity.ambiguousDuplicates.length,
    };
  }

  await saveExtractionRun({
    metadata: {
      sourceRevisionHash: canonical.sourceRevisionHash,
      canonicalTextHash: canonical.canonicalTextHash,
      parserVersion: canonical.parserVersion,
      extractionRunId,
      extractionProvider: runConfig.provider,
      extractionModel: runConfig.model,
      extractionPromptVersion: runConfig.promptVersion,
      extractionSchemaVersion: runConfig.extractionSchemaVersion,
    },
    units: identity.units,
    documentId: doc.id,
    humanReviewed: false,
  });

  return {
    documentId: doc.id,
    title: doc.title,
    status: 'SAVED',
    unitCount: identity.units.length,
    facetFillRate,
    ambiguousDuplicates: identity.ambiguousDuplicates.length,
    extractionRunId,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.all && !args.docId) {
    console.error('Укажите --all или --doc-id=<id>. Добавьте --dry-run для прогона без записи.');
    process.exit(1);
  }

  const docs = await prisma.document.findMany({
    where: {
      ...(args.docId ? { id: args.docId } : {}),
      mimeType: {
        in: [
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ],
      },
    },
    select: { id: true, title: true, rawBytes: true },
    orderBy: { uploadedAt: 'asc' },
    ...(args.maxDocs ? { take: args.maxDocs } : {}),
  });
  console.log(`Документов к переизвлечению: ${docs.length}${args.dryRun ? ' (dry-run, без записи)' : ''}`);

  const outcomes: DocOutcome[] = [];
  for (const [index, doc] of docs.entries()) {
    console.log(`\n[${index + 1}/${docs.length}] ${doc.title} (${doc.id})`);
    try {
      const outcome = await processDocument(doc, args);
      outcomes.push(outcome);
      if (outcome.status === 'SAVED' || outcome.status === 'DRY_RUN') {
        console.log(
          `  ${outcome.status}: юнитов ${outcome.unitCount}, KNOWN-фасеты у ${outcome.facetFillRate}, спорных дублей ${outcome.ambiguousDuplicates}`
        );
      } else {
        console.log(`  ${outcome.status}: ${outcome.error}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({ documentId: doc.id, title: doc.title, status: 'FAILED', error: message });
      console.error(`  FAILED: ${message}`);
    }
  }

  const saved = outcomes.filter((o) => o.status === 'SAVED' || o.status === 'DRY_RUN');
  const failed = outcomes.filter((o) => o.status === 'FAILED');
  const skipped = outcomes.filter((o) => o.status === 'SKIPPED');
  console.log('\n================ ИТОГ ================');
  console.log(`успешно: ${saved.length}, ошибок: ${failed.length}, пропущено: ${skipped.length}`);
  for (const o of failed) console.log(`  FAILED ${o.title}: ${o.error}`);
  for (const o of skipped) console.log(`  SKIPPED ${o.title}: ${o.error}`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error('Фатальная ошибка:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
