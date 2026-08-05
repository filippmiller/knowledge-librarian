-- CreateEnum
CREATE TYPE "KnowledgeAudience" AS ENUM ('INTERNAL_ONLY', 'CLIENT_SAFE');

-- CreateEnum
CREATE TYPE "ParseStatus" AS ENUM ('PENDING', 'PROCESSING', 'EXTRACTED', 'COMPLETED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "KnowledgeStatus" AS ENUM ('ACTIVE', 'SUPERSEDED', 'DEPRECATED');

-- CreateEnum
CREATE TYPE "ChangeTargetType" AS ENUM ('RULE', 'QA_PAIR');

-- CreateEnum
CREATE TYPE "ChangeType" AS ENUM ('CREATE', 'UPDATE', 'SUPERSEDE', 'DEPRECATE');

-- CreateEnum
CREATE TYPE "InitiatedBy" AS ENUM ('AI', 'ADMIN');

-- CreateEnum
CREATE TYPE "ChangeStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "QuestionStatus" AS ENUM ('OPEN', 'ANSWERED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ChatSource" AS ENUM ('WEB', 'TELEGRAM', 'API');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'ASSISTANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "ExtractionPhase" AS ENUM ('DOMAIN_CLASSIFICATION', 'KNOWLEDGE_EXTRACTION', 'CHUNKING');

-- CreateEnum
CREATE TYPE "StagedItemType" AS ENUM ('DOMAIN_ASSIGNMENT', 'DOMAIN_SUGGESTION', 'RULE', 'QA_PAIR', 'UNCERTAINTY', 'CHUNK');

-- CreateEnum
CREATE TYPE "TelegramUserRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'USER');

-- CreateEnum
CREATE TYPE "FeedbackRating" AS ENUM ('HELPFUL', 'PARTIALLY', 'NOT_HELPFUL', 'INCORRECT');

-- CreateEnum
CREATE TYPE "FeedbackType" AS ENUM ('MISSING_INFO', 'WRONG_INFO', 'OUTDATED_INFO', 'UNCLEAR', 'OFF_TOPIC', 'GREAT');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'CANONICAL', 'DISPUTED', 'STALE');

-- CreateEnum
CREATE TYPE "LibrarianEntryType" AS ENUM ('FACT', 'PROCEDURE', 'RULE', 'DEFINITION', 'REFERENCE');

-- CreateEnum
CREATE TYPE "LibrarianSourceType" AS ENUM ('MANUAL', 'AI_EXTRACTED', 'RULE_IMPORT', 'QA_IMPORT', 'AGENT');

-- CreateEnum
CREATE TYPE "AgentActivityType" AS ENUM ('SEARCH', 'INGEST', 'UPDATE', 'VERIFY', 'DISPUTE');

-- CreateEnum
CREATE TYPE "LibrarianChangeType" AS ENUM ('CREATE', 'UPDATE', 'VERIFY', 'DISPUTE', 'REVALIDATE', 'ARCHIVE');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('NEW_RULE', 'RULE_UPDATED', 'NEW_DOCUMENT', 'KEYWORD_MATCH');

-- CreateEnum
CREATE TYPE "TariffSection" AS ENUM ('TRANSLATION', 'CERTIFICATION', 'APOSTILLE_SPB', 'APOSTILLE_EDUCATION', 'APOSTILLE_MOSCOW', 'CONSULAR_LEGALIZATION', 'CHAMBER_OF_COMMERCE', 'VITAL_RECORDS_SPB', 'VITAL_RECORDS_URGENT', 'CRIMINAL_RECORD', 'CRIMINAL_RECORD_APOSTILLE', 'NOSTRIFICATION');

-- CreateEnum
CREATE TYPE "TariffAmountKind" AS ENUM ('FIXED', 'FROM', 'PERCENT_OF_BASE', 'PERCENT_SURCHARGE');

-- CreateEnum
CREATE TYPE "TariffUnit" AS ENUM ('DOCUMENT', 'PAGE', 'CONDITIONAL_PAGE', 'MARK', 'VISA', 'PERCENT');

