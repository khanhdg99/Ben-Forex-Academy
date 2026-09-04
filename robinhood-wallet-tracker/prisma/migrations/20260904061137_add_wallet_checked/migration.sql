-- AlterTable
ALTER TABLE "Wallet" ADD COLUMN     "checked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "checkedAt" TIMESTAMP(3);
