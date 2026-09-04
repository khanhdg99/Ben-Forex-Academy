import type { Address } from "viem";
import {
  recordTokenDeployment,
  recordLiquidityEvent,
  upsertWallet,
  countFundingSourceReuse,
  getWalletHistory,
  saveRiskScore,
} from "../db/repositories.js";
import { findFundingSource } from "../chain/blockscoutClient.js";
import { scoreDeploymentCase } from "../detection/scoring.js";
import type { DeploymentCase } from "../detection/types.js";
import { maybeAddToWatchlist, isWatchlisted } from "../watchlist/watchlistManager.js";
import { sendRiskAlert, sendWatchlistReactivationAlert } from "../alerts/telegram.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type {
  DeploymentJobData,
  PoolCreatedJobData,
  InitialBuyJobData,
  RugJobData,
} from "../queue/types.js";
import { prisma } from "../db/prisma.js";

async function buildBaseCase(tokenAddress: Address): Promise<DeploymentCase | null> {
  const deployment = await prisma.tokenDeployment.findUnique({
    where: { tokenAddress: tokenAddress.toLowerCase() },
    include: { deployer: true, liquidityEvents: true },
  });
  if (!deployment) return null;

  const walletHistory = await getWalletHistory(
    deployment.deployerAddress as Address,
    tokenAddress,
  );
  const wallet = deployment.deployer;

  const poolCreated = deployment.liquidityEvents.find((e) => e.type === "POOL_CREATED");
  const initialBuy = deployment.liquidityEvents.find((e) => e.type === "INITIAL_BUY");
  const rug = deployment.liquidityEvents.find((e) => e.type === "LIQUIDITY_REMOVED");

  return {
    deployment: {
      deployer: deployment.deployerAddress as Address,
      tokenAddress: deployment.tokenAddress as Address,
      deployTxHash: deployment.deployTxHash as `0x${string}`,
      deployedAt: deployment.deployedAt,
    },
    looksLikeErc20: deployment.looksLikeErc20,
    funding: wallet.fundingSource
      ? {
          fundingSource: wallet.fundingSource as Address,
          fundedAt: wallet.fundedAt ?? new Date(),
          reuseCount: Math.max(0, (await countFundingSourceReuse(wallet.fundingSource as Address)) - 1),
        }
      : undefined,
    walletHistory,
    pool: poolCreated
      ? {
          dex: (poolCreated.dex as "uniswap-v2" | "uniswap-v3") ?? "uniswap-v2",
          poolAddress: (poolCreated.poolAddress ?? "0x") as Address,
          tokenAddress: deployment.tokenAddress as Address,
          createdAt: poolCreated.occurredAt,
          createdTxHash: poolCreated.txHash as `0x${string}`,
          createdBy: poolCreated.actorAddress as Address,
        }
      : undefined,
    initialBuy: initialBuy
      ? {
          buyer: initialBuy.actorAddress as Address,
          txHash: initialBuy.txHash as `0x${string}`,
          occurredAt: initialBuy.occurredAt,
          sizePct: initialBuy.amountPct ?? 0,
          minutesAfterPoolCreation: initialBuy.minutesAfterPool ?? 0,
        }
      : undefined,
    rug: rug
      ? {
          txHash: rug.txHash as `0x${string}`,
          occurredAt: rug.occurredAt,
          removedPct: rug.amountPct ?? 0,
          minutesAfterPoolCreation: rug.minutesAfterPool ?? 0,
        }
      : undefined,
  };
}

/** Recomputes the risk score for a token deployment and fans out to watchlist + alerts. */
async function rescoreAndNotify(tokenAddress: Address) {
  const deployCase = await buildBaseCase(tokenAddress);
  if (!deployCase) return;

  const result = scoreDeploymentCase(deployCase);
  await saveRiskScore(result);

  const newlyWatchlisted = await maybeAddToWatchlist(
    result.wallet,
    result.score,
    `Score ${result.score} on token ${result.tokenAddress}`,
  );

  if (newlyWatchlisted || result.score >= env.ALERT_SCORE_THRESHOLD) {
    await sendRiskAlert(result);
  } else if (await isWatchlisted(result.wallet)) {
    await sendWatchlistReactivationAlert(
      result.wallet,
      `New activity on token ${result.tokenAddress} (score ${result.score})`,
    );
  }

  logger.info(
    { wallet: result.wallet, token: result.tokenAddress, score: result.score },
    "risk score updated",
  );
}

export async function handleDeployment(data: DeploymentJobData) {
  const deployer = data.deployer as Address;
  const tokenAddress = data.tokenAddress as Address;

  await recordTokenDeployment({
    tokenAddress,
    deployerAddress: deployer,
    deployTxHash: data.deployTxHash,
    deployedAt: new Date(data.deployedAtIso),
    looksLikeErc20: data.looksLikeErc20,
  });

  const funding = await findFundingSource(deployer);
  if (funding) {
    await upsertWallet(deployer, {
      fundingSource: funding.fundingSource,
      fundingTxHash: funding.fundingTxHash,
      fundedAt: funding.fundedAt,
    });
  }

  await rescoreAndNotify(tokenAddress);
}

export async function handlePoolCreated(data: PoolCreatedJobData) {
  const tokenAddress = data.tokenAddress as Address;

  const persisted = await recordLiquidityEvent({
    tokenAddress,
    type: "POOL_CREATED",
    dex: data.dex,
    poolAddress: data.poolAddress as Address,
    actorAddress: data.createdBy as Address,
    txHash: data.createdTxHash,
    occurredAt: new Date(data.createdAtIso),
    minutesAfterPool: 0,
  });

  if (!persisted) {
    logger.warn({ tokenAddress }, "pool-created job for unknown token deployment, skipping");
    return;
  }

  await rescoreAndNotify(tokenAddress);
}

export async function handleInitialBuy(data: InitialBuyJobData) {
  const tokenAddress = data.tokenAddress as Address;

  const persisted = await recordLiquidityEvent({
    tokenAddress,
    type: "INITIAL_BUY",
    poolAddress: data.poolAddress as Address,
    actorAddress: data.buyer as Address,
    txHash: data.txHash,
    occurredAt: new Date(data.occurredAtIso),
    amountPct: data.sizePct,
    minutesAfterPool: data.minutesAfterPoolCreation,
  });
  if (!persisted) return;

  await rescoreAndNotify(tokenAddress);
}

export async function handleRug(data: RugJobData) {
  const tokenAddress = data.tokenAddress as Address;

  const persisted = await recordLiquidityEvent({
    tokenAddress,
    type: "LIQUIDITY_REMOVED",
    poolAddress: data.poolAddress as Address,
    actorAddress: data.actor as Address,
    txHash: data.txHash,
    occurredAt: new Date(data.occurredAtIso),
    amountPct: data.removedPct,
    minutesAfterPool: data.minutesAfterPoolCreation,
  });
  if (!persisted) return;

  await prisma.wallet.update({
    where: { address: data.actor.toLowerCase() },
    data: { priorRugs: { increment: 1 } },
  }).catch(() => undefined);

  await rescoreAndNotify(tokenAddress);
}
