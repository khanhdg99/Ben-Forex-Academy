import { prisma } from "./prisma.js";
import { logger } from "../utils/logger.js";

/**
 * Checking a wallet (☑ "đã check") now means "I'm done with this, get rid
 * of it" — it moves into the Trash list and, unless unchecked again within
 * this many hours, is permanently deleted (the wallet, its deployments and
 * every event/score tied to those, its watchlist entry, and its fan-out
 * cluster row if it's a cluster source). The same window is reused for
 * unsaved token deployments below.
 */
const TRASH_RETENTION_HOURS = 24;
const RETENTION_MS = TRASH_RETENTION_HOURS * 60 * 60 * 1000;

/** Every wallet currently checked ("in trash"), soonest-to-expire first — dev wallets are exempt (see below), so never listed here. */
export async function listTrashWallets() {
  const wallets = await prisma.wallet.findMany({
    where: { checked: true, isDevWallet: false },
    orderBy: { checkedAt: "asc" },
  });
  if (wallets.length === 0) return [];

  const clusters = await prisma.fundingCluster.findMany({
    where: { sourceAddress: { in: wallets.map((w) => w.address) } },
    select: { sourceAddress: true, walletCount: true },
  });
  const clusterByAddress = new Map(clusters.map((c) => [c.sourceAddress, c]));

  return wallets.map((w) => {
    const checkedAt = w.checkedAt ?? w.firstSeenAt;
    return {
      address: w.address,
      checkedAt,
      expiresAt: new Date(checkedAt.getTime() + RETENTION_MS),
      isClusterSource: clusterByAddress.has(w.address),
      clusterWalletCount: clusterByAddress.get(w.address)?.walletCount ?? null,
    };
  });
}

/**
 * Deletes a wallet and everything that references it: its own token
 * deployments (and each one's liquidity/swap/score events), its watchlist
 * entry, and its fan-out cluster row if it's a cluster source. Raw
 * FundingTransfer rows mentioning this address are left alone — they're
 * historical on-chain record, not wallet metadata, and nothing else has a
 * foreign key into them.
 */
async function deleteWalletCascade(address: string) {
  const deployments = await prisma.tokenDeployment.findMany({
    where: { deployerAddress: address },
    select: { id: true },
  });
  const deploymentIds = deployments.map((d) => d.id);

  await prisma.$transaction([
    prisma.fundingCluster.deleteMany({ where: { sourceAddress: address } }),
    prisma.liquidityEvent.deleteMany({ where: { tokenDeploymentId: { in: deploymentIds } } }),
    prisma.swapEvent.deleteMany({ where: { tokenDeploymentId: { in: deploymentIds } } }),
    prisma.riskScoreLog.deleteMany({ where: { tokenDeploymentId: { in: deploymentIds } } }),
    prisma.tokenDeployment.deleteMany({ where: { id: { in: deploymentIds } } }),
    prisma.watchlistEntry.deleteMany({ where: { walletAddress: address } }),
    prisma.wallet.delete({ where: { address } }),
  ]);
}

/**
 * Permanently deletes every wallet that's been checked longer than the
 * retention window. A confirmed dev wallet (isDevWallet) is exempt — that
 * flag means "keep this one around for tracking," so checking it (e.g. by
 * mistake, or because it's also being reviewed) never queues it for
 * deletion. Returns how many were deleted.
 */
export async function runTrashCleanup(): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_MS);
  const expired = await prisma.wallet.findMany({
    where: { checked: true, checkedAt: { lte: cutoff }, isDevWallet: false },
    select: { address: true },
  });

  for (const { address } of expired) {
    try {
      await deleteWalletCascade(address);
      logger.info({ address }, "trash: permanently deleted wallet past retention window");
    } catch (err) {
      logger.error({ err, address }, "trash: failed to delete wallet");
    }
  }
  return expired.length;
}

async function deleteDeploymentCascade(id: string) {
  await prisma.$transaction([
    prisma.liquidityEvent.deleteMany({ where: { tokenDeploymentId: id } }),
    prisma.swapEvent.deleteMany({ where: { tokenDeploymentId: id } }),
    prisma.riskScoreLog.deleteMany({ where: { tokenDeploymentId: id } }),
    prisma.tokenDeployment.delete({ where: { id } }),
  ]);
}

/**
 * Permanently deletes every token deployment that hasn't been explicitly
 * saved within the retention window of its own deployedAt — the inverse of
 * the wallet trash above: here doing nothing is what gets it deleted, not
 * checking a box. Returns how many were deleted.
 */
export async function runTokenCleanup(): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_MS);
  const expired = await prisma.tokenDeployment.findMany({
    where: { savedForWatch: false, deployedAt: { lte: cutoff } },
    select: { id: true, tokenAddress: true },
  });

  for (const { id, tokenAddress } of expired) {
    try {
      await deleteDeploymentCascade(id);
      logger.info({ tokenAddress }, "trash: permanently deleted unsaved token deployment past 24h");
    } catch (err) {
      logger.error({ err, tokenAddress }, "trash: failed to delete token deployment");
    }
  }
  return expired.length;
}

/** Runs both cleanups now (catching up on anything missed while the bot was down), then hourly. */
export function startTrashCleanupLoop() {
  const run = () => {
    void runTrashCleanup().catch((err) => logger.error({ err }, "wallet trash cleanup loop failed"));
    void runTokenCleanup().catch((err) => logger.error({ err }, "token cleanup loop failed"));
  };
  run();
  const interval = setInterval(run, 60 * 60 * 1000);
  interval.unref();
  return () => clearInterval(interval);
}
