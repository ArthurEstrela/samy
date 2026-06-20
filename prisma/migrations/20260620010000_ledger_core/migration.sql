-- DropTable
DROP TABLE "health_check";

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "entryType" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "transactionGroup" TEXT NOT NULL,
    "idempotencyRef" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "pixKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kyc_status" (
    "account" TEXT NOT NULL,
    "approved" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "kyc_status_pkey" PRIMARY KEY ("account")
);

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_idempotencyRef_key" ON "ledger_entries"("idempotencyRef");

-- CreateIndex
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries"("account");

-- CreateIndex
CREATE INDEX "payouts_status_idx" ON "payouts"("status");
