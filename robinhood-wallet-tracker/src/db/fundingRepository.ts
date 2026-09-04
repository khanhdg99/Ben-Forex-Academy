import type { Address } from "viem";
import { prisma } from "./prisma.js";
import { env } from "../config/env.js";
import { getEthUsdPrice, weiToUsd } from "../chain/priceService.js";

export async function recordFundingTransfer(params: {
  from: Address;
  to: Address;
  txHash: string;
  valueWei: bigint;
  occurredAt: Date;
  toWasFreshWallet: boolean;
}) {
  return prisma.fundingTransfer.create({
    data: {
      fromAddress: params.from.toLowerCase(),
      toAddress: params.to.toLowerCase(),
      txHash: params.txHash,
      valueWei: params.valueWei.toString(),
      occurredAt: params.occurredAt,
      toWasFreshWallet: params.toWasFreshWallet,
    },
  });
}

/** Distinct fresh wallets `source` has funded within the fan-out window. */
export async function countRecentFreshFundedWallets(source: Address): Promise<string[]> {
  const windowStart = new Date(Date.now() - env.FANOUT_WINDOW_MINUTES * 60_000);
  const rows = await prisma.fundingTransfer.findMany({
    where: {
      fromAddress: source.toLowerCase(),
      toWasFreshWallet: true,
      occurredAt: { gte: windowStart },
    },
    select: { toAddress: true },
    distinct: ["toAddress"],
  });
  return rows.map((r) => r.toAddress);
}

/** Upserts the cluster record; returns whether this is a brand-new cluster and whether it grew. */
export async function upsertFundingCluster(source: Address, memberCount: number) {
  const existing = await prisma.fundingCluster.findUnique({
    where: { sourceAddress: source.toLowerCase() },
  });

  await prisma.fundingCluster.upsert({
    where: { sourceAddress: source.toLowerCase() },
    create: { sourceAddress: source.toLowerCase(), walletCount: memberCount },
    update: { walletCount: memberCount },
  });

  return {
    isNew: !existing,
    grew: !existing || memberCount > existing.walletCount,
  };
}

/** If `address` was freshly funded by a known cluster source, returns that cluster. */
export async function findClusterForWallet(address: Address) {
  const transfer = await prisma.fundingTransfer.findFirst({
    where: { toAddress: address.toLowerCase(), toWasFreshWallet: true },
    orderBy: { occurredAt: "desc" },
  });
  if (!transfer) return null;

  return prisma.fundingCluster.findUnique({
    where: { sourceAddress: transfer.fromAddress },
  });
}

export async function listClusters() {
  return prisma.fundingCluster.findMany({
    orderBy: { lastUpdatedAt: "desc" },
    take: 100,
  });
}

export async function listClusterMembers(sourceAddress: string) {
  const rows = await prisma.fundingTransfer.findMany({
    where: { fromAddress: sourceAddress.toLowerCase(), toWasFreshWallet: true },
    orderBy: { occurredAt: "desc" },
    distinct: ["toAddress"],
    take: 200,
  });

  const wallets = await prisma.wallet.findMany({
    where: { address: { in: rows.map((r) => r.toAddress) } },
    select: { address: true, checked: true, starred: true, latestRiskScore: true },
  });
  const walletByAddress = new Map(wallets.map((w) => [w.address, w]));

  const ethUsdPrice = await getEthUsdPrice();

  return rows.map((r) => ({
    address: r.toAddress,
    fundedAt: r.occurredAt,
    txHash: r.txHash,
    valueWei: r.valueWei,
    valueUsd: ethUsdPrice !== null ? weiToUsd(r.valueWei, ethUsdPrice) : null,
    checked: walletByAddress.get(r.toAddress)?.checked ?? false,
    starred: walletByAddress.get(r.toAddress)?.starred ?? false,
    latestRiskScore: walletByAddress.get(r.toAddress)?.latestRiskScore ?? 0,
  }));
}
