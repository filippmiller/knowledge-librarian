-- CreateTable
CREATE TABLE "KnowledgeExtractionRun" (
    "id" TEXT NOT NULL,
    "extractionRunId" TEXT NOT NULL,
    "documentId" TEXT,
    "sourceDocPath" TEXT,
    "sourceRevisionHash" TEXT NOT NULL,
    "canonicalTextHash" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "extractionProvider" TEXT NOT NULL,
    "extractionModel" TEXT NOT NULL,
    "extractionPromptVersion" TEXT NOT NULL,
    "extractionSchemaVersion" TEXT NOT NULL,
    "humanReviewed" BOOLEAN NOT NULL DEFAULT false,
    "qualifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeExtractionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeUnitRecord" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceBlockAnchor" TEXT NOT NULL,
    "parentRuleRef" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeUnitRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeUnitReviewDecision" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reviewedBy" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeUnitReviewDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeExtractionRun_extractionRunId_key" ON "KnowledgeExtractionRun"("extractionRunId");

-- CreateIndex
CREATE INDEX "KnowledgeExtractionRun_documentId_idx" ON "KnowledgeExtractionRun"("documentId");

-- CreateIndex
CREATE INDEX "KnowledgeExtractionRun_canonicalTextHash_idx" ON "KnowledgeExtractionRun"("canonicalTextHash");

-- CreateIndex
CREATE INDEX "KnowledgeUnitRecord_unitId_idx" ON "KnowledgeUnitRecord"("unitId");

-- CreateIndex
CREATE INDEX "KnowledgeUnitRecord_contentHash_idx" ON "KnowledgeUnitRecord"("contentHash");

-- CreateIndex
CREATE INDEX "KnowledgeUnitRecord_kind_idx" ON "KnowledgeUnitRecord"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeUnitRecord_runId_unitId_key" ON "KnowledgeUnitRecord"("runId", "unitId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeUnitReviewDecision_unitId_key" ON "KnowledgeUnitReviewDecision"("unitId");

-- AddForeignKey
ALTER TABLE "KnowledgeExtractionRun" ADD CONSTRAINT "KnowledgeExtractionRun_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeUnitRecord" ADD CONSTRAINT "KnowledgeUnitRecord_runId_fkey" FOREIGN KEY ("runId") REFERENCES "KnowledgeExtractionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

