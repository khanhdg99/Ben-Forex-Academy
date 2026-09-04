import { parseAbiItem, type Address, type Hash } from "viem";
import { wsClient, httpClient } from "./client.js";
import { logger } from "../utils/logger.js";

const swapV2Event = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)",
);
const burnV2Event = parseAbiItem(
  "event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)",
);

export interface SwapV2Event {
  pool: Address;
  sender: Address;
  to: Address;
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
  txHash: Hash;
  blockNumber: bigint;
}

export interface BurnV2Event {
  pool: Address;
  sender: Address;
  to: Address;
  amount0: bigint;
  amount1: bigint;
  txHash: Hash;
  blockNumber: bigint;
}

/**
 * Watches a single Uniswap V2-style pair for Swap and Burn events, for as
 * long as `stop()` isn't called. Intended to be started right after a
 * PairCreated event for a token we care about, and stopped after the
 * detection windows (initial-buy window, rug window) close — we don't want
 * to keep an open subscription per pool forever.
 */
export function watchPoolActivity(
  pool: Address,
  handlers: {
    onSwap?: (event: SwapV2Event) => void | Promise<void>;
    onBurn?: (event: BurnV2Event) => void | Promise<void>;
  },
) {
  const unwatchSwap = wsClient.watchEvent({
    address: pool,
    event: swapV2Event,
    onLogs: (logs) => {
      for (const log of logs) {
        void handlers.onSwap?.({
          pool,
          sender: log.args.sender!,
          to: log.args.to!,
          amount0In: log.args.amount0In!,
          amount1In: log.args.amount1In!,
          amount0Out: log.args.amount0Out!,
          amount1Out: log.args.amount1Out!,
          txHash: log.transactionHash!,
          blockNumber: log.blockNumber!,
        });
      }
    },
    onError: (error) => logger.error({ err: error, pool }, "swap watcher error"),
  });

  const unwatchBurn = wsClient.watchEvent({
    address: pool,
    event: burnV2Event,
    onLogs: (logs) => {
      for (const log of logs) {
        void handlers.onBurn?.({
          pool,
          sender: log.args.sender!,
          to: log.args.to!,
          amount0: log.args.amount0!,
          amount1: log.args.amount1!,
          txHash: log.transactionHash!,
          blockNumber: log.blockNumber!,
        });
      }
    },
    onError: (error) => logger.error({ err: error, pool }, "burn watcher error"),
  });

  return () => {
    unwatchSwap();
    unwatchBurn();
  };
}

/** Current token reserves held by a Uniswap V2-style pool, for sizing swaps/burns as a %. */
export async function getReserves(pool: Address): Promise<{ reserve0: bigint; reserve1: bigint }> {
  const [reserve0, reserve1] = (await httpClient.readContract({
    address: pool,
    abi: [
      {
        name: "getReserves",
        type: "function",
        stateMutability: "view",
        inputs: [],
        outputs: [
          { name: "reserve0", type: "uint112" },
          { name: "reserve1", type: "uint112" },
          { name: "blockTimestampLast", type: "uint32" },
        ],
      },
    ],
    functionName: "getReserves",
  })) as [bigint, bigint, number];

  return { reserve0, reserve1 };
}
