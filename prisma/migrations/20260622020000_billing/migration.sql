-- AlterTable
ALTER TABLE "model_profiles" ADD COLUMN     "takeRate" DECIMAL(5,4);

-- CreateTable
CREATE TABLE "gift_types" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceCredits" DECIMAL(14,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gift_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gifts" (
    "id" TEXT NOT NULL,
    "clientUserId" TEXT NOT NULL,
    "modelUserId" TEXT NOT NULL,
    "giftTypeId" TEXT NOT NULL,
    "priceSnapshot" DECIMAL(14,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gifts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gifts_modelUserId_idx" ON "gifts"("modelUserId");

