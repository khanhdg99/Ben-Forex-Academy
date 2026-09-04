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

const minValueWei = parseEther(env.FANOUT_MIN_VALUE_ETH.toString());

/**
 * Watches every new block for plain native-ETH transfers (`to !== null`,
 * `value > 0`) worth at least FANOUT_MIN_VALUE_ETH — the raw signal for
 * detecting "1 wallet funds many brand-new wallets" fan-out patterns
 * (src/pipeline/handlers.ts's handleFundingTransfer does the fresh-wallet
 * check + cluster detection). Dust transfers below the threshold are
 * skipped here to avoid flooding the pipeline with noise.
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
        if (tx.to !== null && tx.value >= minValueWei) {
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
