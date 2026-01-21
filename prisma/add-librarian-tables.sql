-- Add Librarian Knowledge Management System tables
-- Run this manually if prisma db push fails

-- Create enums
DO $$ BEGIN
    CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'CANONICAL', 'DISPUTED', 'STALE');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "LibrarianEntryType" AS ENUM ('FACT', 'PROCEDURE', 'RULE', 'DEFINITION', 'REFERENCE');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "LibrarianSourceType" AS ENUM ('MANUAL', 'AI_EXTRACTED', 'RULE_IMPORT', 'QA_IMPORT', 'AGENT');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "AgentActivityType" AS ENUM ('SEARCH', 'INGEST', 'UPDATE', 'VERIFY', 'DISPUTE');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "LibrarianChangeType" AS ENUM ('CREATE', 'UPDATE', 'VERIFY', 'DISPUTE', 'REVALIDATE', 'ARCHIVE');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create LibrarianEntry table
CREATE TABLE IF NOT EXISTS "LibrarianEntry" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "domainId" TEXT,
    "entryType" "LibrarianEntryType" NOT NULL DEFAULT 'FACT',
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "freshnessScore" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "lastValidatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "evidence" JSONB,
    "sourceType" "LibrarianSourceType" NOT NULL DEFAULT 'MANUAL',
    "sourceId" TEXT,
    "embedding" JSONB,
    "keywords" TEXT[] DEFAULT '{}',
    "entities" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibrarianEntry_pkey" PRIMARY KEY ("id")
);

-- Create LibrarianAgentActivity table
CREATE TABLE IF NOT EXISTS "LibrarianAgentActivity" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "activityType" "AgentActivityType" NOT NULL,
    "entryId" TEXT,
    "details" JSONB,
    "rulesFollowed" TEXT[] DEFAULT '{}',
    "rulesViolated" TEXT[] DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibrarianAgentActivity_pkey" PRIMARY KEY ("id")
);

-- Create LibrarianSearchMetrics table
CREATE TABLE IF NOT EXISTS "LibrarianSearchMetrics" (
    "id" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "queryHash" TEXT NOT NULL,
    "resultCount" INTEGER NOT NULL,
    "avgRelevance" DOUBLE PRECISION NOT NULL,
    "topResultId" TEXT,
    "searchTimeMs" INTEGER NOT NULL,
    "embeddingTimeMs" INTEGER,
    "clickedResultId" TEXT,
    "wasHelpful" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibrarianSearchMetrics_pkey" PRIMARY KEY ("id")
);

-- Create LibrarianChange table
CREATE TABLE IF NOT EXISTS "LibrarianChange" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "changeType" "LibrarianChangeType" NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "reason" TEXT NOT NULL,
    "changedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibrarianChange_pkey" PRIMARY KEY ("id")
);

-- Add indexes
CREATE UNIQUE INDEX IF NOT EXISTS "LibrarianEntry_contentHash_key" ON "LibrarianEntry"("contentHash");
CREATE INDEX IF NOT EXISTS "LibrarianEntry_verificationStatus_idx" ON "LibrarianEntry"("verificationStatus");
CREATE INDEX IF NOT EXISTS "LibrarianEntry_freshnessScore_idx" ON "LibrarianEntry"("freshnessScore");
CREATE INDEX IF NOT EXISTS "LibrarianEntry_domainId_idx" ON "LibrarianEntry"("domainId");
CREATE INDEX IF NOT EXISTS "LibrarianEntry_entryType_idx" ON "LibrarianEntry"("entryType");
CREATE INDEX IF NOT EXISTS "LibrarianEntry_createdAt_idx" ON "LibrarianEntry"("createdAt");

CREATE INDEX IF NOT EXISTS "LibrarianAgentActivity_agentId_idx" ON "LibrarianAgentActivity"("agentId");
CREATE INDEX IF NOT EXISTS "LibrarianAgentActivity_activityType_idx" ON "LibrarianAgentActivity"("activityType");
CREATE INDEX IF NOT EXISTS "LibrarianAgentActivity_createdAt_idx" ON "LibrarianAgentActivity"("createdAt");

CREATE INDEX IF NOT EXISTS "LibrarianSearchMetrics_queryHash_idx" ON "LibrarianSearchMetrics"("queryHash");
CREATE INDEX IF NOT EXISTS "LibrarianSearchMetrics_createdAt_idx" ON "LibrarianSearchMetrics"("createdAt");

CREATE INDEX IF NOT EXISTS "LibrarianChange_entryId_idx" ON "LibrarianChange"("entryId");
CREATE INDEX IF NOT EXISTS "LibrarianChange_changeType_idx" ON "LibrarianChange"("changeType");
CREATE INDEX IF NOT EXISTS "LibrarianChange_createdAt_idx" ON "LibrarianChange"("createdAt");

-- Add foreign key constraints
DO $$ BEGIN
    ALTER TABLE "LibrarianEntry" ADD CONSTRAINT "LibrarianEntry_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "LibrarianChange" ADD CONSTRAINT "LibrarianChange_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "LibrarianEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create HNSW index for vector similarity search (if pgvector supports it)
-- This is optional and can be run later for better performance
-- CREATE INDEX IF NOT EXISTS "LibrarianEntry_embeddingVector_idx" ON "LibrarianEntry" USING hnsw ("embeddingVector" vector_cosine_ops);
