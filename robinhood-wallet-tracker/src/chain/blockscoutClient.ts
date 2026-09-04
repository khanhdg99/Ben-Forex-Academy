import type { Address } from "viem";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Thin client over the Blockscout v2 REST API (robinhoodchain.blockscout.com)
 * used for data the RPC alone can't give us cheaply: an address's full
 * transaction history (for funding-source lookback and serial-deployer
 * backfill).
 *
 * Blockscout instances occasionally differ in exact response shape between
 * versions — if these calls start failing, check the live API docs at
 * `${BLOCKSCOUT_API_BASE}/../docs` (Swagger UI most Blockscout deployments
 * expose) and adjust the paths/fields below.
 */

interface BlockscoutTx {
  hash: string;
  from: { hash: string };
  to: { hash: string } | null;
  timestamp: string;
  value: string;
  method: string | null;
}

interface BlockscoutTxListResponse {
  items: BlockscoutTx[];
  next_page_params: Record<string, unknown> | null;
}

// A bare Node fetch() with no User-Agent gets 403'd by Blockscout's
// Cloudflare/WAF bot protection on some deployments — the exact same URL
// works fine when opened in an actual browser, which sends headers like
// these automatically. Confirmed against a real failure: the same address
// returned 403 from this client on both the v2 and classic endpoints while
// loading fine in-browser.
const BROWSER_LIKE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
};

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 700;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetches `url` with browser-like headers, retrying a couple times on
 * 403/429 (blocked or rate-limited — worth one retry since it can be
 * transient) with a short increasing delay. Returns null (never throws) on
 * final failure so callers can treat "no data" and "API problem" the same
 * way — this endpoint is a best-effort enrichment, not load-bearing.
 */
async function fetchBlockscout(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: BROWSER_LIKE_HEADERS });
      if (res.ok) return res;
      if ((res.status === 403 || res.status === 429) && attempt < MAX_RETRIES) {
        logger.warn(
          { url, status: res.status, attempt: attempt + 1 },
          "blockscout request blocked/rate-limited, retrying",
        );
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      logger.warn({ url, status: res.status }, "blockscout API request failed");
      return null;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      logger.warn({ err, url }, "blockscout API request errored");
      return null;
    }
  }
  return null;
}

async function blockscoutGet<T>(path: string): Promise<T | null> {
  const url = `${env.BLOCKSCOUT_API_BASE}${path}`;
  const res = await fetchBlockscout(url);
  if (!res) return null;
  const body = (await res.json()) as T;
  logger.debug({ url, preview: JSON.stringify(body).slice(0, 300) }, "blockscout API response");
  return body;
}

/**
 * Base URL for the "classic"/Etherscan-compatible API most Blockscout
 * deployments also expose at `/api` (as opposed to the REST-ish `/api/v2`
 * used everywhere else in this file) — kept as a fallback data source since
 * exact v2 endpoint paths/shapes are the least standardized part of
 * Blockscout across versions, per the disclaimer above.
 */
function blockscoutClassicApiBase(): string {
  return env.BLOCKSCOUT_API_BASE.replace(/\/api\/v2\/?$/, "/api");
}

async function blockscoutClassicGet<T>(params: Record<string, string>): Promise<T | null> {
  const url = `${blockscoutClassicApiBase()}?${new URLSearchParams(params).toString()}`;
  const res = await fetchBlockscout(url);
  if (!res) return null;
  const body = (await res.json()) as T;
  logger.debug({ url, preview: JSON.stringify(body).slice(0, 300) }, "blockscout classic API response");
  return body;
}

/**
 * Finds the earliest inbound native-ETH transfer to `address` — a rough
 * proxy for "the wallet that funded this deployer", which is often a bridge
 * contract or a reused funding wallet shared across many throwaway deployer
 * addresses.
 */
