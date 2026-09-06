-- AlterTable
ALTER TABLE "TokenDeployment" ADD COLUMN     "savedAt" TIMESTAMP(3),
ADD COLUMN     "savedForWatch" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "devWalletAt" TIMESTAMP(3),
ADD COLUMN     "isDevWallet" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "TokenDeployment_savedForWatch_idx" ON "TokenDeployment"("savedForWatch");

-- CreateIndex
CREATE INDEX "Wallet_isDevWallet_idx" ON "Wallet"("isDevWallet");
