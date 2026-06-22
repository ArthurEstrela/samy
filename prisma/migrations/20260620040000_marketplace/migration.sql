-- CreateTable
CREATE TABLE "model_profiles" (
    "userId" TEXT NOT NULL,
    "bio" TEXT,
    "pricePerMinute" DECIMAL(14,2) NOT NULL,
    "tags" TEXT[],
    "voicePreviewUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_profiles_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "favorites" (
    "id" TEXT NOT NULL,
    "clientUserId" TEXT NOT NULL,
    "modelUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favorites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "model_profiles_pricePerMinute_idx" ON "model_profiles"("pricePerMinute");

-- CreateIndex
CREATE INDEX "favorites_clientUserId_idx" ON "favorites"("clientUserId");

-- CreateIndex
CREATE UNIQUE INDEX "favorites_clientUserId_modelUserId_key" ON "favorites"("clientUserId", "modelUserId");

