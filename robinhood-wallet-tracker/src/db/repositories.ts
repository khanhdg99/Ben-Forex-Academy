import type { Address } from "viem";
import { prisma } from "./prisma.js";
import type { RiskScoreResult } from "../detection/types.js";

export async function upsertWallet(
  address: Address,
  fields: Partial<{
    fundingSource: string;
    fundingTxHash: string;
    fundedAt: Date;
  }> = {},
) {
  return prisma.wallet.upsert({
    where: { address: address.toLowerCase() },
    create: { address: address.toLowerCase(), ...fields },
    update: { lastActiveAt: new Date(), ...fields },
  });
}

/** Flips a wallet's "reviewed by me" flag — used by the dashboard's check-off feature. */
export async function setWalletChecked(address: Address, checked: boolean) {
  return prisma.wallet.upsert({
    where: { address: address.toLowerCase() },
    create: { address: address.toLowerCase(), checked, checkedAt: checked ? new Date() : null },
    update: { checked, checkedAt: checked ? new Date() : null },
  });
}

/** Flips a wallet's "important, keep watching" flag — independent of `checked`. */
export async function setWalletStarred(address: Address, starred: boolean) {
  return prisma.wallet.upsert({
    where: { address: address.toLowerCase() },
    create: { address: address.toLowerCase(), starred, starredAt: starred ? new Date() : null },
    update: { starred, starredAt: starred ? new Date() : null },
  });
}

/** All wallets currently starred, newest-starred first — excludes checked (trashed) wallets. */
export async function listStarredWallets() {
  return prisma.wallet.findMany({
    where: { starred: true, checked: false },
    orderBy: { starredAt: "desc" },
  });
}

/** Flips a wallet's "confirmed dev wallet, follow this one" flag — independent of checked/starred. */
export async function setWalletDevFlag(address: Address, isDevWallet: boolean) {
  return prisma.wallet.upsert({
    where: { address: address.toLowerCase() },
    create: { address: address.toLowerCase(), isDevWallet, devWalletAt: isDevWallet ? new Date() : null },
    update: { isDevWallet, devWalletAt: isDevWallet ? new Date() : null },
  });
}

/** All confirmed dev wallets, newest-flagged first. */
export async function listDevWallets() {
  return prisma.wallet.findMany({
    where: { isDevWallet: true },
    orderBy: { devWalletAt: "desc" },
  });
}

/** Flips a token deployment's "keep watching, don't auto-delete" flag. */
export async function setDeploymentSaved(tokenAddress: string, saved: boolean) {
  return prisma.tokenDeployment.update({
    where: { tokenAddress: tokenAddress.toLowerCase() },
    data: { savedForWatch: saved, savedAt: saved ? new Date() : null },
  });
}

/** All deployments saved for ongoing watch, newest-saved first. */
export async function listSavedDeployments() {
  return prisma.tokenDeployment.findMany({
    where: { savedForWatch: true },
    include: {
      deployer: true,
      liquidityEvents: { orderBy: { occurredAt: "asc" } },
      scoreLogs: { orderBy: { computedAt: "desc" }, take: 1 },
    },
    orderBy: { savedAt: "desc" },
  });
}

/**
 * Records (or enriches an already-tracked) token as a Pons launch, with its
 * creator-supplied social links. `socials` is null when the on-chain read
 * failed (still marks it as a Pons launch — just without link data, so it
 * won't clear the >=2-of-3 filter until/unless a later enrichment succeeds).
 */
export async function recordPonsLaunch(params: {
  tokenAddress: Address;
  deployerAddress: Address;
  deployTxHash: string;
  deployedAt: Date;
  socials: { twitter: string; telegram: string; discord: string; website: string; farcaster: string } | null;
}) {
  await upsertWallet(params.deployerAddress);

  const socialFields = {
    isPonsLaunch: true,
    twitterUrl: params.socials?.twitter || null,
    telegramUrl: params.socials?.telegram || null,
    discordUrl: params.socials?.discord || null,
    websiteUrl: params.socials?.website || null,
    farcasterUrl: params.socials?.farcaster || null,
  };

  return prisma.tokenDeployment.upsert({
    where: { tokenAddress: params.tokenAddress.toLowerCase() },
    create: {
      tokenAddress: params.tokenAddress.toLowerCase(),
      deployerAddress: params.deployerAddress.toLowerCase(),
      deployTxHash: params.deployTxHash,
      deployedAt: params.deployedAt,
      looksLikeErc20: true, // Pons-launched tokens are always standard fixed-supply ERC-20s
      ...socialFields,
    },
    update: socialFields,
  });
}

