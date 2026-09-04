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
