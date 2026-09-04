import type { Address } from "viem";
import { watchContractCreations } from "../chain/contractCreationWatcher.js";
import { watchPoolCreations } from "../chain/poolCreationWatcher.js";
import { watchPoolActivity, getReserves } from "../chain/liquidityWatcher.js";
import { watchValueTransfers } from "../chain/valueTransferWatcher.js";
import { httpClient } from "../chain/client.js";
import {
  enqueueDeployment,
  enqueuePoolCreated,
  enqueueInitialBuy,
  enqueueRug,
  enqueueFundingTransfer,
} from "../queue/producer.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";

/**
 * Recently-seen deployments kept in memory so a pool-creation event can be
 * correlated with "was this token deployed by someone we're tracking?"
 * without waiting on the (async, queued) DB write to land first — deployment
 * and pool creation frequently happen in the same block or even the same
 * transaction (V2 addLiquidityETH auto-creates the pair).
 *
 * Entries expire after 24h; a token whose pool appears later than that is
 * simply not correlated to its deployer by this in-memory path (the queue
 * worker's DB-backed lookup in handlePoolCreated still works for anything
 * already persisted).
 */
const pendingDeployments = new Map<string, { deployer: Address; deployedAt: number }>();
const DEPLOYMENT_TTL_MS = 24 * 60 * 60 * 1000;

function trackDeployment(tokenAddress: Address, deployer: Address) {
  pendingDeployments.set(tokenAddress.toLowerCase(), { deployer, deployedAt: Date.now() });
  setTimeout(() => pendingDeployments.delete(tokenAddress.toLowerCase()), DEPLOYMENT_TTL_MS).unref();
}

/** Pools currently under active surveillance for the initial-buy / rug windows. */
const activePools = new Set<string>();

function startPoolSurveillance(params: {
  poolAddress: Address;
  tokenAddress: Address;
  tokenIsToken0: boolean;
  poolCreatedAt: number;
}) {
  const key = params.poolAddress.toLowerCase();
  if (activePools.has(key)) return;
  activePools.add(key);

  const windowMs =
    Math.max(env.INITIAL_BUY_WINDOW_MINUTES, env.RUG_WINDOW_MINUTES) * 60_000;

  const stop = watchPoolActivity(params.poolAddress, {
    onSwap: async (swap) => {
      const minutesAfter = (Date.now() - params.poolCreatedAt) / 60_000;
      if (minutesAfter > env.INITIAL_BUY_WINDOW_MINUTES) return;

      // Amount of the tracked token flowing OUT of the pool (i.e. bought by `to`).
      const tokenOut = params.tokenIsToken0 ? swap.amount0Out : swap.amount1Out;
      if (tokenOut === 0n) return; // this swap sold the token in, not bought it out

      try {
        const reserves = await getReserves(params.poolAddress);
        const reserveOfToken = params.tokenIsToken0 ? reserves.reserve0 : reserves.reserve1;
        const reserveBefore = reserveOfToken + tokenOut; // reserve *before* this swap removed tokenOut
        if (reserveBefore === 0n) return;
        const sizePct = Number(tokenOut) / Number(reserveBefore);

        await enqueueInitialBuy({
          tokenAddress: params.tokenAddress,
          poolAddress: params.poolAddress,
          buyer: swap.to,
          txHash: swap.txHash,
          occurredAtIso: new Date().toISOString(),
          sizePct,
          minutesAfterPoolCreation: minutesAfter,
        });
      } catch (err) {
        logger.error({ err, pool: params.poolAddress }, "failed to size initial buy");
      }
    },
    onBurn: async (burn) => {
      const minutesAfter = (Date.now() - params.poolCreatedAt) / 60_000;
      if (minutesAfter > env.RUG_WINDOW_MINUTES) return;

      const tokenRemoved = params.tokenIsToken0 ? burn.amount0 : burn.amount1;
      if (tokenRemoved === 0n) return;

      try {
        const reserves = await getReserves(params.poolAddress);
        const reserveOfToken = params.tokenIsToken0 ? reserves.reserve0 : reserves.reserve1;
        const reserveBefore = reserveOfToken + tokenRemoved;
        if (reserveBefore === 0n) return;
        const removedPct = Number(tokenRemoved) / Number(reserveBefore);

        await enqueueRug({
          tokenAddress: params.tokenAddress,
          poolAddress: params.poolAddress,
          actor: burn.to,
          txHash: burn.txHash,
          occurredAtIso: new Date().toISOString(),
          removedPct,
          minutesAfterPoolCreation: minutesAfter,
        });
      } catch (err) {
        logger.error({ err, pool: params.poolAddress }, "failed to size liquidity removal");
      }
    },
  });

  setTimeout(() => {
    stop();
    activePools.delete(key);
  }, windowMs).unref();
}

/** Wires the chain watchers to the queue + starts per-pool surveillance windows. */
export function startPipeline() {
  const stopContractWatcher = watchContractCreations((event) => {
    if (!event.looksLikeErc20) return;

    trackDeployment(event.contractAddress, event.deployer);

    void enqueueDeployment({
      deployer: event.deployer,
      tokenAddress: event.contractAddress,
      deployTxHash: event.txHash,
      deployedAtIso: new Date(Number(event.timestamp) * 1000).toISOString(),
      looksLikeErc20: event.looksLikeErc20,
    });

    logger.info(
      { deployer: event.deployer, token: event.contractAddress },
      "tracked new ERC-20-like deployment",
    );
  });

  const stopPoolWatcher = watchPoolCreations((event) => {
    const t0 = pendingDeployments.get(event.token0.toLowerCase());
    const t1 = pendingDeployments.get(event.token1.toLowerCase());
    const match = t0
      ? { tokenAddress: event.token0, tokenIsToken0: true, info: t0 }
      : t1
        ? { tokenAddress: event.token1, tokenIsToken0: false, info: t1 }
        : null;

    if (!match) return; // pool for a token we're not tracking as a fresh deployment

    void enqueuePoolCreated({
      dex: event.dex,
      poolAddress: event.poolAddress,
      tokenAddress: match.tokenAddress,
      createdBy: match.info.deployer,
      createdTxHash: event.txHash,
      createdAtIso: new Date().toISOString(),
    });

    startPoolSurveillance({
      poolAddress: event.poolAddress,
      tokenAddress: match.tokenAddress,
      tokenIsToken0: match.tokenIsToken0,
      poolCreatedAt: Date.now(),
    });

    logger.info(
      { pool: event.poolAddress, token: match.tokenAddress, dex: event.dex },
      "pool created for tracked deployment — starting surveillance window",
    );
  });

  const stopValueTransferWatcher = watchValueTransfers((event) => {
    void enqueueFundingTransfer({
      from: event.from,
      to: event.to,
      txHash: event.txHash,
      valueWei: event.valueWei.toString(),
      occurredAtIso: new Date(Number(event.timestamp) * 1000).toISOString(),
    });
  });

  logger.info(
    { chainId: httpClient.chain?.id },
    "pipeline started: watching contract creations + pool creations + value transfers",
  );

  return () => {
    stopContractWatcher();
    stopPoolWatcher();
    stopValueTransferWatcher();
  };
}
