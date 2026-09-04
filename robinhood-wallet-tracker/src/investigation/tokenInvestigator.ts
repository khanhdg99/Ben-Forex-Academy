import type { Address } from "viem";
import { getTokenTransfers, hasOnlyEverReceivedToken, findFundingSource } from "../chain/blockscoutClient.js";
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
  /** The wallet that sent this buyer its first native-ETH funding, if found. */
  fundingSource: Address | null;
  /** How many other analyzed buyers share this same funding source — a
   * strong "same operator" signal when >= 2 (per the "note lại nếu trùng
   * ví nguồn" requirement). */
  sharedFundingGroupSize: number;
  /** Human-readable summary of which signals fired, for direct display. */
  notes: string[];
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
 * 3. Bonus signal: traces each buyer's own funding source (who first sent
 *    it native ETH, via the same lookback used for deployer scoring) and
 *    flags — in both `confidence` and a human-readable `notes` entry —
 *    when multiple analyzed buyers were funded by the *same* wallet. That
 *    root wallet is usually the actual operator behind a batch of "buyer"
 *    wallets, and is often more reliable than looking at the buyers alone.
 *
 * `confidence` combines all three (0-100, can saturate before 100 from
 * fewer signals); `likelyDevWallet` is confidence >= 50, which the "only
 * bought this token" signal alone already clears, matching the primary
 * rule as specified — the other signals just push confidence higher,
 * they aren't required. Analysis works through buyers in chronological
 * order (earliest first) and stops at MAX_BUYERS_TO_ANALYZE, so it's
 * always the token's first buyers being checked. Each buyer now costs up
 * to 3 Blockscout lookups, so a token with many early buyers can take a
 * while — that's expected, not a hang.
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

  // Pass 1: gather raw signals per buyer, including who funded each wallet
  // — needed up front so we can tell, in pass 2, whether multiple buyers
  // trace back to the same root funder (a stronger signal than any single
  // buyer's own data can give).
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

  const fundingGroupCounts = new Map<string, number>();
  for (const r of raw) {
    if (!r.fundingSource) continue;
    const key = r.fundingSource.toLowerCase();
    fundingGroupCounts.set(key, (fundingGroupCounts.get(key) ?? 0) + 1);
  }

  // Pass 2: finalize confidence + human-readable notes now that group sizes are known.
  const buyers: BuyerAnalysis[] = raw.map((r) => {
    const minutesAfter = poolCreatedAt ? (r.firstAt.getTime() - poolCreatedAt.getTime()) / 60_000 : null;
    const amountGroupSize = amountGroupCounts.get(r.amount.toString()) ?? 1;
    const fundingGroupSize = r.fundingSource
      ? (fundingGroupCounts.get(r.fundingSource.toLowerCase()) ?? 1)
      : 1;

    let confidence = 0;
    const notes: string[] = [];

    if (r.onlyThisToken === true) {
      confidence += 50;
      notes.push("Toàn bộ lịch sử ví chỉ mua đúng token này");
    }
    if (r.fresh) {
      confidence += 20;
      notes.push("Ví mới toanh (chưa từng gửi giao dịch nào trước đó)");
    }
    if (amountGroupSize >= 2) {
      confidence += 15;
      notes.push(`Cùng số lượng mua với ${amountGroupSize - 1} ví khác trong danh sách`);
    }
    if (minutesAfter !== null && minutesAfter <= EARLY_BUY_MINUTES) {
      confidence += 15;
      notes.push(`Mua trong ${minutesAfter.toFixed(1)} phút đầu sau khi tạo pool`);
    }
    if (fundingGroupSize >= 2) {
      confidence += 25;
      notes.push(
        `Cùng nguồn vốn (${r.fundingSource}) với ${fundingGroupSize - 1} ví mua khác trong danh sách này`,
      );
    }
    confidence = Math.min(confidence, 100);

    return {
      address: r.address,
      amountBought: r.amount.toString(),
      firstBoughtAt: r.firstAt,
      minutesAfterPoolCreation: minutesAfter,
      isFreshWallet: r.fresh,
      onlyBoughtThisToken: r.onlyThisToken,
      sameAmountGroupSize: amountGroupSize,
      fundingSource: r.fundingSource,
      sharedFundingGroupSize: fundingGroupSize,
      notes,
      confidence,
      likelyDevWallet: confidence >= 50,
    };
  });

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
