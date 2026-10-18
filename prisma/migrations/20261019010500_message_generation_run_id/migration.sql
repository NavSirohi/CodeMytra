-- AlterTable
ALTER TABLE "Message" ADD COLUMN IF NOT EXISTS "generationRunId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "Message_generationRunId_key" ON "Message"("generationRunId");

-- AddForeignKey
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Message_generationRunId_fkey'
  ) THEN
    ALTER TABLE "Message" ADD CONSTRAINT "Message_generationRunId_fkey" FOREIGN KEY ("generationRunId") REFERENCES "GenerationRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
