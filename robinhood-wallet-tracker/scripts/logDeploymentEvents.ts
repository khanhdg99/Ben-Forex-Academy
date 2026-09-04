/**
 * Step 2 deliverable: print contract-creation transactions (that look
 * ERC-20-like) and Uniswap PairCreated/PoolCreated events as they happen.
 *
 * Run with: npm run step2:log-events
 */
import { watchContractCreations } from "../src/chain/contractCreationWatcher.js";
import { watchPoolCreations } from "../src/chain/poolCreationWatcher.js";
import { logger } from "../src/utils/logger.js";

watchContractCreations((event) => {
  if (!event.looksLikeErc20) return;
  logger.info(
    {
      deployer: event.deployer,
      contract: event.contractAddress,
      tx: event.txHash,
      block: event.blockNumber.toString(),
    },
    "ERC-20-like contract deployed",
  );
});

watchPoolCreations((event) => {
  logger.info(
    {
      dex: event.dex,
      factory: event.factory,
      pool: event.poolAddress,
      token0: event.token0,
      token1: event.token1,
      tx: event.txHash,
      block: event.blockNumber.toString(),
    },
    "liquidity pool created",
  );
});

logger.info("watching for deployments + pool creations... press Ctrl+C to stop");
