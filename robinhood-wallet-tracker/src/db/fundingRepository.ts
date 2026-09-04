import type { Address } from "viem";
import { prisma } from "./prisma.js";
import { env } from "../config/env.js";
import { getEthUsdPrice, weiToUsd } from "../chain/priceService.js";

export type ClusterMatchType = "fresh" | "amount" | "fresh+amount";

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

interface BurstRow {
  toAddress: string;
  occurredAt: Date;
  valueWei: string;
  toWasFreshWallet: boolean;
}

/** Splits chronologically-sorted rows wherever the gap to the next row exceeds `maxGapMinutes`. */
function splitIntoBursts(rowsAsc: BurstRow[], maxGapMinutes: number): BurstRow[][] {
  const gapMs = maxGapMinutes * 60_000;
  const bursts: BurstRow[][] = [];
  let current: BurstRow[] = [];
  for (const row of rowsAsc) {
    if (current.length > 0) {
      const prevTime = current[current.length - 1].occurredAt.getTime();
      if (row.occurredAt.getTime() - prevTime > gapMs) {
        bursts.push(current);
        current = [];
      }
    }
    current.push(row);
  }
  if (current.length > 0) bursts.push(current);
  return bursts;
}

/** Groups rows by amount (chained adjacency within `tolerancePct`) and returns the largest group. */
function largestAmountGroup(rows: BurstRow[], tolerancePct: number): BurstRow[] {
  const sorted = [...rows].sort((a, b) => {
    const av = BigInt(a.valueWei);
    const bv = BigInt(b.valueWei);
    return av < bv ? -1 : av > bv ? 1 : 0;
  });

  const groups: BurstRow[][] = [];
  let current: BurstRow[] = [];
  for (const row of sorted) {
    if (current.length > 0) {
      const prev = BigInt(current[current.length - 1].valueWei);
      const val = BigInt(row.valueWei);
      const diff = val > prev ? val - prev : prev - val;
      const ref = prev === 0n ? 1n : prev;
      const diffPct = Number((diff * 10000n) / ref) / 100;
      if (diffPct > tolerancePct) {
        groups.push(current);
        current = [];
      }
    }
    current.push(row);
  }
  if (current.length > 0) groups.push(current);

  return groups.reduce((best, g) => (g.length > best.length ? g : best), [] as BurstRow[]);
}

/**
 * Looks at every transfer `source` has sent recently and isolates the tight
 * "burst" ending at the most recent one — a run of transfers each no more
 * than FANOUT_MAX_GAP_MINUTES apart. This replaces a naive "everything in
 * the trailing N minutes from now" window, which let two members end up
 * up to ~2x that window apart from *each other* (the actual complaint:
 * sub-wallets funded 1-2h apart were being grouped as one cluster).
 *
 * A burst counts as a cluster if enough of its recipients are either:
 *  - brand-new wallets (nonce 0) — the classic dev-sybil / sniper pattern, or
 *  - all funded a near-identical amount close together in time regardless
 *    of freshness — the pattern of an exchange or bridge wallet fanning
 *    the same amount out to several wallets one person controls (which
 *    themselves may not be fresh if they've been used before).
 */
export async function detectFundingBurst(
  source: Address,
): Promise<{ members: string[]; matchType: ClusterMatchType } | null> {
  const lookbackStart = new Date(Date.now() - env.FANOUT_LOOKBACK_HOURS * 60 * 60_000);
  const rows = await prisma.fundingTransfer.findMany({
    where: { fromAddress: source.toLowerCase(), occurredAt: { gte: lookbackStart } },
    orderBy: { occurredAt: "asc" },
    select: { toAddress: true, occurredAt: true, valueWei: true, toWasFreshWallet: true },
  });
  if (rows.length === 0) return null;

  const bursts = splitIntoBursts(rows, env.FANOUT_MAX_GAP_MINUTES);
  const latestBurst = bursts[bursts.length - 1];

  const freshMembers = new Set(
    latestBurst.filter((r) => r.toWasFreshWallet).map((r) => r.toAddress),
  );
  const amountGroup = largestAmountGroup(latestBurst, env.FANOUT_AMOUNT_TOLERANCE_PCT);
  const amountMembers = new Set(amountGroup.map((r) => r.toAddress));

  const freshQualifies = freshMembers.size >= env.FANOUT_MIN_WALLETS;
  const amountQualifies = amountMembers.size >= env.FANOUT_MIN_WALLETS;

  if (!freshQualifies && !amountQualifies) return null;
  if (freshQualifies && amountQualifies) {
    return {
      members: [...new Set([...freshMembers, ...amountMembers])],
      matchType: "fresh+amount",
    };
  }
  if (freshQualifies) {
    return { members: [...freshMembers], matchType: "fresh" };
  }
  return { members: [...amountMembers], matchType: "amount" };
}

