import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import prisma from '@/lib/db';
import { detectMimeType, parseDocument } from '@/lib/document-parser';
import {
  getExistingDomainsForStream,
  streamDomainClassification,
  type DomainStewardStreamResult,
} from '@/lib/ai/domain-steward-stream';
import {
  getExistingRuleCodesForStream,
  streamKnowledgeExtraction,
  type KnowledgeExtractionStreamResult,
} from '@/lib/ai/knowledge-extractor-stream';
import { splitTextIntoChunks } from '@/lib/ai/chunker';
import { commitDocumentKnowledge } from '@/lib/document-processing/commit';

if (!process.env.INGEST_KEEP_AI_PROVIDER) {
  process.env.AI_PROVIDER = 'openai';
}

type Counts = Record<string, number>;

type ReviewIssue = {
  severity: 'error' | 'warning' | 'info';
  message: string;
};

type ExtractionQualityReport = {
  rawTextChars: number;
  stagedItems: number;
  verifiedItems: number;
  rejectedItems: number;
  rules: { extracted: number; verified: number; rejected: number };
  qaPairs: { extracted: number; verified: number; rejected: number };
  chunks: { extracted: number; verified: number; rejected: number };
  domainAssignments: { extracted: number; verified: number; rejected: number };
  domainSuggestions: number;
  unsupportedRuleQuotes: number;
  duplicateRulesRejected: number;
  duplicateQaRejected: number;
  weakItemsRejected: number;
  coverageLevel: 'good' | 'thin' | 'needs_review';
  recommendedAction: 'commit' | 'manual_review' | 'rerun_extraction';
  notes: string[];
};

type DocumentReport = {
  file: string;
  documentId: string;
  title: string;
  action: 'created' | 'refreshed' | 'already_completed';
  rawTextChars: number;
  stagedCounts: Counts;
  verifiedCounts: Counts;
  rejectedCounts: Counts;
  qualityReport: ExtractionQualityReport | null;
  reviewIssues: ReviewIssue[];
  commitResult: Awaited<ReturnType<typeof commitDocumentKnowledge>> | null;
  finalStats: Counts;
  sampleRules: string[];
  sampleQuestions: string[];
};

const DEFAULT_FILES = [
  'C:\\Users\\filip\\Downloads\\Telegram Desktop\\Чек_лист_заполнение_Лида,_Сделки,_Бланка.docx',
  'C:\\Users\\filip\\Downloads\\Telegram Desktop\\шпаргалка про апостили.docx',
  'C:\\Users\\filip\\Downloads\\Telegram Desktop\\Шпаргалка.docx',
  'C:\\Users\\filip\\Downloads\\Telegram Desktop\\ИНСТРУКЦИЯ КЛ общее (2).docx',
  'C:\\Users\\filip\\Downloads\\Telegram Desktop\\Список_стран_для_которых_ТРЕБУЕТСЯ_КЛ.docx',
];

function parseArgs() {
  const args = process.argv.slice(2);
  const files: string[] = [];
  let reportPath = 'tmp-upload/document-ingestion-report.json';
  let refreshCompleted = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--file' || arg === '--files') {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a path`);
      files.push(...value.split('|').map((x) => x.trim()).filter(Boolean));
    } else if (arg === '--report') {
      reportPath = args[++i] || reportPath;
    } else if (arg === '--refresh-completed') {
      refreshCompleted = true;
    } else if (!arg.startsWith('--')) {
      files.push(arg);
    }
  }

  return {
    files: files.length ? files : DEFAULT_FILES,
    reportPath,
    refreshCompleted,
  };
}

