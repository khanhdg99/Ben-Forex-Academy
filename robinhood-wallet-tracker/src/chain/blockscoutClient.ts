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

async function blockscoutGet<T>(path: string): Promise<T | null> {
  const url = `${env.BLOCKSCOUT_API_BASE}${path}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "blockscout API request failed");
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ err, url }, "blockscout API request errored");
    return null;
  }
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

/** All ERC-20 Transfer events for a token contract (used to find its buyers). */
export async function getTokenTransfers(tokenAddress: Address, limit = 300): Promise<TokenTransfersResult> {
  const data = await blockscoutGet<BlockscoutTokenTransferListResponse>(
    `/tokens/${tokenAddress}/transfers`,
  );
  if (!data) return { transfers: [], decimals: null, symbol: null };

  const items = data.items.slice(0, limit);
  const meta = items.find((t) => t.token)?.token;

  return {
    transfers: items.map((t) => ({
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
  if (!data || data.items.length === 0) return null;
  return data.items.every(
    (t) => t.token?.address?.toLowerCase() === tokenAddress.toLowerCase(),
  );
}
