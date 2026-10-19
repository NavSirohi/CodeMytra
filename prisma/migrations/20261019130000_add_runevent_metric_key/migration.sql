-- AlterTable
ALTER TABLE "RunEvent" ADD COLUMN IF NOT EXISTS "metricKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "RunEvent_metricKey_key" ON "RunEvent"("metricKey");
