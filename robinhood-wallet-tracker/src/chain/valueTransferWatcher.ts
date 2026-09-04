import { parseEther, type Address, type Hash } from "viem";
import { wsClient } from "./client.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

export interface ValueTransferEvent {
  from: Address;
  to: Address;
  valueWei: bigint;
  txHash: Hash;
  blockNumber: bigint;
  timestamp: bigint;
}

export type ValueTransferHandler = (event: ValueTransferEvent) => void | Promise<void>;

// 0 (the default) means no minimum at all — every value transfer is
// scanned, since bridge deposits from other chains into Robinhood Chain
// can land as small/odd amounts that a fixed dust filter would silently
// drop. Set FANOUT_MIN_VALUE_ETH > 0 only if real noise becomes a problem.
const minValueWei = env.FANOUT_MIN_VALUE_ETH > 0 ? parseEther(env.FANOUT_MIN_VALUE_ETH.toString()) : 0n;

/**
 * Watches every new block for plain native-ETH transfers (`to !== null`,
 * `value > 0`) — the raw signal for detecting "1 wallet funds many other
 * wallets" fan-out patterns (src/pipeline/handlers.ts's
 * handleFundingTransfer does the fresh-wallet check + cluster detection).
 * This also picks up cross-chain bridge deposits landing on Robinhood
 * Chain: those arrive as ordinary L2 transactions with a nonzero `value`,
 * so no special-casing is needed beyond not filtering by amount.
 *
 * This runs its own `watchBlocks` subscription alongside
 * contractCreationWatcher's — a known small inefficiency (both re-fetch
 * full block bodies) that's fine at this bot's scale; worth consolidating
 * into one shared block scanner if RPC usage ever becomes a concern.
 */
export function watchValueTransfers(onTransfer: ValueTransferHandler) {
  const unwatch = wsClient.watchBlocks({
    includeTransactions: true,
    onBlock: (block) => {
      for (const tx of block.transactions) {
        if (tx.to !== null && tx.value > 0n && tx.value >= minValueWei) {
          void onTransfer({
            from: tx.from,
            to: tx.to,
            valueWei: tx.value,
            txHash: tx.hash,
            blockNumber: block.number,
            timestamp: block.timestamp,
          });
        }
      }
    },
    onError: (error) => logger.error({ err: error }, "value transfer watcher error"),
  });
  return unwatch;
}
