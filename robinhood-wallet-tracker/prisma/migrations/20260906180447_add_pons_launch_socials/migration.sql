-- AlterTable
ALTER TABLE "TokenDeployment" ADD COLUMN     "discordUrl" TEXT,
ADD COLUMN     "farcasterUrl" TEXT,
ADD COLUMN     "isPonsLaunch" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "telegramUrl" TEXT,
ADD COLUMN     "twitterUrl" TEXT,
ADD COLUMN     "websiteUrl" TEXT;
