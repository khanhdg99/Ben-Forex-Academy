import { env } from "../config/env.js";
import type { DeploymentCase, ScoreBreakdownItem } from "./types.js";

export type Rule = (deployCase: DeploymentCase) => ScoreBreakdownItem | null;

/** 1. Contract bytecode matches the standard ERC-20 method set. */
export const ruleErc20Bytecode: Rule = (c) => {
  if (!c.looksLikeErc20) return null;
  return { rule: "erc20_bytecode", points: 15, reason: "Deployed contract exposes standard ERC-20 methods" };
};

/** 2. A liquidity pool for this exact token was created shortly after deployment. */
export const ruleFastPoolCreation: Rule = (c) => {
  if (!c.pool) return null;
  const minutes = (c.pool.createdAt.getTime() - c.deployment.deployedAt.getTime()) / 60_000;
  if (minutes < 0 || minutes > 30) return null;
  const points = minutes <= 5 ? 25 : 15;
  return {
    rule: "fast_pool_creation",
    points,
    reason: `Liquidity pool created ${minutes.toFixed(1)} min after token deployment`,
  };
};

/** 3. Large self-buy right after the pool opened. */
export const ruleLargeInitialBuy: Rule = (c) => {
  if (!c.initialBuy) return null;
  if (c.initialBuy.minutesAfterPoolCreation > env.INITIAL_BUY_WINDOW_MINUTES) return null;
  if (c.initialBuy.sizePct * 100 < env.INITIAL_BUY_LARGE_PCT) return null;

  const isDeployerOrRelated =
    c.initialBuy.buyer.toLowerCase() === c.deployment.deployer.toLowerCase();
  const points = isDeployerOrRelated ? 25 : 15;

  return {
    rule: "large_initial_buy",
    points,
    reason: `${(c.initialBuy.sizePct * 100).toFixed(1)}% of pool bought ${c.initialBuy.minutesAfterPoolCreation.toFixed(
      1,
    )} min after pool creation${isDeployerOrRelated ? " by the deployer wallet itself" : ""}`,
  };
};

/** 4. Deployer wallet was recently funded from a source reused across other tracked deployers. */
export const ruleReusedFundingSource: Rule = (c) => {
  if (!c.funding) return null;
  if (c.funding.reuseCount < 1) return null;
  const points = Math.min(10 + c.funding.reuseCount * 5, 25);
  return {
    rule: "reused_funding_source",
    points,
    reason: `Funding source ${c.funding.fundingSource} has funded ${c.funding.reuseCount + 1} tracked deployer wallet(s)`,
  };
};

/** 5. Serial deployer — this wallet has deployed similar tokens before. */
export const ruleSerialDeployer: Rule = (c) => {
  const prior = c.walletHistory?.priorDeployments ?? 0;
  if (prior < 1) return null;
  const points = Math.min(10 + prior * 5, 30);
  return {
    rule: "serial_deployer",
    points,
    reason: `Wallet has deployed ${prior} similar token(s) before this one`,
  };
};

/** 6. This deployer has a track record of pulling liquidity fast (rug pattern). */
export const ruleRugHistory: Rule = (c) => {
  const priorRugs = c.walletHistory?.priorRugs ?? 0;
  if (priorRugs < 1) return null;
  const points = Math.min(30 + priorRugs * 10, 60);
  return {
    rule: "rug_history",
    points,
    reason: `Wallet has ${priorRugs} prior token(s) where liquidity was pulled shortly after launch`,
  };
};

/** 6b. This specific deployment already rugged. */
export const ruleActiveRug: Rule = (c) => {
  if (!c.rug) return null;
  if (c.rug.minutesAfterPoolCreation > env.RUG_WINDOW_MINUTES) return null;
  if (c.rug.removedPct * 100 < env.RUG_REMOVAL_PCT) return null;
  return {
    rule: "active_rug",
    points: 50,
    reason: `${(c.rug.removedPct * 100).toFixed(1)}% of liquidity removed ${c.rug.minutesAfterPoolCreation.toFixed(
      1,
    )} min after pool creation`,
  };
};

export const allRules: Rule[] = [
  ruleErc20Bytecode,
  ruleFastPoolCreation,
  ruleLargeInitialBuy,
  ruleReusedFundingSource,
  ruleSerialDeployer,
  ruleRugHistory,
  ruleActiveRug,
];
