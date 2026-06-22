-- CreateTable
CREATE TABLE "calls" (
    "id" TEXT NOT NULL,
    "clientUserId" TEXT NOT NULL,
    "modelUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "endReason" TEXT,
    "pricePerMinuteSnapshot" DECIMAL(14,2) NOT NULL,
    "roomName" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calls_modelUserId_status_idx" ON "calls"("modelUserId", "status");

-- CreateIndex
CREATE INDEX "calls_clientUserId_status_idx" ON "calls"("clientUserId", "status");

