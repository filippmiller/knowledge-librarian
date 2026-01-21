/**
 * Librarian Knowledge Management Service
 *
 * Core service for ingesting, searching, and managing knowledge entries
 * with verification lifecycle, freshness decay, and security checks.
 */

import prisma from '@/lib/db';
import { generateEmbedding } from '@/lib/openai';
import { Prisma, VerificationStatus } from '@prisma/client';
import crypto from 'crypto';

// ============================================
// TYPES
// ============================================

export interface Evidence {
  commit_hash?: string;
  files_changed?: string[];
  functions_affected?: string[];
  tables_affected?: string[];
  api_endpoints?: string[];
  test_results?: { passed: number; failed: number };
}

export interface Entities {
  files?: string[];
  functions?: string[];
  tables?: string[];
  endpoints?: string[];
}

export interface IngestKnowledgeInput {
  title: string;
  content: string;
  domainSlug?: string;
  entryType?: 'FACT' | 'PROCEDURE' | 'RULE' | 'DEFINITION' | 'REFERENCE';
  evidence?: Evidence;
  sourceType?: 'MANUAL' | 'AI_EXTRACTED' | 'RULE_IMPORT' | 'QA_IMPORT' | 'AGENT';
  sourceId?: string;
  createdBy?: string;
  keywords?: string[];
  entities?: Entities;
}

export interface IngestResult {
  success: boolean;
  entryId?: string;
  error?: string;
  isDuplicate?: boolean;
  existingId?: string;
  securityViolations?: string[];
}

export interface SearchKnowledgeInput {
  query: string;
  domainSlug?: string;
  limit?: number;
  minFreshness?: number;
  verificationStatuses?: ('UNVERIFIED' | 'VERIFIED' | 'CANONICAL' | 'DISPUTED' | 'STALE')[];
  agentId?: string;
}

export interface SearchResult {
  id: string;
  title: string;
  content: string;
  score: number;
  verificationScore: number;
  freshnessScore: number;
  relevanceScore: number;
  verificationStatus: string;
  domainSlug?: string;
  evidence?: Evidence;
  createdAt: Date;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
  count: number;
  verifiedCount: number;
}

export interface HealthStats {
  totalEntries: number;
  byStatus: Record<string, number>;
  avgFreshness: number;
  staleEntries: number;
  searchesLast24h: number;
  avgSearchRelevance: number;
}

// ============================================
// CONSTANTS
// ============================================

// Verification scores for ranking
const VERIFICATION_SCORES: Record<string, number> = {
  CANONICAL: 1.0,
  VERIFIED: 0.8,
  UNVERIFIED: 0.5,
  STALE: 0.3,
  DISPUTED: 0.1,
};

// Ranking weights
const RANK_WEIGHTS = {
  verification: 0.4,
  freshness: 0.3,
  relevance: 0.3,
};

