import type { Address } from "viem";
import { getTokenTransfers, hasOnlyEverReceivedToken } from "../chain/blockscoutClient.js";
import { isFreshWallet } from "../chain/walletFreshness.js";
import { prisma } from "../db/prisma.js";
import { logger } from "../utils/logger.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_BUYERS_TO_ANALYZE = 30;
const EARLY_BUY_MINUTES = 10;

export interface BuyerAnalysis {
  address: Address;
  /** Raw token amount (smallest unit) as a string — avoids bigint/JSON issues. */
  amountBought: string;
  firstBoughtAt: Date;
  minutesAfterPoolCreation: number | null;
  isFreshWallet: boolean;
  /** null = couldn't determine (Blockscout call failed / ambiguous). */
  onlyBoughtThisToken: boolean | null;
  /** How many other analyzed buyers bought the exact same token amount. */
  sameAmountGroupSize: number;
  /** 0-100, see investigateToken() doc for how this is built. */
  confidence: number;
  likelyDevWallet: boolean;
}

export interface TokenInvestigationResult {
  tokenAddress: Address;
  poolAddress: Address | null;
  poolCreatedAt: Date | null;
  poolSource: "tracked" | "inferred" | "unknown";
  decimals: number | null;
  symbol: string | null;
  buyersAnalyzed: number;
  buyers: BuyerAnalysis[];
}

/**
 * Given a token address (tracked by this bot or not — e.g. pasted in by the
 * user for a token that launched before the bot was watching), finds its
 * early buyers and flags the ones that look dev-controlled per the two
 * signals requested:
 *
 * 1. Core signal: the wallet's entire ERC-20 inbound history is just this
 *    one token — a real trader's wallet has bought other things before;
 *    a throwaway wallet spun up to fake-buy one launch usually hasn't.
 * 2. Bonus signal: multiple brand-new wallets bought the exact same token
 *    amount — a classic sign of a scripted/automated batch of buys from
 *    one operator, rather than independent organic buyers.
 *
 * `confidence` combines both (0-100); `likelyDevWallet` is confidence >= 50,
 * which the "only bought this token" signal alone already clears, matching
 * the primary rule as specified — freshness and matching-amount just push
 * confidence higher, they aren't required.
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
      buyers: [],
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
      buyers: [],
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

  const amountGroupCounts = new Map<string, number>();
  for (const { amount } of byBuyer.values()) {
    const key = amount.toString();
    amountGroupCounts.set(key, (amountGroupCounts.get(key) ?? 0) + 1);
  }

  const buyers: BuyerAnalysis[] = [];
  for (const [address, info] of byBuyer) {
    const addr = address as Address;
    const [fresh, onlyThisToken] = await Promise.all([
      isFreshWallet(addr).catch(() => false),
      hasOnlyEverReceivedToken(addr, tokenAddress),
    ]);

    const minutesAfter = poolCreatedAt ? (info.firstAt.getTime() - poolCreatedAt.getTime()) / 60_000 : null;
    const groupSize = amountGroupCounts.get(info.amount.toString()) ?? 1;

    let confidence = 0;
    if (onlyThisToken === true) confidence += 50;
    if (fresh) confidence += 20;
    if (groupSize >= 2) confidence += 15;
    if (minutesAfter !== null && minutesAfter <= EARLY_BUY_MINUTES) confidence += 15;
    confidence = Math.min(confidence, 100);

    buyers.push({
      address: addr,
      amountBought: info.amount.toString(),
      firstBoughtAt: info.firstAt,
      minutesAfterPoolCreation: minutesAfter,
      isFreshWallet: fresh,
      onlyBoughtThisToken: onlyThisToken,
      sameAmountGroupSize: groupSize,
      confidence,
      likelyDevWallet: confidence >= 50,
    });
  }

  buyers.sort((a, b) => b.confidence - a.confidence);

  return {
    tokenAddress,
    poolAddress,
    poolCreatedAt,
    poolSource,
    decimals,
    symbol,
    buyersAnalyzed: buyers.length,
    buyers,
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
