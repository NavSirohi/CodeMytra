-- AlterTable OutboxEvent
ALTER TABLE "OutboxEvent" ADD COLUMN "claimedAt" TIMESTAMP(3);
ALTER TABLE "OutboxEvent" ADD COLUMN "nextAttemptAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");
CREATE INDEX "OutboxEvent_status_claimedAt_idx" ON "OutboxEvent"("status", "claimedAt");
