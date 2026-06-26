-- CreateTable
CREATE TABLE "recharges" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "pspChargeId" TEXT,
    "qrText" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "recharges_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recharges_pspChargeId_idx" ON "recharges"("pspChargeId");

-- CreateIndex
CREATE INDEX "recharges_userId_idx" ON "recharges"("userId");
