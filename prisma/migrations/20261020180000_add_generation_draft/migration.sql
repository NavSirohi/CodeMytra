-- CreateEnum
CREATE TYPE "DraftValidationStatus" AS ENUM ('UNVALIDATED', 'VALIDATING', 'PASSED', 'FAILED');

-- CreateTable
CREATE TABLE "GenerationDraft" (
    "id" TEXT NOT NULL,
    "generationRunId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "files" JSONB NOT NULL,
    "manifest" JSONB,
    "validationStatus" "DraftValidationStatus" NOT NULL DEFAULT 'UNVALIDATED',
    "diagnostics" JSONB,
    "summary" TEXT,
    "source" TEXT NOT NULL DEFAULT 'coding-agent',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GenerationDraft_generationRunId_key" ON "GenerationDraft"("generationRunId");

-- CreateIndex
CREATE INDEX "GenerationDraft_projectId_createdAt_idx" ON "GenerationDraft"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "GenerationDraft_generationRunId_idx" ON "GenerationDraft"("generationRunId");

-- AddForeignKey
ALTER TABLE "GenerationDraft" ADD CONSTRAINT "GenerationDraft_generationRunId_fkey" FOREIGN KEY ("generationRunId") REFERENCES "GenerationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationDraft" ADD CONSTRAINT "GenerationDraft_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
