import { logger } from "../utils/logger.js";

/**
 * ETH/USD price, cached in-memory for PRICE_CACHE_MS so the dashboard's 5s
 * auto-refresh (which re-fetches cluster members repeatedly) doesn't hammer
 * the price API. Native gas token on Robinhood Chain is ETH, so this is the
 * conversion used for the "how much was funded, in USD" display.
 *
 * Uses CoinGecko's free public API — no key required. Designed to fail
 * quiet and fast: a 3s timeout (some networks silently drop packets to
 * blocked hosts instead of refusing the connection, which without a
 * timeout can hang a request for a very long time), a short backoff after
 * a failure so a bad network doesn't retry on every single call, and an
 * in-flight de-dupe so concurrent callers (e.g. several expanded cluster
 * cards refreshing at once) share one request instead of firing several.
 * On any failure, returns null — callers must treat that as "omit the USD
 * figure," never let a price problem break the feature that displays it.
 */

const PRICE_CACHE_MS = 5 * 60_000;
const FAILURE_BACKOFF_MS = 60_000;
const FETCH_TIMEOUT_MS = 3_000;

let cached: { price: number; fetchedAt: number } | null = null;
let lastFailureAt = 0;
let inFlight: Promise<number | null> | null = null;

export async function getEthUsdPrice(): Promise<number | null> {
  if (cached && Date.now() - cached.fetchedAt < PRICE_CACHE_MS) {
    return cached.price;
  }
  if (Date.now() - lastFailureAt < FAILURE_BACKOFF_MS) {
    return cached?.price ?? null;
  }
  if (inFlight) return inFlight;

  inFlight = fetchEthUsdPrice().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function fetchEthUsdPrice(): Promise<number | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", {
      signal: controller.signal,
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "ETH/USD price fetch failed");
      lastFailureAt = Date.now();
      return cached?.price ?? null;
    }
    const body = (await res.json()) as { ethereum?: { usd?: number } };
    const price = body.ethereum?.usd;
    if (typeof price !== "number") {
      logger.warn({ body }, "unexpected ETH/USD price response shape");
      lastFailureAt = Date.now();
      return cached?.price ?? null;
    }
    cached = { price, fetchedAt: Date.now() };
    return price;
  } catch (err) {
    logger.warn({ err }, "ETH/USD price fetch errored");
    lastFailureAt = Date.now();
    return cached?.price ?? null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Converts a wei amount (native ETH, 18 decimals) to USD using the cached price. */
export function weiToUsd(valueWei: bigint | string, ethUsdPrice: number): number {
  const wei = typeof valueWei === "string" ? BigInt(valueWei) : valueWei;
  return (Number(wei) / 1e18) * ethUsdPrice;
}
