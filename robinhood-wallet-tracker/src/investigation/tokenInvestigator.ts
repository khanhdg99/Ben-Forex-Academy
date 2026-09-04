import type { Address } from "viem";
import { getTokenTransfers, hasOnlyEverReceivedToken, findFundingSource } from "../chain/blockscoutClient.js";
import { isFreshWallet } from "../chain/walletFreshness.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_BUYERS_TO_ANALYZE = 100;
const MIN_SHARED_FUNDING_MEMBERS = 2;

export interface QualifyingBuyer {
  address: Address;
  /** Raw token amount (smallest unit) as a string — avoids bigint/JSON issues. */
  amountBought: string;
  firstBoughtAt: Date;
  minutesAfterPoolCreation: number | null;
  /** The wallet that sent this buyer its first native-ETH funding, if found. */
  fundingSource: Address | null;
  /** How many other qualifying buyers bought the exact same token amount. */
  sameAmountGroupSize: number;
}

export interface TokenInvestigationResult {
  tokenAddress: Address;
  poolAddress: Address | null;
  poolCreatedAt: Date | null;
  poolSource: "tracked" | "inferred" | "unknown";
  decimals: number | null;
  symbol: string | null;
  /** Total distinct buyers scanned (earliest-first, capped at MAX_BUYERS_TO_ANALYZE). */
  buyersAnalyzed: number;
  /** Buyers that are BOTH a brand-new wallet (nonce 0) AND have never bought
   * any token other than this one — the two hard filters requested, not a
   * fuzzy score. Everyone else is left out entirely. */
  qualifyingBuyers: QualifyingBuyer[];
  /** The funding source shared by the most qualifying buyers, if at least
   * MIN_SHARED_FUNDING_MEMBERS of them trace back to the same wallet — the
   * dev-wallet candidate to add to follow/watchlist. */
  suspectedDevWallet: Address | null;
  suspectedDevWalletMemberCount: number;
}

/**
 * Given a token address (tracked by this bot or not — e.g. pasted in by the
 * user for a token that launched before the bot was watching), finds its
 * early buyers (earliest first, up to MAX_BUYERS_TO_ANALYZE) and filters
 * down to the ones that are BOTH:
 *
 * 1. A brand-new wallet (nonce 0 at time of buying) — never sent a
 *    transaction before.
 * 2. Have never received/bought any ERC-20 token other than this one —
 *    a real trader's wallet has other tokens in its history; a throwaway
 *    wallet spun up to fake-buy one launch usually doesn't.
 *
 * Those are the two hard requirements (both must hold — not a weighted
 * score), matching a scripted batch of fake "buyer" wallets a dev spins up
 * to fake demand on their own launch. Among just that qualifying set, it
 * then traces each one's own funding source (who first sent it native ETH)
 * and, if MIN_SHARED_FUNDING_MEMBERS or more of them were funded by the
 * *same* wallet, surfaces that wallet as `suspectedDevWallet` — the actual
 * operator behind the batch, and the one worth adding to follow/watchlist.
 * Each buyer costs up to 3 Blockscout lookups, so a token with many early
 * buyers can take a while — that's expected, not a hang.
 */
