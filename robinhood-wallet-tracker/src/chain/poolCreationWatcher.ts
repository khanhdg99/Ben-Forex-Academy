import { parseAbiItem, type Address, type Hash } from "viem";
import { wsClient } from "./client.js";
import { logger } from "../utils/logger.js";
import { uniswapFactories } from "../config/chain.js";

const pairCreatedEvent = parseAbiItem(
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)",
);
const poolCreatedEvent = parseAbiItem(
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
);

export interface PoolCreatedEvent {
  dex: "uniswap-v2" | "uniswap-v3";
  factory: Address;
  token0: Address;
  token1: Address;
  poolAddress: Address;
  txHash: Hash;
  blockNumber: bigint;
}

export type PoolCreatedHandler = (event: PoolCreatedEvent) => void | Promise<void>;

/**
 * Watches for Uniswap V2 PairCreated / V3 PoolCreated events.
 *
 * We match on the event's topic signature rather than requiring a known
 * factory address, since the exact Robinhood Chain factory addresses aren't
 * hardcoded here (see docs/ROBINHOOD_CHAIN_FACTS.md) — this works chain-wide
 * out of the box. If UNISWAP_V2_FACTORY / UNISWAP_V3_FACTORY are set in
 * .env, we additionally restrict to those addresses to cut down noise from
 * any Uniswap forks/clones that emit the same event shape.
 */
export function watchPoolCreations(onPoolCreated: PoolCreatedHandler) {
  const unwatchV2 = wsClient.watchEvent({
    address: uniswapFactories.v2 as Address | undefined,
    event: pairCreatedEvent,
    onLogs: (logs) => {
      for (const log of logs) {
        const args = log.args as unknown as { token0: Address; token1: Address; pair: Address };
        void onPoolCreated({
          dex: "uniswap-v2",
          factory: log.address,
          token0: args.token0,
          token1: args.token1,
          poolAddress: args.pair,
          txHash: log.transactionHash!,
          blockNumber: log.blockNumber!,
        });
      }
    },
    onError: (error) => logger.error({ err: error, dex: "v2" }, "pool creation watcher error"),
  });

  const unwatchV3 = wsClient.watchEvent({
    address: uniswapFactories.v3 as Address | undefined,
    event: poolCreatedEvent,
    onLogs: (logs) => {
      for (const log of logs) {
        const args = log.args as unknown as { token0: Address; token1: Address; pool: Address };
        void onPoolCreated({
          dex: "uniswap-v3",
          factory: log.address,
          token0: args.token0,
          token1: args.token1,
          poolAddress: args.pool,
          txHash: log.transactionHash!,
          blockNumber: log.blockNumber!,
        });
      }
    },
    onError: (error) => logger.error({ err: error, dex: "v3" }, "pool creation watcher error"),
  });

  return () => {
    unwatchV2();
    unwatchV3();
  };
}
