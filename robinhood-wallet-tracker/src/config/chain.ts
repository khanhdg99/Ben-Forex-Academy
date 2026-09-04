import type { Chain } from "viem";
import { env } from "./env.js";

/**
 * Robinhood Chain network definition for viem.
 *
 * Values verified via public sources as of Sept 2026 (see docs/ROBINHOOD_CHAIN_FACTS.md
 * for sources) — RE-VERIFY against https://docs.robinhood.com/chain/connecting before
 * relying on this for anything production-critical, since RPC/explorer details for a
 * young chain can change.
 */
export const robinhoodChain: Chain = {
  id: env.CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [env.RPC_HTTP_URL], webSocket: [env.RPC_WS_URL] },
  },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
  testnet: false,
};

/**
 * Known Uniswap factory addresses to restrict pool-creation watching to.
 * Leave empty in .env to watch PairCreated/PoolCreated by event signature
 * chain-wide instead (recommended until these are confirmed from
 * https://docs.robinhood.com/chain/protocol-contracts).
 */
export const uniswapFactories = {
  v2: env.UNISWAP_V2_FACTORY || undefined,
  v3: env.UNISWAP_V3_FACTORY || undefined,
};