export async function findFundingSource(address: Address): Promise<{
  fundingSource: Address;
  fundingTxHash: string;
  fundedAt: Date;
} | null> {
  const data = await blockscoutGet<BlockscoutTxListResponse>(
    `/addresses/${address}/transactions?filter=to`,
  );
  if (!data || data.items.length === 0) return null;

  // Blockscout typically returns newest-first; take the oldest inbound value transfer.
  const inbound = data.items
    .filter((tx) => tx.value && tx.value !== "0")
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const first = inbound[0];
  if (!first) return null;

  return {
    fundingSource: first.from.hash as Address,
    fundingTxHash: first.hash,
    fundedAt: new Date(first.timestamp),
  };
}

/**
 * Counts how many contract-creation transactions an address has sent
 * historically — used to backfill "serial deployer" scoring for wallets we
 * haven't been watching since genesis.
 */
export async function countHistoricalDeployments(address: Address): Promise<number> {
  const data = await blockscoutGet<BlockscoutTxListResponse>(
    `/addresses/${address}/transactions?filter=from`,
  );
  if (!data) return 0;
  return data.items.filter((tx) => tx.to === null).length;
}

interface BlockscoutTokenTransfer {
  from: { hash: string };
  to: { hash: string };
  timestamp: string;
  total: { value: string } | null;
  tx_hash: string;
  token?: { address: string; decimals?: string | null; symbol?: string | null } | null;
}

interface BlockscoutTokenTransferListResponse {
  items: BlockscoutTokenTransfer[];
  next_page_params: Record<string, unknown> | null;
}

export interface TokenTransfer {
  from: Address;
  to: Address;
  value: bigint;
  timestamp: Date;
  txHash: string;
}

export interface TokenTransfersResult {
  transfers: TokenTransfer[];
  /** Static per-token metadata read off the first transfer item, if present. */
  decimals: number | null;
  symbol: string | null;
}

interface EtherscanStyleTokenTx {
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  hash: string;
  tokenDecimal?: string;
  tokenSymbol?: string;
  /** Present when the call is by-address rather than by-contractaddress (i.e. any token). */
  contractAddress?: string;
}

interface EtherscanStyleResponse {
  status: string;
  message: string;
  result: EtherscanStyleTokenTx[] | string;
}

// Blockscout paginates both APIs — a single call only ever returns one page
// (commonly 50 items), which was silently starving the investigator down to
// whatever fit in that one page instead of the "first 100 buyers" it's
// supposed to scan. Both fetchers now page through until they've gathered
// `limit` items, the API runs out of pages, or MAX_PAGES is hit (a safety
// cap so a token with a huge transfer history can't turn one investigation
// into dozens of sequential requests).
const MAX_PAGES = 10;
const CLASSIC_PAGE_SIZE = 100;

async function getTokenTransfersClassic(
  tokenAddress: Address,
  limit: number,
): Promise<TokenTransfersResult> {
  const items: EtherscanStyleTokenTx[] = [];

  for (let page = 1; items.length < limit && page <= MAX_PAGES; page++) {
    const data = await blockscoutClassicGet<EtherscanStyleResponse>({
      module: "account",
      action: "tokentx",
      contractaddress: tokenAddress,
      sort: "asc",
      page: String(page),
      offset: String(CLASSIC_PAGE_SIZE),
    });
    if (!data || !Array.isArray(data.result) || data.result.length === 0) break;
    items.push(...data.result);
    if (data.result.length < CLASSIC_PAGE_SIZE) break; // fewer than a full page = last page
  }

  const sliced = items.slice(0, limit);
  return {
    transfers: sliced.map((t) => ({
      from: t.from as Address,
      to: t.to as Address,
      value: BigInt(t.value || "0"),
      timestamp: new Date(Number(t.timeStamp) * 1000),
      txHash: t.hash,
    })),
    decimals: sliced[0]?.tokenDecimal ? Number(sliced[0].tokenDecimal) : null,
    symbol: sliced[0]?.tokenSymbol ?? null,
  };
}

function toQueryString(params: Record<string, unknown>): string {
  const stringParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    stringParams[key] = String(value);
  }
  return new URLSearchParams(stringParams).toString();
}

