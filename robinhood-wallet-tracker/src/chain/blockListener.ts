import { wsClient } from "./client.js";
import { logger } from "../utils/logger.js";

export type NewBlockHandler = (blockNumber: bigint, timestamp: bigint) => void | Promise<void>;

/**
 * Subscribes to new blocks on Robinhood Chain and invokes `onBlock` for each.
 * This is deliberately the thinnest possible listener (Step 1 deliverable):
 * prove we can connect and see blocks land in near-real-time before layering
 * any detection logic on top.
 */
export function watchNewBlocks(onBlock: NewBlockHandler) {
  const unwatch = wsClient.watchBlocks({
    onBlock: (block) => {
      logger.debug({ number: block.number, hash: block.hash }, "new block");
      void onBlock(block.number, block.timestamp);
    },
    onError: (error) => {
      logger.error({ err: error }, "block watcher error");
    },
  });
  return unwatch;
}
