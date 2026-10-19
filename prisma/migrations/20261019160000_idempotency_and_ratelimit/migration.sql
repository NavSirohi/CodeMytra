-- AlterTable
ALTER TABLE "Project" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Project_userId_idempotencyKey_key" ON "Project"("userId", "idempotencyKey");

-- CreateTable
CREATE TABLE "RateLimitRecord" (
    "id" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RateLimitRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateLimitRecord_keyHash_createdAt_idx" ON "RateLimitRecord"("keyHash", "createdAt");
