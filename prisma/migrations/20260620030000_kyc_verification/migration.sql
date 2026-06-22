-- CreateTable
CREATE TABLE "kyc_verifications" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerRef" TEXT NOT NULL,
    "clientToken" TEXT NOT NULL,
    "sessionExpiresAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "kyc_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "kyc_verifications_providerRef_key" ON "kyc_verifications"("providerRef");

-- CreateIndex
CREATE INDEX "kyc_verifications_account_idx" ON "kyc_verifications"("account");

