-- Изоляция корпусов знаний. Дефолт 'aurora' делает уже лежащие строки
-- корректными без бэкфилла: сегодняшняя база — корпус бюро.
-- IF NOT EXISTS: прод исторически идёт через самоприменяющийся bootstrap,
-- а не через prisma migrate deploy. Повторный прогон не должен падать.

ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "corpusId" TEXT NOT NULL DEFAULT 'aurora';
ALTER TABLE "Rule" ADD COLUMN IF NOT EXISTS "corpusId" TEXT NOT NULL DEFAULT 'aurora';
ALTER TABLE "QAPair" ADD COLUMN IF NOT EXISTS "corpusId" TEXT NOT NULL DEFAULT 'aurora';
ALTER TABLE "DocChunk" ADD COLUMN IF NOT EXISTS "corpusId" TEXT NOT NULL DEFAULT 'aurora';
ALTER TABLE "Tariff" ADD COLUMN IF NOT EXISTS "corpusId" TEXT NOT NULL DEFAULT 'aurora';

CREATE INDEX IF NOT EXISTS "Document_corpusId_idx" ON "Document"("corpusId");
CREATE INDEX IF NOT EXISTS "Rule_corpusId_idx" ON "Rule"("corpusId");
CREATE INDEX IF NOT EXISTS "QAPair_corpusId_idx" ON "QAPair"("corpusId");
CREATE INDEX IF NOT EXISTS "DocChunk_corpusId_idx" ON "DocChunk"("corpusId");
CREATE INDEX IF NOT EXISTS "Tariff_corpusId_idx" ON "Tariff"("corpusId");
