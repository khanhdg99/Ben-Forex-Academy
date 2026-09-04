import type { Address, Hash } from "viem";
import { wsClient, httpClient } from "./client.js";
import { logger } from "../utils/logger.js";
import { matchesErc20Bytecode } from "./erc20Heuristics.js";

export interface ContractCreationEvent {
  deployer: Address;
  contractAddress: Address;
  txHash: Hash;
  blockNumber: bigint;
  timestamp: bigint;
  looksLikeErc20: boolean;
}

export type ContractCreationHandler = (event: ContractCreationEvent) => void | Promise<void>;

/**
 * Watches every new block for contract-creation transactions (`to === null`),
 * resolves the deployed address + bytecode, and reports ones that look like
 * ERC-20/memecoin templates.
 *
 * Note: this pulls full transaction bodies per block (`includeTransactions:
 * true`), which is heavier than the plain block listener — fine at Robinhood
 * Chain's current throughput, but worth revisiting (e.g. batched log-based
 * detection) if the chain gets busy.
 */
export function watchContractCreations(onCreate: ContractCreationHandler) {
  const unwatch = wsClient.watchBlocks({
    includeTransactions: true,
    onBlock: (block) => {
      const creationTxs = block.transactions.filter((tx) => tx.to === null);
      if (creationTxs.length === 0) return;

      for (const tx of creationTxs) {
        void (async () => {
          try {
            const receipt = await httpClient.getTransactionReceipt({ hash: tx.hash });
            if (!receipt.contractAddress) return;

            const bytecode = await httpClient.getBytecode({ address: receipt.contractAddress });
            const erc20Like = !!bytecode && bytecode !== "0x" && matchesErc20Bytecode(bytecode);

            await onCreate({
              deployer: tx.from,
              contractAddress: receipt.contractAddress,
              txHash: tx.hash,
              blockNumber: block.number,
              timestamp: block.timestamp,
              looksLikeErc20: erc20Like,
            });
          } catch (err) {
            logger.error({ err, txHash: tx.hash }, "failed to process contract creation tx");
          }
        })();
      }
    },
    onError: (error) => logger.error({ err: error }, "contract creation watcher error"),
  });

  return unwatch;
}
