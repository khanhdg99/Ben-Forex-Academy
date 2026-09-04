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
import { isFreshWallet } from "../chain/walletFreshness.js";
import { scoreDeploymentCase } from "../detection/scoring.js";
import type { DeploymentCase } from "../detection/types.js";
import { maybeAddToWatchlist, isWatchlisted } from "../watchlist/watchlistManager.js";
import {
  sendRiskAlert,
  sendWatchlistReactivationAlert,
  sendClusterAlert,
  sendClusterBuyAlert,
} from "../alerts/telegram.js";
import {
  recordFundingTransfer,
  detectFundingBurst,
  upsertFundingCluster,
  findClusterForWallet,
} from "../db/fundingRepository.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type {
  DeploymentJobData,
  PoolCreatedJobData,
  InitialBuyJobData,
  RugJobData,
  FundingTransferJobData,
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
  const buyer = data.buyer as Address;

  const persisted = await recordLiquidityEvent({
    tokenAddress,
    type: "INITIAL_BUY",
    poolAddress: data.poolAddress as Address,
    actorAddress: buyer,
    txHash: data.txHash,
    occurredAt: new Date(data.occurredAtIso),
    amountPct: data.sizePct,
    minutesAfterPool: data.minutesAfterPoolCreation,
  });
  if (!persisted) return;

  await rescoreAndNotify(tokenAddress);

  // Copy-trade signal: is the buyer a wallet that was freshly funded by a
  // known fan-out cluster (see handleFundingTransfer)? If so, this is
  // exactly the "cluster wallet buying a new listing" moment worth acting
  // on fast, independent of the deployer's own risk score.
  const cluster = await findClusterForWallet(buyer);
  if (cluster) {
    await sendClusterBuyAlert({
      buyer,
      tokenAddress,
      poolAddress: data.poolAddress,
      sizePct: data.sizePct,
      clusterSource: cluster.sourceAddress,
    });
  }
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

/**
 * Persists a native-ETH transfer and checks whether the sender has now
 * fanned out to enough wallets within a tight time burst to count as a
 * "wallet cluster" — either a single funder spinning up a batch of
 * brand-new burner wallets (a dev prepping sybil buyers, or a multi-wallet
 * sniper worth copy-trading via their sub-wallets), or an exchange/bridge
 * wallet fanning the same amount out to several wallets one person
 * controls (which may not be brand-new themselves).
 */
export async function handleFundingTransfer(data: FundingTransferJobData) {
  const from = data.from as Address;
  const to = data.to as Address;

  const fresh = await isFreshWallet(to);

  await recordFundingTransfer({
    from,
    to,
    txHash: data.txHash,
    valueWei: BigInt(data.valueWei),
    occurredAt: new Date(data.occurredAtIso),
    toWasFreshWallet: fresh,
  });

  if (fresh) {
    // So this sub-wallet shows up as a checkable entity on the dashboard
    // even before its funder crosses the cluster threshold.
    await upsertWallet(to);
  }

  const burst = await detectFundingBurst(from);
  if (!burst) return;

  const { grew } = await upsertFundingCluster(from, burst.members.length, burst.matchType);
  if (!grew) return;

  logger.info(
    { source: from, memberCount: burst.members.length, matchType: burst.matchType },
    "funding fan-out cluster detected",
  );
  await sendClusterAlert(from, burst.members, burst.matchType);
}
