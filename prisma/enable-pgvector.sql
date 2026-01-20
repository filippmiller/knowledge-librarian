-- Enable pgvector extension for native vector similarity search
-- Run this ONCE on your PostgreSQL database before running migrations/db push
-- Railway PostgreSQL supports this extension

CREATE EXTENSION IF NOT EXISTS vector;

-- After enabling, you can use:
-- - vector(1536) column type for storing embeddings
-- - <=> operator for cosine distance
-- - <#> operator for inner product distance
-- - <-> operator for L2 distance
-- - CREATE INDEX ... USING ivfflat or hnsw for approximate nearest neighbor

-- Example index creation (run after data migration):
-- CREATE INDEX idx_docchunk_embedding ON "DocChunk" USING hnsw (embedding_vector vector_cosine_ops);
