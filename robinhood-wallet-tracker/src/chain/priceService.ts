import { logger } from "../utils/logger.js";

/**
 * ETH/USD price, cached in-memory for PRICE_CACHE_MS so the dashboard's 5s
 * auto-refresh (which re-fetches cluster members repeatedly) doesn't hammer
 * the price API. Native gas token on Robinhood Chain is ETH, so this is the
 * conversion used for the "how much was funded, in USD" display.
 *
 * Uses CoinGecko's free public API — no key required. If it's unreachable
 * (rate-limited, network down, API shape changed), returns null and callers
 * should just omit the USD figure rather than show a wrong number.
 */

const PRICE_CACHE_MS = 5 * 60_000;
let cached: { price: number; fetchedAt: number } | null = null;

export async function getEthUsdPrice(): Promise<number | null> {
  if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_MS) {
    return cached.price;
  }

  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd");
    if (!res.ok) {
      logger.warn({ status: res.status }, "ETH/USD price fetch failed");
      return cached?.price ?? null;
    }
    const body = (await res.json()) as { ethereum?: { usd?: number } };
    const price = body.ethereum?.usd;
    if (typeof price !== "number") {
      logger.warn({ body }, "unexpected ETH/USD price response shape");
      return cached?.price ?? null;
    }
    cached = { price, fetchedAt: Date.now() };
    return price;
  } catch (err) {
    logger.warn({ err }, "ETH/USD price fetch errored");
    return cached?.price ?? null;
  }
}

/** Converts a wei amount (native ETH, 18 decimals) to USD using the cached price. */
export function weiToUsd(valueWei: bigint | string, ethUsdPrice: number): number {
  const wei = typeof valueWei === "string" ? BigInt(valueWei) : valueWei;
  return (Number(wei) / 1e18) * ethUsdPrice;
}
