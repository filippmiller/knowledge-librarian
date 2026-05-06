import prisma from '@/lib/db';
import { answerQuestionEnhanced } from '@/lib/ai/enhanced-answering-engine';

export interface RetrievalEvalCase {
  question: string;
  expectedKeywords?: string[];
  expectedDocumentId?: string;
}

export interface QualityIssue {
  severity: 'critical' | 'warning' | 'info';
  type: string;
  targetType?: 'document' | 'rule' | 'qa' | 'chunk';
  targetId?: string;
  ruleCode?: string;
  message: string;
  evidence?: unknown;
}

export interface DocumentQualityReport {
  documentId: string;
  title: string;
  parseStatus: string;
  scenarioKey: string | null;
  counts: {
    rawTextLength: number;
    rawTextLines: number;
    activeRules: number;
    activeQaPairs: number;
    chunks: number;
    stagedItems: number;
    rulesPer1000Chars: number;
    qaPerRule: number;
  };
  coverage: {
    rulesWithQuotes: number;
    rulesWithFoundQuotes: number;
    rulesWithLocationHint: number;
    qaLinkedToRule: number;
    chunksWithEmbeddings: number;
  };
  severityCounts: {
    critical: number;
    warning: number;
    info: number;
  };
  scores: {
    parseScore: number;
    groundingScore: number;
    structureScore: number;
    overallScore: number;
  };
  verdict: 'pass' | 'warning' | 'fail';
  issues: QualityIssue[];
}

export interface RetrievalEvalResult {
  question: string;
  expectedKeywords: string[];
  expectedDocumentId: string;
  passedKeywords: boolean;
  sourceMarkerHit: boolean;
  scenarioKey: string | null;
  confidenceLevel: string;
  sourceMarkers: Array<{
    token: string;
    documentId?: string;
    documentTitle?: string;
  }>;
  answer: string;
}

