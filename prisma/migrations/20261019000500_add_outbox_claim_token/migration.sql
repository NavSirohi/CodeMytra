-- AlterTable
ALTER TABLE "OutboxEvent" ADD COLUMN IF NOT EXISTS "claimToken" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OutboxEvent_claimToken_idx" ON "OutboxEvent"("claimToken");
