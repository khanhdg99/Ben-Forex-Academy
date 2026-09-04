import { toEventSelector } from "viem";

/**
 * topic0 hashes computed from human-readable event signatures (not hardcoded
 * from memory) so they're correct regardless of chain — these signatures are
 * standard across every Uniswap V2/V3 fork and don't change per-deployment.
 */
export const PAIR_CREATED_TOPIC = toEventSelector(
  "PairCreated(address,address,address,uint256)",
);
export const POOL_CREATED_TOPIC = toEventSelector(
  "PoolCreated(address,address,uint24,int24,address)",
);
export const SWAP_V2_TOPIC = toEventSelector(
  "Swap(address,uint256,uint256,uint256,uint256,address)",
);
export const SWAP_V3_TOPIC = toEventSelector(
  "Swap(address,address,int256,int256,uint160,uint128,int24)",
);
export const MINT_V2_TOPIC = toEventSelector("Mint(address,uint256,uint256)");
export const BURN_V2_TOPIC = toEventSelector("Burn(address,uint256,uint256,address)");
export const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");

/** 4-byte function selectors used for lightweight ERC-20 bytecode heuristics. */
export const ERC20_SELECTORS: Record<string, string> = {
  totalSupply: "0x18160ddd",
  balanceOf: "0x70a08231",
  transfer: "0xa9059cbb",
  transferFrom: "0x23b872dd",
  approve: "0x095ea7b3",
  allowance: "0xdd62ed3e",
};

/** Router function selectors commonly used to seed initial liquidity. */
export const ADD_LIQUIDITY_SELECTORS: Record<string, string> = {
  addLiquidity: "0xe8e33700",
  addLiquidityETH: "0xf305d719",
};