export async function buildDocumentQualityReport(documentId: string): Promise<DocumentQualityReport> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      rules: {
        where: { status: 'ACTIVE' },
        include: { qaPairs: true },
        orderBy: { createdAt: 'asc' },
      },
      qaPairs: {
        where: { status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
      },
      chunks: {
        orderBy: { chunkIndex: 'asc' },
      },
      stagedExtractions: {
        select: { id: true, itemType: true, isRejected: true, isVerified: true },
      },
    },
  });

  if (!document) {
    throw new Error('Document not found');
  }

  const issues: QualityIssue[] = [];
  const rawText = document.rawText ?? '';
  const normalizedRaw = normalizeForSearch(rawText);
  const rules = document.rules;
  const qaPairs = document.qaPairs;
  const chunks = document.chunks;

  if (rawText.trim().length < 50) {
    issues.push({
      severity: 'critical',
      type: 'parse_empty',
      targetType: 'document',
      targetId: document.id,
      message: 'Parsed text is empty or too short.',
    });
  }

  if (document.parseStatus !== 'COMPLETED') {
    issues.push({
      severity: 'warning',
      type: 'document_not_completed',
      targetType: 'document',
      targetId: document.id,
      message: `Document parseStatus is ${document.parseStatus}, not COMPLETED.`,
    });
  }

  if (rules.length === 0) {
    issues.push({
      severity: 'critical',
      type: 'no_active_rules',
      targetType: 'document',
      targetId: document.id,
      message: 'No active rules are linked to this document.',
    });
  }

  if (chunks.length === 0) {
    issues.push({
      severity: 'critical',
      type: 'no_chunks',
      targetType: 'document',
      targetId: document.id,
      message: 'No retrieval chunks are linked to this document.',
    });
  }

  const ruleSignatures = new Map<string, string>();
  let rulesWithQuotes = 0;
  let rulesWithFoundQuotes = 0;
  let rulesWithLocationHint = 0;

  for (const rule of rules) {
    const sourceSpan = readSourceSpan(rule.sourceSpan);
    const quote = sourceSpan.quote;
    const locationHint = sourceSpan.locationHint;

    if (quote) {
      rulesWithQuotes += 1;
      const normalizedQuote = normalizeForSearch(quote).slice(0, 120);
      if (normalizedQuote && normalizedRaw.includes(normalizedQuote)) {
        rulesWithFoundQuotes += 1;
      } else {
        issues.push({
          severity: 'warning',
          type: 'source_quote_not_found',
          targetType: 'rule',
          targetId: rule.id,
          ruleCode: rule.ruleCode,
          message: 'Rule source quote was not found in document rawText.',
          evidence: { quote },
        });
      }
    } else {
      issues.push({
        severity: 'warning',
        type: 'missing_source_quote',
        targetType: 'rule',
        targetId: rule.id,
        ruleCode: rule.ruleCode,
        message: 'Rule has no source quote.',
      });
    }

    if (locationHint) {
      rulesWithLocationHint += 1;
    } else {
      issues.push({
        severity: 'warning',
        type: 'missing_location_hint',
        targetType: 'rule',
        targetId: rule.id,
        ruleCode: rule.ruleCode,
        message: 'Rule has no source location hint.',
      });
    }

    if (rule.body.trim().length < 35) {
      issues.push({
        severity: 'warning',
        type: 'short_rule_body',
        targetType: 'rule',
        targetId: rule.id,
        ruleCode: rule.ruleCode,
        message: 'Rule body is very short.',
      });
    }

    if (rule.body.length > 1400) {
      issues.push({
        severity: 'warning',
        type: 'long_rule_body',
        targetType: 'rule',
        targetId: rule.id,
        ruleCode: rule.ruleCode,
        message: 'Rule body is long and may contain multiple facts.',
      });
    }

    const signature = normalizeForSearch(`${rule.title} ${rule.body} ${quote ?? ''}`).slice(0, 260);
    const duplicateOf = ruleSignatures.get(signature);
    if (signature && duplicateOf) {
      issues.push({
        severity: 'warning',
        type: 'duplicate_rule',
        targetType: 'rule',
        targetId: rule.id,
        ruleCode: rule.ruleCode,
        message: 'Rule looks like a duplicate of another active rule.',
        evidence: { duplicateOf },
      });
    } else if (signature) {
      ruleSignatures.set(signature, rule.ruleCode);
    }
  }

  const activeRuleIds = new Set(rules.map((rule) => rule.id));
  let qaLinkedToRule = 0;
  for (const qa of qaPairs) {
    if (qa.ruleId && activeRuleIds.has(qa.ruleId)) {
      qaLinkedToRule += 1;
    } else {
      issues.push({
        severity: 'warning',
        type: 'qa_without_active_rule_link',
        targetType: 'qa',
        targetId: qa.id,
        message: 'Q&A pair is not linked to an active rule from this document.',
      });
    }

    if (qa.question.trim().length < 8 || qa.answer.trim().length < 15) {
      issues.push({
        severity: 'warning',
        type: 'weak_qa_text',
        targetType: 'qa',
        targetId: qa.id,
        message: 'Q&A text is very short.',
      });
    }
  }

  let chunksWithEmbeddings = 0;
  for (const chunk of chunks) {
    if (chunk.embedding) chunksWithEmbeddings += 1;
    else {
      issues.push({
        severity: 'warning',
        type: 'chunk_missing_embedding',
        targetType: 'chunk',
        targetId: chunk.id,
        message: 'Chunk has no embedding.',
        evidence: { chunkIndex: chunk.chunkIndex },
      });
    }

    if (chunk.content.trim().length < 40 || chunk.content.length > 1150) {
      issues.push({
        severity: 'warning',
        type: 'chunk_size_outlier',
        targetType: 'chunk',
        targetId: chunk.id,
        message: 'Chunk length is outside expected bounds.',
        evidence: { chunkIndex: chunk.chunkIndex, length: chunk.content.length },
      });
    }
  }

  const rawTextLength = rawText.length;
  const rawTextLines = rawText.split(/\r?\n/).filter((line) => line.trim()).length;
  const counts = {
    rawTextLength,
    rawTextLines,
    activeRules: rules.length,
    activeQaPairs: qaPairs.length,
    chunks: chunks.length,
    stagedItems: document.stagedExtractions.filter((item) => !item.isRejected).length,
    rulesPer1000Chars: round(rules.length / Math.max(1, rawTextLength / 1000)),
    qaPerRule: round(qaPairs.length / Math.max(1, rules.length)),
  };

  const coverage = {
    rulesWithQuotes,
    rulesWithFoundQuotes,
    rulesWithLocationHint,
    qaLinkedToRule,
    chunksWithEmbeddings,
  };

  const severityCounts = {
    critical: issues.filter((issue) => issue.severity === 'critical').length,
    warning: issues.filter((issue) => issue.severity === 'warning').length,
    info: issues.filter((issue) => issue.severity === 'info').length,
  };

  const parseScore = rawTextLength >= 50 && chunks.length > 0 ? 1 : 0;
  const groundingScore = rules.length > 0 ? rulesWithFoundQuotes / rules.length : 0;
  const structureScore = average([
    rules.length > 0 ? 1 : 0,
    chunks.length > 0 ? chunksWithEmbeddings / chunks.length : 0,
    qaPairs.length > 0 ? qaLinkedToRule / qaPairs.length : 1,
  ]);
  const overallScore = average([parseScore, groundingScore, structureScore]);

  return {
    documentId: document.id,
    title: document.title,
    parseStatus: document.parseStatus,
    scenarioKey: document.scenarioKey,
    counts,
    coverage,
    severityCounts,
    scores: {
      parseScore: round(parseScore),
      groundingScore: round(groundingScore),
      structureScore: round(structureScore),
      overallScore: round(overallScore),
    },
    verdict: severityCounts.critical > 0 ? 'fail' : severityCounts.warning > 0 ? 'warning' : 'pass',
    issues,
  };
}

export async function runDocumentRetrievalEval(
  documentId: string,
  cases: RetrievalEvalCase[]
): Promise<RetrievalEvalResult[]> {
  return Promise.all(cases.map(async (testCase) => {
    const expectedKeywords = testCase.expectedKeywords ?? [];
    const expectedDocumentId = testCase.expectedDocumentId ?? documentId;
    const result = await answerQuestionEnhanced(testCase.question, undefined, true);
    const normalizedAnswer = normalizeForSearch(result.answer);
    const passedKeywords = expectedKeywords.every((keyword) =>
      normalizedAnswer.includes(normalizeForSearch(keyword))
    );
    const sourceMarkerHit = (result.sourceMarkers ?? []).some((marker) =>
      marker.documentId === expectedDocumentId
    );

    return {
      question: testCase.question,
      expectedKeywords,
      expectedDocumentId,
      passedKeywords,
      sourceMarkerHit,
      scenarioKey: result.scenarioKey ?? null,
      confidenceLevel: result.confidenceLevel,
      sourceMarkers: (result.sourceMarkers ?? []).slice(0, 10).map((marker) => ({
        token: marker.token,
        documentId: marker.documentId,
        documentTitle: marker.documentTitle,
      })),
      answer: result.answer,
    };
  }));
}

function readSourceSpan(value: unknown): { quote?: string; locationHint?: string } {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return {
    quote: typeof record.quote === 'string' ? record.quote.trim() : undefined,
    locationHint: typeof record.locationHint === 'string' ? record.locationHint.trim() : undefined,
  };
}

function normalizeForSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
