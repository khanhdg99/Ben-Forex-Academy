-- CreateEnum
CREATE TYPE "LiquidityEventType" AS ENUM ('POOL_CREATED', 'INITIAL_BUY', 'LIQUIDITY_REMOVED');

-- CreateTable
CREATE TABLE "Wallet" (
    "address" TEXT NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fundingSource" TEXT,
    "fundingTxHash" TEXT,
    "fundedAt" TIMESTAMP(3),
    "latestRiskScore" INTEGER NOT NULL DEFAULT 0,
    "priorDeployments" INTEGER NOT NULL DEFAULT 0,
    "priorRugs" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("address")
);

-- CreateTable
CREATE TABLE "TokenDeployment" (
    "id" TEXT NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "deployerAddress" TEXT NOT NULL,
    "deployTxHash" TEXT NOT NULL,
    "deployedAt" TIMESTAMP(3) NOT NULL,
    "looksLikeErc20" BOOLEAN NOT NULL DEFAULT false,
    "name" TEXT,
    "symbol" TEXT,

    CONSTRAINT "TokenDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LiquidityEvent" (
    "id" TEXT NOT NULL,
    "tokenDeploymentId" TEXT NOT NULL,
    "type" "LiquidityEventType" NOT NULL,
    "dex" TEXT,
    "poolAddress" TEXT,
    "actorAddress" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "amountPct" DOUBLE PRECISION,
    "minutesAfterPool" DOUBLE PRECISION,

    CONSTRAINT "LiquidityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SwapEvent" (
    "id" TEXT NOT NULL,
    "tokenDeploymentId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SwapEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RiskScoreLog" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "tokenDeploymentId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "breakdown" JSONB NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RiskScoreLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistEntry" (
    "walletAddress" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "alertsEnabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "WatchlistEntry_pkey" PRIMARY KEY ("walletAddress")
);

-- CreateIndex
CREATE INDEX "Wallet_fundingSource_idx" ON "Wallet"("fundingSource");

-- CreateIndex
CREATE INDEX "Wallet_latestRiskScore_idx" ON "Wallet"("latestRiskScore");

-- CreateIndex
CREATE UNIQUE INDEX "TokenDeployment_tokenAddress_key" ON "TokenDeployment"("tokenAddress");

-- CreateIndex
CREATE INDEX "TokenDeployment_deployerAddress_idx" ON "TokenDeployment"("deployerAddress");

-- CreateIndex
CREATE INDEX "TokenDeployment_deployedAt_idx" ON "TokenDeployment"("deployedAt");

-- CreateIndex
CREATE INDEX "LiquidityEvent_tokenDeploymentId_idx" ON "LiquidityEvent"("tokenDeploymentId");

-- CreateIndex
CREATE INDEX "LiquidityEvent_type_idx" ON "LiquidityEvent"("type");

-- CreateIndex
CREATE INDEX "SwapEvent_tokenDeploymentId_idx" ON "SwapEvent"("tokenDeploymentId");

-- CreateIndex
CREATE INDEX "SwapEvent_walletAddress_idx" ON "SwapEvent"("walletAddress");

-- CreateIndex
CREATE INDEX "RiskScoreLog_walletAddress_idx" ON "RiskScoreLog"("walletAddress");

-- CreateIndex
CREATE INDEX "RiskScoreLog_score_idx" ON "RiskScoreLog"("score");

-- AddForeignKey
ALTER TABLE "TokenDeployment" ADD CONSTRAINT "TokenDeployment_deployerAddress_fkey" FOREIGN KEY ("deployerAddress") REFERENCES "Wallet"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LiquidityEvent" ADD CONSTRAINT "LiquidityEvent_tokenDeploymentId_fkey" FOREIGN KEY ("tokenDeploymentId") REFERENCES "TokenDeployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SwapEvent" ADD CONSTRAINT "SwapEvent_tokenDeploymentId_fkey" FOREIGN KEY ("tokenDeploymentId") REFERENCES "TokenDeployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskScoreLog" ADD CONSTRAINT "RiskScoreLog_walletAddress_fkey" FOREIGN KEY ("walletAddress") REFERENCES "Wallet"("address") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RiskScoreLog" ADD CONSTRAINT "RiskScoreLog_tokenDeploymentId_fkey" FOREIGN KEY ("tokenDeploymentId") REFERENCES "TokenDeployment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistEntry" ADD CONSTRAINT "WatchlistEntry_walletAddress_fkey" FOREIGN KEY ("walletAddress") REFERENCES "Wallet"("address") ON DELETE RESTRICT ON UPDATE CASCADE;
