import { createPublicClient, http, webSocket, fallback } from "viem";
import { robinhoodChain } from "../config/chain.js";
import { env } from "../config/env.js";

/** HTTP client — used for one-off reads (receipts, bytecode, historical logs). */
export const httpClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(env.RPC_HTTP_URL),
});

/**
 * WebSocket client — used for realtime subscriptions (new blocks, logs).
 * Falls back to HTTP polling automatically if the WS endpoint is unreachable,
 * since viem's `watchBlocks`/`watchEvent` fall back to polling transparently
 * when given an http-only transport. We keep them as separate clients so a
 * flaky WS connection doesn't take down one-off reads.
 */
export const wsClient = createPublicClient({
  chain: robinhoodChain,
  transport: fallback([webSocket(env.RPC_WS_URL), http(env.RPC_HTTP_URL)]),
});