export async function recordTokenDeployment(params: {
  tokenAddress: Address;
  deployerAddress: Address;
  deployTxHash: string;
  deployedAt: Date;
  looksLikeErc20: boolean;
}) {
  await upsertWallet(params.deployerAddress);
  return prisma.tokenDeployment.upsert({
    where: { tokenAddress: params.tokenAddress.toLowerCase() },
    create: {
      tokenAddress: params.tokenAddress.toLowerCase(),
      deployerAddress: params.deployerAddress.toLowerCase(),
      deployTxHash: params.deployTxHash,
      deployedAt: params.deployedAt,
      looksLikeErc20: params.looksLikeErc20,
    },
    update: {},
  });
}

export async function recordLiquidityEvent(params: {
  tokenAddress: Address;
  type: "POOL_CREATED" | "INITIAL_BUY" | "LIQUIDITY_REMOVED";
  dex?: string;
  poolAddress?: Address;
  actorAddress: Address;
  txHash: string;
  occurredAt: Date;
  amountPct?: number;
  minutesAfterPool?: number;
}) {
  const deployment = await prisma.tokenDeployment.findUnique({
    where: { tokenAddress: params.tokenAddress.toLowerCase() },
  });
  if (!deployment) return null;

  return prisma.liquidityEvent.create({
    data: {
      tokenDeploymentId: deployment.id,
      type: params.type,
      dex: params.dex,
      poolAddress: params.poolAddress?.toLowerCase(),
      actorAddress: params.actorAddress.toLowerCase(),
      txHash: params.txHash,
      occurredAt: params.occurredAt,
      amountPct: params.amountPct,
      minutesAfterPool: params.minutesAfterPool,
    },
  });
}

/** Count how many other deployer wallets share the same funding source. */
export async function countFundingSourceReuse(fundingSource: Address): Promise<number> {
  return prisma.wallet.count({
    where: { fundingSource: fundingSource.toLowerCase() },
  });
}

/**
 * Prior deployments + prior rugs for a wallet, used to feed the scoring engine.
 * `excludeTokenAddress` should be the token currently being scored, so its own
 * deployment/liquidity-removal doesn't get counted as "prior" history of itself.
 */
export async function getWalletHistory(address: Address, excludeTokenAddress?: Address) {
  const wallet = await prisma.wallet.findUnique({
    where: { address: address.toLowerCase() },
    include: {
      deployments: { include: { liquidityEvents: true } },
    },
  });
  if (!wallet) return { priorDeployments: 0, priorRugs: 0 };

  const otherDeployments = wallet.deployments.filter(
    (d) => d.tokenAddress !== excludeTokenAddress?.toLowerCase(),
  );

  const priorDeployments = otherDeployments.length;
  const priorRugs = otherDeployments.filter((d) =>
    d.liquidityEvents.some((e) => e.type === "LIQUIDITY_REMOVED"),
  ).length;

  return { priorDeployments, priorRugs };
}

export async function saveRiskScore(result: RiskScoreResult) {
  const deployment = await prisma.tokenDeployment.findUnique({
    where: { tokenAddress: result.tokenAddress.toLowerCase() },
  });
  if (!deployment) return null;

  await prisma.wallet.update({
    where: { address: result.wallet.toLowerCase() },
    data: { latestRiskScore: result.score },
  });

  return prisma.riskScoreLog.create({
    data: {
      walletAddress: result.wallet.toLowerCase(),
      tokenDeploymentId: deployment.id,
      score: result.score,
      breakdown: result.breakdown as unknown as object,
      computedAt: result.computedAt,
    },
  });
}
