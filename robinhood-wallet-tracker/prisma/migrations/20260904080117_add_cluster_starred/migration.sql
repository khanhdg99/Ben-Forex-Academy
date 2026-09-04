-- AlterTable
ALTER TABLE "FundingCluster" ADD COLUMN     "starred" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "starredAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "FundingCluster_starred_idx" ON "FundingCluster"("starred");
