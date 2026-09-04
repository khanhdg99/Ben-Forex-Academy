import type { Address, Hex } from "viem";
import { httpClient } from "./client.js";
import { ERC20_SELECTORS } from "./eventSignatures.js";

/**
 * Crude but fast heuristic: a contract "looks like" ERC-20/memecoin template
 * code if its deployed bytecode contains the 4-byte selectors for the core
 * ERC-20 methods. False positives are possible (any contract embedding these
 * selectors matches) — this is a cheap first filter, not proof; the scoring
 * engine treats it as one signal among several, not a verdict.
 */
export async function looksLikeErc20(address: Address): Promise<boolean> {
  const bytecode = await httpClient.getBytecode({ address });
  if (!bytecode || bytecode === "0x") return false;
  return matchesErc20Bytecode(bytecode);
}

export function matchesErc20Bytecode(bytecode: Hex): boolean {
  const code = bytecode.toLowerCase();
  const requiredSelectors = [
    ERC20_SELECTORS.transfer,
    ERC20_SELECTORS.transferFrom,
    ERC20_SELECTORS.approve,
    ERC20_SELECTORS.balanceOf,
    ERC20_SELECTORS.totalSupply,
  ];
  return requiredSelectors.every((selector) => code.includes(selector.slice(2)));
}
