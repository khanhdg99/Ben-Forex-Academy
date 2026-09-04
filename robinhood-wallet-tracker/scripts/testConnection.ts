/**
 * Step 1 deliverable: confirm we can reach Robinhood Chain over HTTP + WS
 * and stream new blocks in real time.
 *
 * Run with: npm run step1:test-connection
 */
import { httpClient } from "../src/chain/client.js";
import { watchNewBlocks } from "../src/chain/blockListener.js";
import { env } from "../src/config/env.js";
import { logger } from "../src/utils/logger.js";

async function main() {
  logger.info({ chainId: env.CHAIN_ID, rpc: env.RPC_HTTP_URL }, "testing HTTP connection...");

  const [chainId, blockNumber] = await Promise.all([
    httpClient.getChainId(),
    httpClient.getBlockNumber(),
  ]);

  logger.info({ chainId, blockNumber: blockNumber.toString() }, "HTTP connection OK");

  if (chainId !== env.CHAIN_ID) {
    logger.warn(
      { expected: env.CHAIN_ID, actual: chainId },
      "chain ID mismatch — double check CHAIN_ID / RPC_HTTP_URL in .env against " +
        "https://docs.robinhood.com/chain/connecting",
    );
  }

  logger.info({ ws: env.RPC_WS_URL }, "subscribing to new blocks over WebSocket...");

  let count = 0;
  watchNewBlocks((blockNumber, timestamp) => {
    count += 1;
    const ageSeconds = Math.floor(Date.now() / 1000) - Number(timestamp);
    logger.info({ blockNumber: blockNumber.toString(), ageSeconds, count }, "new block");
  });

  logger.info("listening... press Ctrl+C to stop");
}

main().catch((err) => {
  logger.error({ err }, "step1 connection test failed");
  process.exit(1);
});
