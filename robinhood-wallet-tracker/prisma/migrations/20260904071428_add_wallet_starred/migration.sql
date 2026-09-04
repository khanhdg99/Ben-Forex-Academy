-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "starred" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "starredAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Wallet_starred_idx" ON "Wallet"("starred");
