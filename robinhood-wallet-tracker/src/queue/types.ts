/** Job payloads are plain JSON (no bigint/Date) since BullMQ serializes through Redis. */

export interface DeploymentJobData {
  deployer: string;
  tokenAddress: string;
  deployTxHash: string;
  deployedAtIso: string;
  looksLikeErc20: boolean;
}

export interface PoolCreatedJobData {
  dex: "uniswap-v2" | "uniswap-v3";
  poolAddress: string;
  tokenAddress: string;
  createdBy: string;
  createdTxHash: string;
  createdAtIso: string;
}

export interface InitialBuyJobData {
  tokenAddress: string;
  poolAddress: string;
  buyer: string;
  txHash: string;
  occurredAtIso: string;
  sizePct: number;
  minutesAfterPoolCreation: number;
}

export interface RugJobData {
  tokenAddress: string;
  poolAddress: string;
  actor: string;
  txHash: string;
  occurredAtIso: string;
  removedPct: number;
  minutesAfterPoolCreation: number;
}

export interface FundingTransferJobData {
  from: string;
  to: string;
  txHash: string;
  valueWei: string;
  occurredAtIso: string;
}

export type JobName = "deployment" | "pool-created" | "initial-buy" | "rug" | "funding-transfer";