/** Upserts the cluster record; returns whether this is a brand-new cluster and whether it grew. */
export async function upsertFundingCluster(
  source: Address,
  memberCount: number,
  matchType: ClusterMatchType,
) {
  const existing = await prisma.fundingCluster.findUnique({
    where: { sourceAddress: source.toLowerCase() },
  });

  await prisma.fundingCluster.upsert({
    where: { sourceAddress: source.toLowerCase() },
    create: { sourceAddress: source.toLowerCase(), walletCount: memberCount, matchType },
    update: { walletCount: memberCount, matchType },
  });

  return {
    isNew: !existing,
    grew: !existing || memberCount > existing.walletCount,
  };
}

/** If `address` was ever funded by a known cluster source, returns that cluster. */
export async function findClusterForWallet(address: Address) {
  const transfer = await prisma.fundingTransfer.findFirst({
    where: { toAddress: address.toLowerCase() },
    orderBy: { occurredAt: "desc" },
  });
  if (!transfer) return null;

  return prisma.fundingCluster.findUnique({
    where: { sourceAddress: transfer.fromAddress },
  });
}

export async function listClusters() {
  const clusters = await prisma.fundingCluster.findMany({
    orderBy: [{ starred: "desc" }, { lastUpdatedAt: "desc" }],
    take: 100,
  });

  // The source address is a wallet like any other — surface whether *it*
  // has been marked "đã check" so the card header can show the same red
  // tick used everywhere else, even though a source doesn't always have
  // its own Wallet row (it's only created lazily, e.g. on first check).
  const sourceWallets = await prisma.wallet.findMany({
    where: { address: { in: clusters.map((c) => c.sourceAddress) } },
    select: { address: true, checked: true },
  });
  const checkedByAddress = new Map(sourceWallets.map((w) => [w.address, w.checked]));

  // A checked source has moved to the Trash section (see trashRepository.ts)
  // — drop it from the main grid rather than showing it dimmed in place.
  return clusters
    .filter((c) => !checkedByAddress.get(c.sourceAddress))
    .map((c) => ({ ...c, sourceChecked: false }));
}

/** Flips a cluster's "I need to watch this whole group" flag. */
export async function setClusterStarred(sourceAddress: string, starred: boolean) {
  return prisma.fundingCluster.update({
    where: { sourceAddress: sourceAddress.toLowerCase() },
    data: { starred, starredAt: starred ? new Date() : null },
  });
}

export async function listClusterMembers(sourceAddress: string) {
  // Not filtered to fresh-only recipients anymore: a cluster can now also
  // be triggered by the same-amount signal, whose members may be reused
  // (non-fresh) wallets — e.g. an exchange wallet's other source wallets.
  const rows = await prisma.fundingTransfer.findMany({
    where: { fromAddress: sourceAddress.toLowerCase() },
    orderBy: { occurredAt: "desc" },
    distinct: ["toAddress"],
    take: 200,
  });

  const wallets = await prisma.wallet.findMany({
    where: { address: { in: rows.map((r) => r.toAddress) } },
    select: { address: true, checked: true, starred: true, latestRiskScore: true },
  });
  const walletByAddress = new Map(wallets.map((w) => [w.address, w]));

  // Belt-and-suspenders: getEthUsdPrice() already guards its own network
  // call, but a price problem must never be able to break the member list
  // itself, so it's guarded again here.
  let ethUsdPrice: number | null = null;
  try {
    ethUsdPrice = await getEthUsdPrice();
  } catch {
    ethUsdPrice = null;
  }

  // Checked members have moved to the Trash section — drop them here too.
  return rows
    .filter((r) => !walletByAddress.get(r.toAddress)?.checked)
    .map((r) => ({
      address: r.toAddress,
      fundedAt: r.occurredAt,
      txHash: r.txHash,
      valueWei: r.valueWei,
      valueUsd: ethUsdPrice !== null ? weiToUsd(r.valueWei, ethUsdPrice) : null,
      wasFresh: r.toWasFreshWallet,
      checked: false,
      starred: walletByAddress.get(r.toAddress)?.starred ?? false,
      latestRiskScore: walletByAddress.get(r.toAddress)?.latestRiskScore ?? 0,
    }));
}
