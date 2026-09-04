import { createPublicClient, http, webSocket } from "viem";
import { robinhoodChain } from "../config/chain.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/** HTTP client — used for one-off reads (receipts, bytecode, historical logs). */
export const httpClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(env.RPC_HTTP_URL),
});

/**
 * Realtime client — used for subscriptions (new blocks, logs).
 *
 * If RPC_WS_URL is set, uses a real WebSocket subscription (near-instant
 * push, needs a provider that supports it — e.g. Alchemy). If it's left
 * blank, falls back to HTTP polling on `httpClient`'s endpoint instead: no
 * API key required, at the cost of `POLL_INTERVAL_MS` (default 1s) of
 * latency instead of true push. viem's `watchBlocks`/`watchEvent` handle
 * this transparently via the `poll`/`pollingInterval` options — the calling
 * code doesn't need to know which mode is active.
 *
 * Robinhood Chain's public RPC (rpc.mainnet.chain.robinhood.com) was
 * confirmed live over HTTP (chain ID 4663, real block numbers) but its
 * WebSocket endpoint failed in testing — polling mode is the safe default
 * against it. See docs/ROBINHOOD_CHAIN_FACTS.md.
 */
const usingWebSocket = env.RPC_WS_URL.length > 0;

if (usingWebSocket) {
  logger.info({ ws: env.RPC_WS_URL }, "realtime mode: WebSocket");
} else {
  logger.info(
    { pollIntervalMs: env.POLL_INTERVAL_MS },
    "realtime mode: HTTP polling (set RPC_WS_URL in .env for push-based updates)",
  );
}

export const wsClient = createPublicClient({
  chain: robinhoodChain,
  transport: usingWebSocket ? webSocket(env.RPC_WS_URL) : http(env.RPC_HTTP_URL),
  pollingInterval: env.POLL_INTERVAL_MS,
});