-- CreateEnum
CREATE TYPE "TariffTurnaround" AS ENUM ('STANDARD', 'IN_1_DAY', 'NEXT_DAY', 'SAME_DAY', 'TWO_HOURS');

-- CreateEnum
CREATE TYPE "TranslationDirection" AS ENUM ('FROM_FOREIGN', 'TO_FOREIGN');

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "rawText" TEXT,
    "rawBytes" BYTEA,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "parseStatus" "ParseStatus" NOT NULL DEFAULT 'PENDING',
    "parseError" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "audience" "KnowledgeAudience" NOT NULL DEFAULT 'INTERNAL_ONLY',
    "scenarioKey" TEXT,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentRevision" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "ruleId" TEXT,
    "actor" TEXT,
    "previousRawText" TEXT,
    "nextRawText" TEXT,
    "previousExcerpt" TEXT,
    "nextExcerpt" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingAttempt" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "failedPhase" TEXT,
    "durationMs" INTEGER,

    CONSTRAINT "ProcessingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Domain" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "parentDomainId" TEXT,
    "policy" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainSuggestion" (
    "id" TEXT NOT NULL,
    "suggestedSlug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "parentSlug" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "createdFromDocumentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,

    CONSTRAINT "DomainSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rule" (
    "id" TEXT NOT NULL,
    "documentId" TEXT,
    "ruleCode" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "status" "KnowledgeStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedesRuleId" TEXT,
    "sourceSpan" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "scenarioKey" TEXT,
    "audience" "KnowledgeAudience" NOT NULL DEFAULT 'INTERNAL_ONLY',

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QAPair" (
    "id" TEXT NOT NULL,
    "documentId" TEXT,
    "ruleId" TEXT,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "status" "KnowledgeStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedesQaId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "scenarioKey" TEXT,
    "metadata" JSONB,
    "audience" "KnowledgeAudience" NOT NULL DEFAULT 'INTERNAL_ONLY',

    CONSTRAINT "QAPair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scenarioKey" TEXT,
    "audience" "KnowledgeAudience" NOT NULL DEFAULT 'INTERNAL_ONLY',

    CONSTRAINT "DocChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentDomain" (
    "documentId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentDomain_pkey" PRIMARY KEY ("documentId","domainId")
);

-- CreateTable
CREATE TABLE "RuleDomain" (
    "ruleId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleDomain_pkey" PRIMARY KEY ("ruleId","domainId")
);

-- CreateTable
CREATE TABLE "QADomain" (
    "qaId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QADomain_pkey" PRIMARY KEY ("qaId","domainId")
);

-- CreateTable
CREATE TABLE "ChunkDomain" (
    "chunkId" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.8,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChunkDomain_pkey" PRIMARY KEY ("chunkId","domainId")
);

-- CreateTable
CREATE TABLE "KnowledgeChange" (
    "id" TEXT NOT NULL,
    "targetType" "ChangeTargetType" NOT NULL,
    "targetId" TEXT NOT NULL,
    "changeType" "ChangeType" NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "reason" TEXT NOT NULL,
    "initiatedBy" "InitiatedBy" NOT NULL,
    "approvedBy" TEXT,
    "status" "ChangeStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "KnowledgeChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIQuestion" (
    "id" TEXT NOT NULL,
    "issueType" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "context" JSONB,
    "proposedChange" JSONB,
    "affectedRuleId" TEXT,
    "status" "QuestionStatus" NOT NULL DEFAULT 'OPEN',
    "response" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "AIQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatSession" (
    "id" TEXT NOT NULL,
    "source" "ChatSource" NOT NULL DEFAULT 'WEB',
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'ADMIN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StagedExtraction" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "phase" "ExtractionPhase" NOT NULL,
    "itemType" "StagedItemType" NOT NULL,
    "data" JSONB NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isRejected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "StagedExtraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramUser" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "role" "TelegramUserRole" NOT NULL DEFAULT 'USER',
    "grantedBy" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notificationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AISettings" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'openai',
    "apiKey" TEXT,
    "model" TEXT NOT NULL DEFAULT 'gpt-4o',
    "embeddingModel" TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastVerified" TIMESTAMP(3),
    "lastError" TEXT,
    "autoAnswerEnabled" BOOLEAN NOT NULL DEFAULT false,
    "autoAnswerMinConfidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AISettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnswerFeedback" (
    "id" TEXT NOT NULL,
    "messageId" TEXT,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "rating" "FeedbackRating" NOT NULL,
    "feedbackType" "FeedbackType",
    "comment" TEXT,
    "suggestedAnswer" TEXT,
    "confidence" DOUBLE PRECISION,
    "domainsUsed" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "resolution" TEXT,

    CONSTRAINT "AnswerFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HallucinationLog" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT,
    "question" TEXT NOT NULL,
    "scenarioKey" TEXT,
    "initialAnswer" TEXT NOT NULL,
    "regeneratedAnswer" TEXT,
    "unsupportedClaims" JSONB NOT NULL,
    "unsupportedCount" INTEGER NOT NULL,
    "regenerated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HallucinationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmCallLog" (
    "id" TEXT NOT NULL,
    "callSite" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "userMessage" TEXT NOT NULL,
    "rawResponse" TEXT,
    "temperature" DOUBLE PRECISION,
    "maxTokens" INTEGER,
    "responseFormat" TEXT,
    "streaming" BOOLEAN NOT NULL DEFAULT false,
    "latencyMs" INTEGER,
    "error" TEXT,
    "sessionId" TEXT,
    "question" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibrarianEntry" (
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
    "keywords" TEXT[],
    "entities" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LibrarianEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibrarianAgentActivity" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "activityType" "AgentActivityType" NOT NULL,
    "entryId" TEXT,
    "details" JSONB,
    "rulesFollowed" TEXT[],
    "rulesViolated" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LibrarianAgentActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LibrarianSearchMetrics" (
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

-- CreateTable
CREATE TABLE "LibrarianChange" (
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

-- CreateTable
CREATE TABLE "UserFavorite" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "UserFavorite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleComment" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isEdited" BOOLEAN NOT NULL DEFAULT false,
    "isDeleted" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "RuleComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserNotification" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "domainId" TEXT,
    "ruleId" TEXT,
    "keywords" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPreference" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "theme" TEXT NOT NULL DEFAULT 'system',
    "fontSize" TEXT NOT NULL DEFAULT 'medium',
    "offlineCache" BOOLEAN NOT NULL DEFAULT true,
    "pushEnabled" BOOLEAN NOT NULL DEFAULT true,
    "language" TEXT NOT NULL DEFAULT 'ru',
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationLog" (
    "id" TEXT NOT NULL,
    "telegramId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "ruleId" TEXT,
    "documentId" TEXT,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tariff" (
    "synonyms" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "id" TEXT NOT NULL,
    "naturalKey" TEXT NOT NULL,
    "section" "TariffSection" NOT NULL,
    "sectionTitle" TEXT,
    "serviceName" TEXT NOT NULL,
    "authority" TEXT,
    "termText" TEXT,
    "conditions" TEXT,
    "amount" DECIMAL(12,2),
    "amountKind" "TariffAmountKind" NOT NULL DEFAULT 'FIXED',
    "percent" DECIMAL(6,2),
    "percentBase" TEXT,
    "baseFeeAmount" DECIMAL(12,2),
    "unit" "TariffUnit" NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "priceText" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "audience" "KnowledgeAudience" NOT NULL DEFAULT 'INTERNAL_ONLY',
    "footnote" TEXT,
    "language" TEXT,
    "complexityCategory" INTEGER,
    "direction" "TranslationDirection",
    "turnaround" "TariffTurnaround",
    "includesNotary" BOOLEAN NOT NULL DEFAULT false,
    "sourceFile" TEXT NOT NULL,
    "documentId" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tariff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HeldAnswer" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "draftAnswer" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "delivery" TEXT NOT NULL,
    "blocker" TEXT,
    "reasons" JSONB NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "confidenceLevel" TEXT NOT NULL,
    "answerSource" TEXT,
    "sessionId" TEXT,
    "verdict" TEXT,
    "verdictBy" TEXT,
    "verdictAt" TIMESTAMP(3),
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HeldAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Document_parseStatus_idx" ON "Document"("parseStatus");

-- CreateIndex
CREATE INDEX "Document_scenarioKey_idx" ON "Document"("scenarioKey");

-- CreateIndex
CREATE INDEX "DocumentRevision_documentId_idx" ON "DocumentRevision"("documentId");

-- CreateIndex
CREATE INDEX "DocumentRevision_ruleId_idx" ON "DocumentRevision"("ruleId");

-- CreateIndex
CREATE INDEX "DocumentRevision_createdAt_idx" ON "DocumentRevision"("createdAt");

-- CreateIndex
CREATE INDEX "ProcessingAttempt_documentId_idx" ON "ProcessingAttempt"("documentId");

-- CreateIndex
CREATE INDEX "ProcessingAttempt_status_idx" ON "ProcessingAttempt"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_slug_key" ON "Domain"("slug");

-- CreateIndex
CREATE INDEX "Domain_parentDomainId_idx" ON "Domain"("parentDomainId");

-- CreateIndex
CREATE INDEX "Domain_slug_idx" ON "Domain"("slug");

-- CreateIndex
CREATE INDEX "DomainSuggestion_status_idx" ON "DomainSuggestion"("status");

-- CreateIndex
CREATE INDEX "DomainSuggestion_createdFromDocumentId_idx" ON "DomainSuggestion"("createdFromDocumentId");

-- CreateIndex
CREATE INDEX "Rule_status_idx" ON "Rule"("status");

-- CreateIndex
CREATE INDEX "Rule_ruleCode_idx" ON "Rule"("ruleCode");

-- CreateIndex
CREATE INDEX "Rule_documentId_idx" ON "Rule"("documentId");

-- CreateIndex
CREATE INDEX "Rule_scenarioKey_idx" ON "Rule"("scenarioKey");

-- CreateIndex
CREATE INDEX "Rule_audience_idx" ON "Rule"("audience");

-- CreateIndex
CREATE INDEX "QAPair_status_idx" ON "QAPair"("status");

-- CreateIndex
CREATE INDEX "QAPair_documentId_idx" ON "QAPair"("documentId");

-- CreateIndex
CREATE INDEX "QAPair_ruleId_idx" ON "QAPair"("ruleId");

-- CreateIndex
CREATE INDEX "QAPair_scenarioKey_idx" ON "QAPair"("scenarioKey");

-- CreateIndex
CREATE INDEX "QAPair_audience_idx" ON "QAPair"("audience");

-- CreateIndex
CREATE INDEX "DocChunk_documentId_idx" ON "DocChunk"("documentId");

-- CreateIndex
CREATE INDEX "DocChunk_scenarioKey_idx" ON "DocChunk"("scenarioKey");

-- CreateIndex
CREATE INDEX "DocChunk_audience_idx" ON "DocChunk"("audience");

-- CreateIndex
CREATE UNIQUE INDEX "DocChunk_documentId_chunkIndex_key" ON "DocChunk"("documentId", "chunkIndex");

-- CreateIndex
CREATE INDEX "KnowledgeChange_targetType_targetId_idx" ON "KnowledgeChange"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "KnowledgeChange_status_idx" ON "KnowledgeChange"("status");

-- CreateIndex
CREATE INDEX "KnowledgeChange_createdAt_idx" ON "KnowledgeChange"("createdAt");

-- CreateIndex
CREATE INDEX "AIQuestion_status_idx" ON "AIQuestion"("status");

-- CreateIndex
CREATE INDEX "AIQuestion_issueType_idx" ON "AIQuestion"("issueType");

-- CreateIndex
CREATE INDEX "ChatMessage_sessionId_idx" ON "ChatMessage"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_username_idx" ON "User"("username");

-- CreateIndex
CREATE INDEX "StagedExtraction_documentId_phase_idx" ON "StagedExtraction"("documentId", "phase");

-- CreateIndex
CREATE INDEX "StagedExtraction_documentId_isVerified_idx" ON "StagedExtraction"("documentId", "isVerified");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramUser_telegramId_key" ON "TelegramUser"("telegramId");

-- CreateIndex
CREATE INDEX "TelegramUser_telegramId_idx" ON "TelegramUser"("telegramId");

-- CreateIndex
CREATE INDEX "TelegramUser_role_idx" ON "TelegramUser"("role");

-- CreateIndex
CREATE INDEX "AnswerFeedback_rating_idx" ON "AnswerFeedback"("rating");

-- CreateIndex
CREATE INDEX "AnswerFeedback_feedbackType_idx" ON "AnswerFeedback"("feedbackType");

-- CreateIndex
CREATE INDEX "AnswerFeedback_createdAt_idx" ON "AnswerFeedback"("createdAt");

-- CreateIndex
CREATE INDEX "HallucinationLog_scenarioKey_idx" ON "HallucinationLog"("scenarioKey");

-- CreateIndex
CREATE INDEX "HallucinationLog_createdAt_idx" ON "HallucinationLog"("createdAt");

-- CreateIndex
CREATE INDEX "LlmCallLog_createdAt_idx" ON "LlmCallLog"("createdAt");

-- CreateIndex
CREATE INDEX "LlmCallLog_callSite_idx" ON "LlmCallLog"("callSite");

-- CreateIndex
CREATE INDEX "LlmCallLog_sessionId_idx" ON "LlmCallLog"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "LibrarianEntry_contentHash_key" ON "LibrarianEntry"("contentHash");

-- CreateIndex
CREATE INDEX "LibrarianEntry_verificationStatus_idx" ON "LibrarianEntry"("verificationStatus");

-- CreateIndex
CREATE INDEX "LibrarianEntry_freshnessScore_idx" ON "LibrarianEntry"("freshnessScore");

-- CreateIndex
CREATE INDEX "LibrarianEntry_domainId_idx" ON "LibrarianEntry"("domainId");

-- CreateIndex
CREATE INDEX "LibrarianEntry_entryType_idx" ON "LibrarianEntry"("entryType");

-- CreateIndex
CREATE INDEX "LibrarianEntry_createdAt_idx" ON "LibrarianEntry"("createdAt");

-- CreateIndex
CREATE INDEX "LibrarianAgentActivity_agentId_idx" ON "LibrarianAgentActivity"("agentId");

-- CreateIndex
CREATE INDEX "LibrarianAgentActivity_activityType_idx" ON "LibrarianAgentActivity"("activityType");

-- CreateIndex
CREATE INDEX "LibrarianAgentActivity_createdAt_idx" ON "LibrarianAgentActivity"("createdAt");

-- CreateIndex
CREATE INDEX "LibrarianSearchMetrics_queryHash_idx" ON "LibrarianSearchMetrics"("queryHash");

-- CreateIndex
CREATE INDEX "LibrarianSearchMetrics_createdAt_idx" ON "LibrarianSearchMetrics"("createdAt");

-- CreateIndex
CREATE INDEX "LibrarianChange_entryId_idx" ON "LibrarianChange"("entryId");

-- CreateIndex
CREATE INDEX "LibrarianChange_changeType_idx" ON "LibrarianChange"("changeType");

-- CreateIndex
CREATE INDEX "LibrarianChange_createdAt_idx" ON "LibrarianChange"("createdAt");

-- CreateIndex
CREATE INDEX "UserFavorite_telegramId_idx" ON "UserFavorite"("telegramId");

-- CreateIndex
CREATE INDEX "UserFavorite_ruleId_idx" ON "UserFavorite"("ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "UserFavorite_telegramId_ruleId_key" ON "UserFavorite"("telegramId", "ruleId");

-- CreateIndex
CREATE INDEX "RuleComment_ruleId_idx" ON "RuleComment"("ruleId");

-- CreateIndex
CREATE INDEX "RuleComment_telegramId_idx" ON "RuleComment"("telegramId");

-- CreateIndex
CREATE INDEX "RuleComment_parentId_idx" ON "RuleComment"("parentId");

-- CreateIndex
CREATE INDEX "RuleComment_createdAt_idx" ON "RuleComment"("createdAt");

-- CreateIndex
CREATE INDEX "UserNotification_telegramId_idx" ON "UserNotification"("telegramId");

-- CreateIndex
CREATE INDEX "UserNotification_domainId_idx" ON "UserNotification"("domainId");

-- CreateIndex
CREATE INDEX "UserNotification_ruleId_idx" ON "UserNotification"("ruleId");

-- CreateIndex
CREATE UNIQUE INDEX "UserPreference_telegramId_key" ON "UserPreference"("telegramId");

-- CreateIndex
CREATE INDEX "UserPreference_telegramId_idx" ON "UserPreference"("telegramId");

-- CreateIndex
CREATE INDEX "NotificationLog_telegramId_idx" ON "NotificationLog"("telegramId");

-- CreateIndex
CREATE INDEX "NotificationLog_isRead_idx" ON "NotificationLog"("isRead");

-- CreateIndex
CREATE INDEX "NotificationLog_sentAt_idx" ON "NotificationLog"("sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "Tariff_naturalKey_key" ON "Tariff"("naturalKey");

-- CreateIndex
CREATE INDEX "Tariff_audience_idx" ON "Tariff"("audience");

-- CreateIndex
CREATE INDEX "Tariff_documentId_idx" ON "Tariff"("documentId");

-- CreateIndex
CREATE INDEX "Tariff_effectiveFrom_idx" ON "Tariff"("effectiveFrom");

-- CreateIndex
CREATE INDEX "Tariff_language_complexityCategory_direction_turnaround_idx" ON "Tariff"("language", "complexityCategory", "direction", "turnaround");

-- CreateIndex
CREATE INDEX "Tariff_section_isActive_idx" ON "Tariff"("section", "isActive");

-- CreateIndex
CREATE INDEX "HeldAnswer_createdAt_idx" ON "HeldAnswer"("createdAt");

-- CreateIndex
CREATE INDEX "HeldAnswer_verdict_idx" ON "HeldAnswer"("verdict");

-- AddForeignKey
ALTER TABLE "DocumentRevision" ADD CONSTRAINT "DocumentRevision_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessingAttempt" ADD CONSTRAINT "ProcessingAttempt_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_parentDomainId_fkey" FOREIGN KEY ("parentDomainId") REFERENCES "Domain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainSuggestion" ADD CONSTRAINT "DomainSuggestion_createdFromDocumentId_fkey" FOREIGN KEY ("createdFromDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_supersedesRuleId_fkey" FOREIGN KEY ("supersedesRuleId") REFERENCES "Rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QAPair" ADD CONSTRAINT "QAPair_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QAPair" ADD CONSTRAINT "QAPair_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QAPair" ADD CONSTRAINT "QAPair_supersedesQaId_fkey" FOREIGN KEY ("supersedesQaId") REFERENCES "QAPair"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocChunk" ADD CONSTRAINT "DocChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentDomain" ADD CONSTRAINT "DocumentDomain_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentDomain" ADD CONSTRAINT "DocumentDomain_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleDomain" ADD CONSTRAINT "RuleDomain_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleDomain" ADD CONSTRAINT "RuleDomain_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QADomain" ADD CONSTRAINT "QADomain_qaId_fkey" FOREIGN KEY ("qaId") REFERENCES "QAPair"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QADomain" ADD CONSTRAINT "QADomain_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChunkDomain" ADD CONSTRAINT "ChunkDomain_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "DocChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChunkDomain" ADD CONSTRAINT "ChunkDomain_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StagedExtraction" ADD CONSTRAINT "StagedExtraction_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibrarianEntry" ADD CONSTRAINT "LibrarianEntry_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LibrarianChange" ADD CONSTRAINT "LibrarianChange_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "LibrarianEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserFavorite" ADD CONSTRAINT "UserFavorite_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleComment" ADD CONSTRAINT "RuleComment_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleComment" ADD CONSTRAINT "RuleComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "RuleComment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserNotification" ADD CONSTRAINT "UserNotification_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserNotification" ADD CONSTRAINT "UserNotification_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tariff" ADD CONSTRAINT "Tariff_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

