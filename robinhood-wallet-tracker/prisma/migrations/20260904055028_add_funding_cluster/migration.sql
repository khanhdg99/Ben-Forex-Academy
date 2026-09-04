-- CreateTable
CREATE TABLE "FundingTransfer" (
    "id" TEXT NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "valueWei" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "toWasFreshWallet" BOOLEAN NOT NULL,

    CONSTRAINT "FundingTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FundingCluster" (
    "id" TEXT NOT NULL,
    "sourceAddress" TEXT NOT NULL,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUpdatedAt" TIMESTAMP(3) NOT NULL,
    "walletCount" INTEGER NOT NULL,

    CONSTRAINT "FundingCluster_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FundingTransfer_fromAddress_occurredAt_idx" ON "FundingTransfer"("fromAddress", "occurredAt");

-- CreateIndex
CREATE INDEX "FundingTransfer_toAddress_idx" ON "FundingTransfer"("toAddress");

-- CreateIndex
CREATE UNIQUE INDEX "FundingCluster_sourceAddress_key" ON "FundingCluster"("sourceAddress");

-- CreateIndex
CREATE INDEX "FundingCluster_sourceAddress_idx" ON "FundingCluster"("sourceAddress");