// Security: Patterns that should NEVER be stored
const BLOCKED_PATTERNS = [
  // API keys and secrets
  /(?:api[_-]?key|apikey)\s*[:=]\s*['"]?[A-Za-z0-9_-]{20,}/gi,
  /(?:secret[_-]?key|secretkey)\s*[:=]\s*['"]?[A-Za-z0-9_-]{20,}/gi,
  /(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{8,}/gi,

  // Private keys
  /-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+)?PRIVATE\s+KEY-----/gi,

  // OpenAI-style keys
  /sk-[A-Za-z0-9]{32,}/gi,

  // GitHub tokens
  /ghp_[A-Za-z0-9]{36}/gi,
  /gho_[A-Za-z0-9]{36}/gi,
  /github_pat_[A-Za-z0-9_]{22,}/gi,

  // AWS credentials
  /AKIA[A-Z0-9]{16}/gi,
  /(?:aws[_-]?secret|secret[_-]?access[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}/gi,

  // Bearer tokens (generic)
  /bearer\s+[A-Za-z0-9\-_.]{20,}/gi,

  // JWTs
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi,
];

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Generate SHA-256 hash for content deduplication
 */
function generateContentHash(content: string): string {
  return crypto.createHash('sha256').update(content.trim().toLowerCase()).digest('hex');
}

/**
 * Check content for security violations
 */
function checkSecurityPatterns(content: string): { isValid: boolean; violations: string[] } {
  const violations: string[] = [];

  for (const pattern of BLOCKED_PATTERNS) {
    // Reset regex state for global patterns
    pattern.lastIndex = 0;
    if (pattern.test(content)) {
      violations.push(pattern.source.slice(0, 40) + '...');
    }
  }

  return { isValid: violations.length === 0, violations };
}

/**
 * Get verification score based on status
 */
function getVerificationScore(status: string): number {
  return VERIFICATION_SCORES[status] ?? 0.5;
}

/**
 * Calculate final ranking score
 * RANK = (0.4 × verification_score) + (0.3 × freshness_score) + (0.3 × relevance_score)
 */
function calculateRankScore(
  verificationScore: number,
  freshnessScore: number,
  relevanceScore: number
): number {
  return (
    RANK_WEIGHTS.verification * verificationScore +
    RANK_WEIGHTS.freshness * freshnessScore +
    RANK_WEIGHTS.relevance * relevanceScore
  );
}

/**
 * Extract entities from content (files, functions, tables, endpoints)
 */
function extractEntities(content: string): Entities {
  return {
    files: Array.from(
      new Set(
        content.match(/[\w/\-\.]+\.(py|ts|tsx|js|jsx|sql|md|prisma)(?::\d+(?:-\d+)?)?/g) || []
      )
    ).slice(0, 20),
    functions: Array.from(
      new Set(
        content.match(/(?:def|function|async\s+function|const|let|var)\s+(\w+)/g)?.map((m) =>
          m.split(/\s+/).pop()
        ) || []
      )
    )
      .filter(Boolean)
      .slice(0, 20) as string[],
    tables: Array.from(
      new Set(content.match(/(?:model|table|from|join)\s+["'`]?(\w+)["'`]?/gi) || [])
    ).slice(0, 20),
    endpoints: Array.from(
      new Set(content.match(/(?:GET|POST|PUT|DELETE|PATCH)\s+[/\w\-{}]+/gi) || [])
    ).slice(0, 20),
  };
}

/**
 * Extract keywords from content
 */
function extractKeywords(content: string): string[] {
  // Extract capitalized words (potential entities/concepts)
  const capitalizedWords = content.match(/\b[A-Z][a-zA-Z]{3,}\b/g) || [];

  // Extract technical terms
  const technicalTerms =
    content.match(/\b(?:API|HTTP|JSON|SQL|REST|GraphQL|OAuth|JWT|CRUD|UUID)\b/gi) || [];

  // Combine and deduplicate
  const allKeywords = [...new Set([...capitalizedWords, ...technicalTerms.map((t) => t.toUpperCase())])];

  return allKeywords.slice(0, 30);
}

// ============================================
// CORE FUNCTIONS
// ============================================

/**
 * Ingest knowledge with security checks, evidence validation, and duplicate detection
 */
export async function ingestKnowledge(input: IngestKnowledgeInput): Promise<IngestResult> {
  // 1. Security check
  const securityCheck = checkSecurityPatterns(input.content);
  if (!securityCheck.isValid) {
    return {
      success: false,
      error: 'Content contains blocked security patterns',
      securityViolations: securityCheck.violations,
    };
  }

  // Also check title
  const titleSecurityCheck = checkSecurityPatterns(input.title);
  if (!titleSecurityCheck.isValid) {
    return {
      success: false,
      error: 'Title contains blocked security patterns',
      securityViolations: titleSecurityCheck.violations,
    };
  }

  // 2. Generate content hash for deduplication
  const contentHash = generateContentHash(input.content);

  // 3. Check for duplicates
  const existing = await prisma.librarianEntry.findUnique({
    where: { contentHash },
    select: { id: true, title: true },
  });

  if (existing) {
    return {
      success: false,
      isDuplicate: true,
      existingId: existing.id,
      error: `Duplicate content detected. Existing entry: "${existing.title}"`,
    };
  }

  // 4. Resolve domain
  let domainId: string | null = null;
  if (input.domainSlug) {
    const domain = await prisma.domain.findUnique({
      where: { slug: input.domainSlug },
      select: { id: true },
    });
    domainId = domain?.id ?? null;
  }

  // 5. Extract entities and keywords if not provided
  const entities = input.entities || extractEntities(input.content);
  const keywords = input.keywords || extractKeywords(input.content);

  // 6. Generate embedding
  let embedding: number[] | null = null;
  try {
    embedding = await generateEmbedding(input.content);
  } catch (error) {
    console.error('Failed to generate embedding:', error);
    // Continue without embedding - will limit search capability but not block ingestion
  }

  // 7. Create entry using standard Prisma create with JSON embedding
  try {
    const entry = await prisma.librarianEntry.create({
      data: {
        title: input.title,
        content: input.content,
        contentHash,
        domainId,
        entryType: input.entryType || 'FACT',
        verificationStatus: 'UNVERIFIED',
        freshnessScore: 1.0,
        lastValidatedAt: new Date(),
        evidence: (input.evidence || {}) as Prisma.InputJsonValue,
        sourceType: input.sourceType || 'MANUAL',
        sourceId: input.sourceId,
        createdBy: input.createdBy,
        embedding: embedding as Prisma.InputJsonValue,
        keywords,
        entities: entities as Prisma.InputJsonValue,
      },
    });

    const entryId = entry.id;

    // 8. Log the change
    await prisma.librarianChange.create({
      data: {
        entryId,
        changeType: 'CREATE',
        newValue: { title: input.title, contentHash, domainSlug: input.domainSlug },
        reason: 'Knowledge ingested',
        changedBy: input.createdBy || 'system',
      },
    });

    // 9. Log agent activity if agent ID provided
    if (input.createdBy) {
      await prisma.librarianAgentActivity.create({
        data: {
          agentId: input.createdBy,
          activityType: 'INGEST',
          entryId,
          details: { title: input.title, domainSlug: input.domainSlug },
          rulesFollowed: ['ingest-knowledge'],
          rulesViolated: [],
        },
      });
    }

    return { success: true, entryId };
  } catch (error) {
    console.error('Failed to ingest knowledge:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create entry',
    };
  }
}

/**
 * Compute cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Search knowledge with explicit ranking formula
 * Uses JSON embeddings with in-memory cosine similarity
 */
export async function searchKnowledge(input: SearchKnowledgeInput): Promise<SearchResponse> {
  const startTime = Date.now();
  const limit = Math.min(input.limit ?? 10, 50);
  const minFreshness = input.minFreshness ?? 0;
  const statuses = input.verificationStatuses ?? ['CANONICAL', 'VERIFIED', 'UNVERIFIED'];

  // Generate query embedding
  let queryEmbedding: number[] | null = null;
  let embeddingTimeMs = 0;
  try {
    const embStart = Date.now();
    queryEmbedding = await generateEmbedding(input.query);
    embeddingTimeMs = Date.now() - embStart;
  } catch (error) {
    console.error('Failed to generate query embedding:', error);
  }

  // Build where clause for Prisma
  const whereClause: Prisma.LibrarianEntryWhereInput = {
    freshnessScore: { gte: minFreshness },
    verificationStatus: { in: statuses as VerificationStatus[] },
  };

  if (input.domainSlug) {
    whereClause.domain = { slug: input.domainSlug };
  }

  // Fetch entries with embeddings
  const entries = await prisma.librarianEntry.findMany({
    where: whereClause,
    include: {
      domain: { select: { slug: true } },
    },
    orderBy: { freshnessScore: 'desc' },
    take: limit * 3, // Fetch more to allow for re-ranking
  });

  // Compute relevance scores and rank
  let results: SearchResult[] = entries.map((entry) => {
    let relevanceScore = 0.5; // Default if no embedding

    if (queryEmbedding && entry.embedding) {
      const entryEmbedding = entry.embedding as number[];
      if (Array.isArray(entryEmbedding) && entryEmbedding.length === queryEmbedding.length) {
        relevanceScore = cosineSimilarity(queryEmbedding, entryEmbedding);
      }
    }

    const verificationScore = getVerificationScore(entry.verificationStatus);
    const score = calculateRankScore(verificationScore, entry.freshnessScore, relevanceScore);

    return {
      id: entry.id,
      title: entry.title,
      content: entry.content.length > 500 ? entry.content.slice(0, 500) + '...' : entry.content,
      score,
      verificationScore,
      freshnessScore: entry.freshnessScore,
      relevanceScore,
      verificationStatus: entry.verificationStatus,
      domainSlug: entry.domain?.slug,
      evidence: entry.evidence as Evidence | undefined,
      createdAt: entry.createdAt,
    };
  });

  // Sort by score and take limit
  results.sort((a, b) => b.score - a.score);
  results = results.slice(0, limit);

  // If no embedding was generated, also try text search
  if (!queryEmbedding && results.length === 0) {
    const textResults = await prisma.librarianEntry.findMany({
      where: {
        ...whereClause,
        OR: [
          { title: { contains: input.query, mode: 'insensitive' } },
          { content: { contains: input.query, mode: 'insensitive' } },
        ],
      },
      include: {
        domain: { select: { slug: true } },
      },
      orderBy: { freshnessScore: 'desc' },
      take: limit,
    });

    results = textResults.map((entry) => {
      const verificationScore = getVerificationScore(entry.verificationStatus);
      return {
        id: entry.id,
        title: entry.title,
        content: entry.content.length > 500 ? entry.content.slice(0, 500) + '...' : entry.content,
        score: calculateRankScore(verificationScore, entry.freshnessScore, 0.5),
        verificationScore,
        freshnessScore: entry.freshnessScore,
        relevanceScore: 0.5,
        verificationStatus: entry.verificationStatus,
        domainSlug: entry.domain?.slug,
        evidence: entry.evidence as Evidence | undefined,
        createdAt: entry.createdAt,
      };
    });
  }

  const searchTimeMs = Date.now() - startTime;
  const queryHash = generateContentHash(input.query);
  const verifiedCount = results.filter((r) =>
    ['CANONICAL', 'VERIFIED'].includes(r.verificationStatus)
  ).length;

  // Log search metrics
  try {
    await prisma.librarianSearchMetrics.create({
      data: {
        query: input.query,
        queryHash,
        resultCount: results.length,
        avgRelevance:
          results.length > 0
            ? results.reduce((sum, r) => sum + r.relevanceScore, 0) / results.length
            : 0,
        topResultId: results[0]?.id || null,
        searchTimeMs,
        embeddingTimeMs: embeddingTimeMs || null,
      },
    });
  } catch (error) {
    console.error('Failed to log search metrics:', error);
  }

  // Log agent activity if agent ID provided
  if (input.agentId) {
    try {
      await prisma.librarianAgentActivity.create({
        data: {
          agentId: input.agentId,
          activityType: 'SEARCH',
          details: { query: input.query, resultCount: results.length, searchTimeMs },
          rulesFollowed: ['search-knowledge'],
          rulesViolated: [],
        },
      });
    } catch (error) {
      console.error('Failed to log agent activity:', error);
    }
  }

  return {
    results,
    query: input.query,
    count: results.length,
    verifiedCount,
  };
}

/**
 * Mark entry as verified
 */
export async function verifyEntry(
  entryId: string,
  verifiedBy: string,
  asCanonical: boolean = false
): Promise<{ success: boolean; error?: string }> {
  const entry = await prisma.librarianEntry.findUnique({
    where: { id: entryId },
    select: { id: true, verificationStatus: true },
  });

  if (!entry) {
    return { success: false, error: 'Entry not found' };
  }

  const newStatus = asCanonical ? 'CANONICAL' : 'VERIFIED';

  await prisma.$transaction([
    prisma.librarianEntry.update({
      where: { id: entryId },
      data: {
        verificationStatus: newStatus,
        freshnessScore: 1.0,
        lastValidatedAt: new Date(),
      },
    }),
    prisma.librarianChange.create({
      data: {
        entryId,
        changeType: 'VERIFY',
        oldValue: { status: entry.verificationStatus },
        newValue: { status: newStatus },
        reason: asCanonical ? 'Marked as canonical' : 'Verified',
        changedBy: verifiedBy,
      },
    }),
    prisma.librarianAgentActivity.create({
      data: {
        agentId: verifiedBy,
        activityType: 'VERIFY',
        entryId,
        details: { newStatus },
        rulesFollowed: ['verify-entry'],
        rulesViolated: [],
      },
    }),
  ]);

  return { success: true };
}

/**
 * Mark entry as disputed
 */
export async function markDisputed(
  entryId: string,
  disputedBy: string,
  reason: string
): Promise<{ success: boolean; error?: string }> {
  const entry = await prisma.librarianEntry.findUnique({
    where: { id: entryId },
    select: { id: true, verificationStatus: true },
  });

  if (!entry) {
    return { success: false, error: 'Entry not found' };
  }

  await prisma.$transaction([
    prisma.librarianEntry.update({
      where: { id: entryId },
      data: { verificationStatus: 'DISPUTED' },
    }),
    prisma.librarianChange.create({
      data: {
        entryId,
        changeType: 'DISPUTE',
        oldValue: { status: entry.verificationStatus },
        newValue: { status: 'DISPUTED' },
        reason,
        changedBy: disputedBy,
      },
    }),
    prisma.librarianAgentActivity.create({
      data: {
        agentId: disputedBy,
        activityType: 'DISPUTE',
        entryId,
        details: { reason },
        rulesFollowed: ['dispute-entry'],
        rulesViolated: [],
      },
    }),
  ]);

  return { success: true };
}

/**
 * Revalidate entry (refresh freshness)
 */
export async function revalidateEntry(
  entryId: string,
  validatedBy: string
): Promise<{ success: boolean; error?: string }> {
  const entry = await prisma.librarianEntry.findUnique({
    where: { id: entryId },
    select: { id: true, verificationStatus: true, freshnessScore: true },
  });

  if (!entry) {
    return { success: false, error: 'Entry not found' };
  }

  // If entry was stale, upgrade to unverified; otherwise keep status
  const newStatus = entry.verificationStatus === 'STALE' ? 'UNVERIFIED' : entry.verificationStatus;

  await prisma.$transaction([
    prisma.librarianEntry.update({
      where: { id: entryId },
      data: {
        freshnessScore: 1.0,
        lastValidatedAt: new Date(),
        verificationStatus: newStatus,
      },
    }),
    prisma.librarianChange.create({
      data: {
        entryId,
        changeType: 'REVALIDATE',
        oldValue: { freshnessScore: entry.freshnessScore, status: entry.verificationStatus },
        newValue: { freshnessScore: 1.0, status: newStatus },
        reason: 'Entry revalidated',
        changedBy: validatedBy,
      },
    }),
  ]);

  return { success: true };
}

/**
 * Update freshness scores for all entries (scheduled job)
 * Uses 30-day half-life decay: freshness = 0.5^(age_days/30)
 */
export async function updateFreshnessScores(): Promise<{ updated: number; stale: number }> {
  // Update all freshness scores using decay formula
  const result = await prisma.$executeRaw`
    UPDATE "LibrarianEntry"
    SET
      "freshnessScore" = GREATEST(
        0.1,
        LEAST(
          1.0,
          POWER(0.5, EXTRACT(EPOCH FROM (NOW() - "lastValidatedAt")) / (30.0 * 24.0 * 60.0 * 60.0))
          - CASE
              WHEN "expiresAt" IS NOT NULL AND "expiresAt" < NOW()
              THEN EXTRACT(EPOCH FROM (NOW() - "expiresAt")) / (24.0 * 60.0 * 60.0) * 0.1
              ELSE 0
            END
        )
      ),
      "verificationStatus" = CASE
        WHEN "verificationStatus"::text NOT IN ('DISPUTED', 'CANONICAL')
          AND POWER(0.5, EXTRACT(EPOCH FROM (NOW() - "lastValidatedAt")) / (30.0 * 24.0 * 60.0 * 60.0)) < 0.3
        THEN 'STALE'::"VerificationStatus"
        ELSE "verificationStatus"
      END,
      "updatedAt" = NOW()
  `;

  // Count stale entries
  const staleCount = await prisma.librarianEntry.count({
    where: { verificationStatus: 'STALE' },
  });

  return { updated: result, stale: staleCount };
}

/**
 * Get entry by ID
 */
export async function getEntry(entryId: string) {
  return prisma.librarianEntry.findUnique({
    where: { id: entryId },
    include: {
      domain: { select: { slug: true, title: true } },
      changes: { orderBy: { createdAt: 'desc' }, take: 10 },
    },
  });
}

/**
 * Get system health statistics
 */
export async function getHealthStats(): Promise<HealthStats> {
  const [totalEntries, statusCounts, freshnessStats, staleEntries, searchStats] = await Promise.all(
    [
      prisma.librarianEntry.count(),
      prisma.librarianEntry.groupBy({
        by: ['verificationStatus'],
        _count: true,
      }),
      prisma.librarianEntry.aggregate({
        _avg: { freshnessScore: true },
      }),
      prisma.librarianEntry.count({
        where: { verificationStatus: 'STALE' },
      }),
      prisma.librarianSearchMetrics.aggregate({
        where: {
          createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
        _count: true,
        _avg: { avgRelevance: true },
      }),
    ]
  );

  const byStatus: Record<string, number> = {};
  for (const sc of statusCounts) {
    byStatus[sc.verificationStatus] = sc._count;
  }

  return {
    totalEntries,
    byStatus,
    avgFreshness: freshnessStats._avg.freshnessScore ?? 0,
    staleEntries,
    searchesLast24h: searchStats._count,
    avgSearchRelevance: searchStats._avg.avgRelevance ?? 0,
  };
}

/**
 * Log agent activity for compliance tracking
 */
export async function logAgentActivity(
  agentId: string,
  activityType: 'SEARCH' | 'INGEST' | 'UPDATE' | 'VERIFY' | 'DISPUTE',
  details: {
    entryId?: string;
    query?: string;
    results?: number;
    durationMs?: number;
    rulesFollowed?: string[];
    rulesViolated?: string[];
  }
): Promise<void> {
  await prisma.librarianAgentActivity.create({
    data: {
      agentId,
      activityType,
      entryId: details.entryId,
      details: {
        query: details.query,
        results: details.results,
        duration_ms: details.durationMs,
      },
      rulesFollowed: details.rulesFollowed ?? [],
      rulesViolated: details.rulesViolated ?? [],
    },
  });
}

/**
 * Get agent compliance stats
 */
export async function getAgentComplianceStats(agentId: string, hours: number = 24) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const activities = await prisma.librarianAgentActivity.groupBy({
    by: ['activityType'],
    where: {
      agentId,
      createdAt: { gte: since },
    },
    _count: true,
  });

  const byType: Record<string, number> = {};
  for (const a of activities) {
    byType[a.activityType] = a._count;
  }

  return {
    agentId,
    periodHours: hours,
    activities: byType,
    totalActivities: Object.values(byType).reduce((a, b) => a + b, 0),
    hasIngested: (byType['INGEST'] ?? 0) > 0,
    hasSearched: (byType['SEARCH'] ?? 0) > 0,
  };
}