export async function investigateToken(tokenAddress: Address): Promise<TokenInvestigationResult> {
  const tracked = await findTrackedPool(tokenAddress);

  const { transfers, decimals, symbol } = await getTokenTransfers(tokenAddress);
  if (transfers.length === 0) {
    return {
      tokenAddress,
      poolAddress: tracked?.poolAddress ?? null,
      poolCreatedAt: tracked?.poolCreatedAt ?? null,
      poolSource: tracked ? "tracked" : "unknown",
      decimals,
      symbol,
      buyersAnalyzed: 0,
      qualifyingBuyers: [],
      suspectedDevWallet: null,
      suspectedDevWalletMemberCount: 0,
    };
  }

  transfers.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  let poolAddress = tracked?.poolAddress ?? null;
  let poolCreatedAt = tracked?.poolCreatedAt ?? null;
  let poolSource: TokenInvestigationResult["poolSource"] = tracked ? "tracked" : "unknown";

  if (!poolAddress) {
    const inferred = inferPoolAddress(transfers);
    if (inferred) {
      poolAddress = inferred;
      poolCreatedAt = transfers.find((t) => t.from.toLowerCase() === inferred.toLowerCase())?.timestamp ?? null;
      poolSource = "inferred";
    }
  }

  if (!poolAddress) {
    logger.warn({ tokenAddress }, "could not determine pool address for token investigation");
    return {
      tokenAddress,
      poolAddress: null,
      poolCreatedAt: null,
      poolSource: "unknown",
      decimals,
      symbol,
      buyersAnalyzed: 0,
      qualifyingBuyers: [],
      suspectedDevWallet: null,
      suspectedDevWalletMemberCount: 0,
    };
  }

  const buys = transfers.filter((t) => t.from.toLowerCase() === poolAddress!.toLowerCase());

  const byBuyer = new Map<string, { amount: bigint; firstAt: Date }>();
  for (const buy of buys) {
    const key = buy.to.toLowerCase();
    const existing = byBuyer.get(key);
    if (existing) {
      existing.amount += buy.value;
      continue;
    }
    if (byBuyer.size >= MAX_BUYERS_TO_ANALYZE) continue;
    byBuyer.set(key, { amount: buy.value, firstAt: buy.timestamp });
  }

  // Check every scanned buyer against both hard filters, in parallel per
  // buyer (fine at this bot's scale — a token with many early buyers is
  // still just a handful of concurrent Blockscout calls at a time).
  interface RawBuyer {
    address: Address;
    amount: bigint;
    firstAt: Date;
    fresh: boolean;
    onlyThisToken: boolean | null;
    fundingSource: Address | null;
  }
  const raw: RawBuyer[] = [];
  for (const [address, info] of byBuyer) {
    const addr = address as Address;
    const [fresh, onlyThisToken, funding] = await Promise.all([
      isFreshWallet(addr).catch(() => false),
      hasOnlyEverReceivedToken(addr, tokenAddress),
      findFundingSource(addr).catch(() => null),
    ]);
    raw.push({
      address: addr,
      amount: info.amount,
      firstAt: info.firstAt,
      fresh,
      onlyThisToken,
      fundingSource: funding?.fundingSource ?? null,
    });
  }

  const qualifying = raw.filter((r) => r.fresh && r.onlyThisToken === true);

  const amountGroupCounts = new Map<string, number>();
  for (const r of qualifying) {
    const key = r.amount.toString();
    amountGroupCounts.set(key, (amountGroupCounts.get(key) ?? 0) + 1);
  }

  const fundingGroupCounts = new Map<string, number>();
  for (const r of qualifying) {
    if (!r.fundingSource) continue;
    const key = r.fundingSource.toLowerCase();
    fundingGroupCounts.set(key, (fundingGroupCounts.get(key) ?? 0) + 1);
  }

  let suspectedDevWallet: Address | null = null;
  let suspectedDevWalletMemberCount = 0;
  for (const [source, count] of fundingGroupCounts) {
    if (count > suspectedDevWalletMemberCount) {
      suspectedDevWallet = source as Address;
      suspectedDevWalletMemberCount = count;
    }
  }
  if (suspectedDevWalletMemberCount < MIN_SHARED_FUNDING_MEMBERS) {
    suspectedDevWallet = null;
    suspectedDevWalletMemberCount = 0;
  }

  const qualifyingBuyers: QualifyingBuyer[] = qualifying
    .map((r) => ({
      address: r.address,
      amountBought: r.amount.toString(),
      firstBoughtAt: r.firstAt,
      minutesAfterPoolCreation: poolCreatedAt ? (r.firstAt.getTime() - poolCreatedAt.getTime()) / 60_000 : null,
      fundingSource: r.fundingSource,
      sameAmountGroupSize: amountGroupCounts.get(r.amount.toString()) ?? 1,
    }))
    .sort((a, b) => a.firstBoughtAt.getTime() - b.firstBoughtAt.getTime());

  return {
    tokenAddress,
    poolAddress,
    poolCreatedAt,
    poolSource,
    decimals,
    symbol,
    buyersAnalyzed: raw.length,
    qualifyingBuyers,
    suspectedDevWallet,
    suspectedDevWalletMemberCount,
  };
}

async function findTrackedPool(
  tokenAddress: Address,
): Promise<{ poolAddress: Address; poolCreatedAt: Date } | null> {
  const deployment = await prisma.tokenDeployment.findUnique({
    where: { tokenAddress: tokenAddress.toLowerCase() },
    include: { liquidityEvents: true },
  });
  const poolEvent = deployment?.liquidityEvents.find((e) => e.type === "POOL_CREATED");
  if (!poolEvent?.poolAddress) return null;
  return { poolAddress: poolEvent.poolAddress as Address, poolCreatedAt: poolEvent.occurredAt };
}

/**
 * Best-effort pool-address guess when the token isn't one this bot tracked
 * itself: the address that shows up most often as the *sender* of this
 * token's transfers is almost always the liquidity pool, since every DEX
 * buy is a Transfer from the pool to the buyer.
 */
function inferPoolAddress(transfers: { from: Address; to: Address }[]): Address | null {
  const counts = new Map<string, number>();
  for (const t of transfers) {
    if (t.from.toLowerCase() === ZERO_ADDRESS) continue;
    const key = t.from.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [addr, count] of counts) {
    if (count > bestCount) {
      best = addr;
      bestCount = count;
    }
  }
  return best as Address | null;
}
