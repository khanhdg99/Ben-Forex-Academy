import type { Address } from "viem";
import { prisma } from "../db/prisma.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/** Adds a wallet to the watchlist if its latest score clears the alert threshold. */
export async function maybeAddToWatchlist(wallet: Address, score: number, reason: string) {
  if (score < env.ALERT_SCORE_THRESHOLD) return false;

  await prisma.watchlistEntry.upsert({
    where: { walletAddress: wallet.toLowerCase() },
    create: { walletAddress: wallet.toLowerCase(), reason },
    update: { reason },
  });

  logger.info({ wallet, score, reason }, "wallet added to watchlist");
  return true;
}

export async function isWatchlisted(wallet: Address): Promise<boolean> {
  const entry = await prisma.watchlistEntry.findUnique({
    where: { walletAddress: wallet.toLowerCase() },
  });
  return !!entry?.alertsEnabled;
}

export async function removeFromWatchlist(wallet: Address) {
  await prisma.watchlistEntry
    .delete({ where: { walletAddress: wallet.toLowerCase() } })
    .catch(() => undefined);
}

export async function listWatchlist() {
  return prisma.watchlistEntry.findMany({
    include: { wallet: true },
    orderBy: { addedAt: "desc" },
  });
}