function countBy<T>(items: T[], getKey: (item: T) => string): Counts {
  return items.reduce<Counts>((acc, item) => {
    const key = getKey(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function hasDuplicateText(value: string, seen: Set<string>) {
  const normalized = value.toLowerCase().replace(/\s+/g, ' ').slice(0, 240);
  if (!normalized) return false;
  if (seen.has(normalized)) return true;
  seen.add(normalized);
  return false;
}

function normalizeForEvidence(value: string) {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"“”]/g, '')
    .replace(/[.,;:!?()[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasSourceEvidence(rawText: string, quote: string) {
  const normalizedQuote = normalizeForEvidence(quote);
  if (normalizedQuote.length < 20) return true;
  const normalizedSource = normalizeForEvidence(rawText);
  if (normalizedSource.includes(normalizedQuote)) return true;

  const quoteParts = normalizedQuote
    .split(/\.\.\.|…/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 12);

  if (quoteParts.length > 0) {
    return quoteParts.every((part) => normalizedSource.includes(part));
  }

  return false;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientDbError(error: unknown) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /server has closed the connection|can't reach database server|connection terminated|connection refused|connection reset|socket|timeout|timed out|ECONNRESET|ETIMEDOUT|P1001|P1017|UND_ERR_SOCKET/i.test(
    message
  );
}

async function withDbRetry<T>(label: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientDbError(error)) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[retry] ${label} failed (${attempt}/${attempts}), reconnecting: ${message}`);
      await prisma.$disconnect().catch(() => undefined);
      await sleep(1000 * attempt * attempt);
    }
  }

  throw lastError;
}

async function resetDocumentKnowledge(documentId: string) {
  const qaPairs = await prisma.qAPair.findMany({
    where: { documentId },
    select: { id: true },
  });
  await prisma.knowledgeChange.deleteMany({
    where: { targetType: 'QA_PAIR', targetId: { in: qaPairs.map((qa) => qa.id) } },
  });
  await prisma.qAPair.deleteMany({ where: { documentId } });

  const rules = await prisma.rule.findMany({
    where: { documentId },
    select: { id: true },
  });
  await prisma.knowledgeChange.deleteMany({
    where: { targetType: 'RULE', targetId: { in: rules.map((rule) => rule.id) } },
  });
  await prisma.rule.deleteMany({ where: { documentId } });

  await prisma.docChunk.deleteMany({ where: { documentId } });
  await prisma.documentDomain.deleteMany({ where: { documentId } });
  await prisma.domainSuggestion.deleteMany({ where: { createdFromDocumentId: documentId } });
  await prisma.stagedExtraction.deleteMany({ where: { documentId } });
}

async function createOrRefreshDocument(filePath: string, refreshCompleted: boolean) {
  const filename = path.basename(filePath);
  const title = filename.replace(/\.[^.]+$/, '');
  const mimeType = detectMimeType(filename);
  const buffer = await fs.readFile(filePath);
  const rawText = await parseDocument(buffer, mimeType, filename);
  const existing = await prisma.document.findFirst({ where: { filename } });

  if (existing?.parseStatus === 'COMPLETED' && !refreshCompleted) {
    return { document: existing, rawText: existing.rawText || rawText, action: 'already_completed' as const };
  }

  if (existing) {
    await resetDocumentKnowledge(existing.id);
    const document = await prisma.document.update({
      where: { id: existing.id },
      data: {
        title,
        mimeType,
        rawText,
        rawBytes: buffer,
        parseStatus: 'PENDING',
        parseError: null,
      },
    });
    return { document, rawText, action: 'refreshed' as const };
  }

  const document = await prisma.document.create({
    data: {
      title,
      filename,
      mimeType,
      rawText,
      rawBytes: buffer,
      parseStatus: 'PENDING',
    },
  });
  return { document, rawText, action: 'created' as const };
}

async function processDocument(documentId: string, rawText: string, title: string) {
  await prisma.document.update({ where: { id: documentId }, data: { parseStatus: 'PROCESSING' } });

  const existingDomains = await getExistingDomainsForStream();
  let domainResult: DomainStewardStreamResult | null = null;
  for await (const event of streamDomainClassification(rawText, existingDomains)) {
    if (event.type === 'result') domainResult = event.data as DomainStewardStreamResult;
  }
  if (!domainResult) throw new Error(`Domain classification returned no result for ${title}`);

  for (const domain of domainResult.documentDomains) {
    await prisma.stagedExtraction.create({
      data: {
        documentId,
        phase: 'DOMAIN_CLASSIFICATION',
        itemType: 'DOMAIN_ASSIGNMENT',
        data: domain as object,
      },
    });
  }
  for (const suggestion of domainResult.newDomainSuggestions) {
    await prisma.stagedExtraction.create({
      data: {
        documentId,
        phase: 'DOMAIN_CLASSIFICATION',
        itemType: 'DOMAIN_SUGGESTION',
        data: suggestion as object,
      },
    });
  }

  const existingRuleCodes = await getExistingRuleCodesForStream();
  let knowledgeResult: KnowledgeExtractionStreamResult | null = null;
  for await (const event of streamKnowledgeExtraction(rawText, existingRuleCodes)) {
    if (event.type === 'result') knowledgeResult = event.data as KnowledgeExtractionStreamResult;
  }
  if (!knowledgeResult) throw new Error(`Knowledge extraction returned no result for ${title}`);

  for (const rule of knowledgeResult.rules) {
    await prisma.stagedExtraction.create({
      data: {
        documentId,
        phase: 'KNOWLEDGE_EXTRACTION',
        itemType: 'RULE',
        data: rule as object,
      },
    });
  }
  for (const qa of knowledgeResult.qaPairs) {
    await prisma.stagedExtraction.create({
      data: {
        documentId,
        phase: 'KNOWLEDGE_EXTRACTION',
        itemType: 'QA_PAIR',
        data: qa as object,
      },
    });
  }
  for (const uncertainty of knowledgeResult.uncertainties) {
    await prisma.stagedExtraction.create({
      data: {
        documentId,
        phase: 'KNOWLEDGE_EXTRACTION',
        itemType: 'UNCERTAINTY',
        data: uncertainty as object,
      },
    });
  }

  const chunks = splitTextIntoChunks(rawText);
  for (const chunk of chunks) {
    await prisma.stagedExtraction.create({
      data: {
        documentId,
        phase: 'CHUNKING',
        itemType: 'CHUNK',
        data: {
          index: chunk.index,
          content: chunk.content,
          metadata: chunk.metadata,
        },
      },
    });
  }

  await prisma.document.update({ where: { id: documentId }, data: { parseStatus: 'EXTRACTED' } });
}

function countIssues(issues: ReviewIssue[], pattern: RegExp) {
  return issues.filter((issue) => pattern.test(issue.message)).length;
}

function getCount(counts: Counts, key: string) {
  return counts[key] || 0;
}

function buildExtractionQualityReport(
  rawText: string,
  staged: Awaited<ReturnType<typeof prisma.stagedExtraction.findMany>>,
  verifyIds: string[],
  rejectIds: string[],
  issues: ReviewIssue[]
): ExtractionQualityReport {
  const stagedCounts = countBy(staged, (item) => item.itemType);
  const verifiedSet = new Set(verifyIds);
  const rejectedSet = new Set(rejectIds);
  const verifiedCounts = countBy(
    staged.filter((item) => verifiedSet.has(item.id)),
    (item) => item.itemType
  );
  const rejectedCounts = countBy(
    staged.filter((item) => rejectedSet.has(item.id)),
    (item) => item.itemType
  );
  const errorCount = issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
  const notes: string[] = [];

  if (rawText.trim().length < 100) notes.push('Parsed text is too short to trust extraction.');
  if (!getCount(stagedCounts, 'DOMAIN_ASSIGNMENT')) notes.push('No domain assignment was extracted.');
  if (!getCount(stagedCounts, 'RULE') && !getCount(stagedCounts, 'QA_PAIR')) {
    notes.push('No direct rules or QA pairs were extracted.');
  }
  if (!getCount(stagedCounts, 'CHUNK')) notes.push('No retrieval chunks were created.');
  if (warningCount > 0) notes.push(`${warningCount} warning(s) require review before bulk trust.`);

  let coverageLevel: ExtractionQualityReport['coverageLevel'] = 'good';
  let recommendedAction: ExtractionQualityReport['recommendedAction'] = 'commit';
  if (errorCount > 0 || !getCount(verifiedCounts, 'CHUNK')) {
    coverageLevel = 'needs_review';
    recommendedAction = 'rerun_extraction';
  } else if (!getCount(verifiedCounts, 'RULE') || warningCount >= 5) {
    coverageLevel = 'thin';
    recommendedAction = 'manual_review';
  }

  return {
    rawTextChars: rawText.length,
    stagedItems: staged.length,
    verifiedItems: verifyIds.length,
    rejectedItems: rejectIds.length,
    rules: {
      extracted: getCount(stagedCounts, 'RULE'),
      verified: getCount(verifiedCounts, 'RULE'),
      rejected: getCount(rejectedCounts, 'RULE'),
    },
    qaPairs: {
      extracted: getCount(stagedCounts, 'QA_PAIR'),
      verified: getCount(verifiedCounts, 'QA_PAIR'),
      rejected: getCount(rejectedCounts, 'QA_PAIR'),
    },
    chunks: {
      extracted: getCount(stagedCounts, 'CHUNK'),
      verified: getCount(verifiedCounts, 'CHUNK'),
      rejected: getCount(rejectedCounts, 'CHUNK'),
    },
    domainAssignments: {
      extracted: getCount(stagedCounts, 'DOMAIN_ASSIGNMENT'),
      verified: getCount(verifiedCounts, 'DOMAIN_ASSIGNMENT'),
      rejected: getCount(rejectedCounts, 'DOMAIN_ASSIGNMENT'),
    },
    domainSuggestions: getCount(stagedCounts, 'DOMAIN_SUGGESTION'),
    unsupportedRuleQuotes: countIssues(issues, /unsupported quote/i),
    duplicateRulesRejected: countIssues(issues, /duplicate rule/i),
    duplicateQaRejected: countIssues(issues, /duplicate QA pair/i),
    weakItemsRejected: countIssues(issues, /Rejected weak/i),
    coverageLevel,
    recommendedAction,
    notes,
  };
}

async function reviewAndVerify(documentId: string, rawText: string) {
  const staged = await prisma.stagedExtraction.findMany({
    where: { documentId },
    orderBy: { createdAt: 'asc' },
  });
  const issues: ReviewIssue[] = [];
  const verifyIds: string[] = [];
  const rejectIds: string[] = [];
  const seenRules = new Set<string>();
  const seenQa = new Set<string>();

  if (rawText.trim().length < 100) {
    issues.push({ severity: 'error', message: 'Parsed text is unexpectedly short.' });
  }

  const counts = countBy(staged, (item) => item.itemType);
  if (!counts.DOMAIN_ASSIGNMENT) {
    issues.push({ severity: 'error', message: 'No domain assignment was extracted.' });
  }
  if (!counts.RULE && !counts.QA_PAIR) {
    issues.push({ severity: 'error', message: 'No rules or QA pairs were extracted.' });
  }
  if (!counts.CHUNK) {
    issues.push({ severity: 'error', message: 'No search chunks were created.' });
  }

  for (const item of staged) {
    const data = item.data as Record<string, unknown>;
    let valid = true;

    if (item.itemType === 'DOMAIN_ASSIGNMENT') {
      if (!normalizeText(data.primaryDomainSlug) || typeof data.confidence !== 'number') valid = false;
      if (typeof data.confidence === 'number' && data.confidence < 0.55) {
        issues.push({ severity: 'warning', message: `Low domain confidence: ${data.primaryDomainSlug}` });
      }
    } else if (item.itemType === 'DOMAIN_SUGGESTION') {
      valid = false;
      issues.push({
        severity: 'info',
        message: `Domain suggestion left for manual review: ${normalizeText(data.suggestedSlug)}`,
      });
    } else if (item.itemType === 'RULE') {
      const title = normalizeText(data.title);
      const body = normalizeText(data.body);
      const quote = normalizeText((data.sourceSpan as Record<string, unknown> | undefined)?.quote);
      if (!normalizeText(data.ruleCode) || title.length < 8 || body.length < 20 || quote.length < 5) {
        valid = false;
        issues.push({ severity: 'warning', message: `Rejected weak rule: ${normalizeText(data.ruleCode) || title}` });
      }
      if (quote && !hasSourceEvidence(rawText, quote)) {
        valid = false;
        issues.push({ severity: 'warning', message: `Rejected rule with unsupported quote: ${normalizeText(data.ruleCode) || title}` });
      }
      if (hasDuplicateText(`${title}\n${body}`, seenRules)) {
        valid = false;
        issues.push({ severity: 'warning', message: `Rejected duplicate rule: ${title}` });
      }
    } else if (item.itemType === 'QA_PAIR') {
      const question = normalizeText(data.question);
      const answer = normalizeText(data.answer);
      if (question.length < 8 || answer.length < 20) {
        valid = false;
        issues.push({ severity: 'warning', message: `Rejected weak QA pair: ${question}` });
      }
      if (hasDuplicateText(`${question}\n${answer}`, seenQa)) {
        valid = false;
        issues.push({ severity: 'warning', message: `Rejected duplicate QA pair: ${question}` });
      }
    } else if (item.itemType === 'UNCERTAINTY') {
      valid = false;
      issues.push({
        severity: 'info',
        message: `Uncertainty left uncommitted: ${normalizeText(data.suggestedQuestion)}`,
      });
    } else if (item.itemType === 'CHUNK') {
      if (normalizeText(data.content).length < 50) valid = false;
    }

    if (valid) verifyIds.push(item.id);
    else rejectIds.push(item.id);
  }

  if (verifyIds.length) {
    await prisma.stagedExtraction.updateMany({
      where: { id: { in: verifyIds } },
      data: { isVerified: true, isRejected: false, verifiedAt: new Date() },
    });
  }
  if (rejectIds.length) {
    await prisma.stagedExtraction.updateMany({
      where: { id: { in: rejectIds } },
      data: { isVerified: false, isRejected: true },
    });
  }

  const qualityReport = buildExtractionQualityReport(rawText, staged, verifyIds, rejectIds, issues);

  return {
    issues,
    stagedCounts: counts,
    verifiedCounts: countBy(
      staged.filter((item) => verifyIds.includes(item.id)),
      (item) => item.itemType
    ),
    rejectedCounts: countBy(
      staged.filter((item) => rejectIds.includes(item.id)),
      (item) => item.itemType
    ),
    qualityReport,
  };
}

async function finalStats(documentId: string): Promise<Counts> {
  const [rules, qaPairs, chunks, domains, stagedLeft] = await Promise.all([
    prisma.rule.count({ where: { documentId } }),
    prisma.qAPair.count({ where: { documentId } }),
    prisma.docChunk.count({ where: { documentId } }),
    prisma.documentDomain.count({ where: { documentId } }),
    prisma.stagedExtraction.count({ where: { documentId } }),
  ]);

  return { rules, qaPairs, chunks, domains, stagedLeft };
}

async function sampleKnowledge(documentId: string) {
  const [rules, qaPairs] = await Promise.all([
    prisma.rule.findMany({
      where: { documentId },
      select: { ruleCode: true, title: true },
      orderBy: { createdAt: 'asc' },
      take: 5,
    }),
    prisma.qAPair.findMany({
      where: { documentId },
      select: { question: true },
      orderBy: { createdAt: 'asc' },
      take: 5,
    }),
  ]);

  return {
    sampleRules: rules.map((rule) => `${rule.ruleCode}: ${rule.title}`),
    sampleQuestions: qaPairs.map((qa) => qa.question),
  };
}

async function copyToDocumentCatalog(filePath: string) {
  const targetDir = path.resolve('documents');
  await fs.mkdir(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, path.basename(filePath));
  await fs.copyFile(filePath, targetPath);
  return targetPath;
}

async function ingestFile(filePath: string, refreshCompleted: boolean): Promise<DocumentReport> {
  const resolved = path.resolve(filePath);
  console.log(`\n[ingest] ${resolved}`);
  await copyToDocumentCatalog(resolved);
  const { document, rawText, action } = await createOrRefreshDocument(resolved, refreshCompleted);

  let commitResult: DocumentReport['commitResult'] = null;
  let review = {
    issues: [] as ReviewIssue[],
    stagedCounts: {} as Counts,
    verifiedCounts: {} as Counts,
    rejectedCounts: {} as Counts,
    qualityReport: null as ExtractionQualityReport | null,
  };

  if (action !== 'already_completed') {
    await processDocument(document.id, rawText, document.title);
    review = await reviewAndVerify(document.id, rawText);
    const hasFatalIssue = review.issues.some((issue) => issue.severity === 'error');
    if (hasFatalIssue) {
      await prisma.document.update({
        where: { id: document.id },
        data: { parseStatus: 'FAILED', parseError: 'Automated ingestion quality review failed.' },
      });
      throw new Error(`Quality review failed for ${document.title}`);
    }
    // Railway-run scripts can keep a DB connection idle during long LLM calls.
    // Reconnect before the write-heavy commit stage to avoid stale sockets.
    await prisma.$disconnect();
    commitResult = await withDbRetry('commitDocumentKnowledge', () =>
      commitDocumentKnowledge(document.id, { replaceExisting: true })
    );
  }

  const stats = await withDbRetry('finalStats', () => finalStats(document.id));
  const samples = await withDbRetry('sampleKnowledge', () => sampleKnowledge(document.id));

  return {
    file: resolved,
    documentId: document.id,
    title: document.title,
    action,
    rawTextChars: rawText.length,
    stagedCounts: review.stagedCounts,
    verifiedCounts: review.verifiedCounts,
    rejectedCounts: review.rejectedCounts,
    qualityReport: review.qualityReport,
    reviewIssues: review.issues,
    commitResult,
    finalStats: stats,
    ...samples,
  };
}

async function main() {
  const { files, reportPath, refreshCompleted } = parseArgs();
  const reports: DocumentReport[] = [];

  for (const file of files) {
    reports.push(await ingestFile(file, refreshCompleted));
  }

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2), 'utf8');

  for (const report of reports) {
    const quality = report.qualityReport
      ? `quality=${report.qualityReport.coverageLevel}/${report.qualityReport.recommendedAction}`
      : 'quality=existing';
    console.log(`[report] ${report.title}: ${JSON.stringify(report.finalStats)} (${report.action}, ${quality})`);
  }
  console.log(`[report] ${pathToFileURL(path.resolve(reportPath)).href}`);
}

main()
  .catch((error) => {
    console.error('[fatal]', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