async function getTokenTransfersV2(tokenAddress: Address, limit: number): Promise<TokenTransfersResult> {
  const items: BlockscoutTokenTransfer[] = [];
  let nextParams: Record<string, unknown> | null = null;

  for (let page = 0; items.length < limit && page < MAX_PAGES; page++) {
    const query: string = nextParams ? `?${toQueryString(nextParams)}` : "";
    const path = `/tokens/${tokenAddress}/transfers${query}`;
    const data: BlockscoutTokenTransferListResponse | null =
      await blockscoutGet<BlockscoutTokenTransferListResponse>(path);
    if (!data || data.items.length === 0) break;
    items.push(...data.items);
    if (!data.next_page_params) break;
    nextParams = data.next_page_params;
  }

  const sliced = items.slice(0, limit);
  const meta = sliced.find((t) => t.token)?.token;

  return {
    transfers: sliced.map((t) => ({
      from: t.from.hash as Address,
      to: t.to.hash as Address,
      value: BigInt(t.total?.value ?? "0"),
      timestamp: new Date(t.timestamp),
      txHash: t.tx_hash,
    })),
    decimals: meta?.decimals ? Number(meta.decimals) : null,
    symbol: meta?.symbol ?? null,
  };
}

/**
 * All ERC-20 Transfer events for a token contract (used to find its
 * buyers). Tries the v2 REST endpoint first; if that comes back empty
 * (wrong path/shape for this Blockscout deployment, or genuinely no
 * transfers), falls back to the classic Etherscan-compatible API most
 * Blockscout instances also expose — a second, differently-shaped
 * endpoint that's more likely to still work if the v2 one doesn't.
 */
export async function getTokenTransfers(tokenAddress: Address, limit = 500): Promise<TokenTransfersResult> {
  const primary = await getTokenTransfersV2(tokenAddress, limit);
  if (primary.transfers.length > 0) return primary;

  logger.warn(
    { tokenAddress },
    "v2 token-transfers endpoint returned no transfers, trying classic API as fallback",
  );
  return getTokenTransfersClassic(tokenAddress, limit);
}

/**
 * Whether `address` has ever received any ERC-20 token OTHER than
 * `tokenAddress` — i.e. `false` here means "this wallet's entire inbound
 * token history is just this one token," the core dev-wallet signal
 * requested: a throwaway wallet created and used to buy exactly one token.
 *
 * Returns `null` when we can't determine this (API call failed, or the
 * wallet's inbound-transfer history looks empty even though we know it
 * received this token — likely an API shape mismatch worth checking against
 * the live Blockscout docs). Checks one page of recent inbound transfers, so
 * a wallet with a long, mixed history might not be fully paged through —
 * treat a `false` result (exclusive to this token) as a strong signal, not
 * absolute proof.
 */
export async function hasOnlyEverReceivedToken(
  address: Address,
  tokenAddress: Address,
): Promise<boolean | null> {
  const data = await blockscoutGet<BlockscoutTokenTransferListResponse>(
    `/addresses/${address}/token-transfers?type=ERC-20&filter=to`,
  );
  if (data && data.items.length > 0) {
    return data.items.every((t) => t.token?.address?.toLowerCase() === tokenAddress.toLowerCase());
  }

  // v2 endpoint gave nothing — fall back to the classic API, filtering to
  // inbound transfers only (tokentx by address returns both directions).
  const classic = await blockscoutClassicGet<EtherscanStyleResponse>({
    module: "account",
    action: "tokentx",
    address,
    sort: "desc",
  });
  if (!classic || !Array.isArray(classic.result) || classic.result.length === 0) return null;

  const inbound = classic.result.filter((t) => t.to?.toLowerCase() === address.toLowerCase());
  if (inbound.length === 0) return null;
  return inbound.every((t) => t.contractAddress?.toLowerCase() === tokenAddress.toLowerCase());
}
