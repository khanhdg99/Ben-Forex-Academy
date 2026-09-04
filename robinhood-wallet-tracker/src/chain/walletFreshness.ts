import type { Address } from "viem";
import { httpClient } from "./client.js";

/**
 * A wallet counts as "fresh" (ví mới cứng) if it has never sent a
 * transaction — its nonce is 0. This is the standard on-chain heuristic for
 * "just-created burner wallet, only used to receive funds so far," and is
 * what makes a funding fan-out (1 source -> many such wallets) a strong
 * signal: real, organic wallets don't cluster like this.
 */
export async function isFreshWallet(address: Address): Promise<boolean> {
  const nonce = await httpClient.getTransactionCount({ address });
  return nonce === 0;
}
