import type { Address, Hash } from "viem";

export interface TokenDeploymentInfo {
  deployer: Address;
  tokenAddress: Address;
  deployTxHash: Hash;
  deployedAt: Date;
}

export interface PoolCreationInfo {
  dex: "uniswap-v2" | "uniswap-v3";
  poolAddress: Address;
  tokenAddress: Address;
  createdAt: Date;
  createdTxHash: Hash;
  /** Wallet that sent the pool-creation tx (usually the deployer, sometimes a helper wallet). */
  createdBy: Address;
}

export interface InitialBuyInfo {
  buyer: Address;
  txHash: Hash;
  occurredAt: Date;
  /** Fraction of pool reserves (0-1) this single buy represents. */
  sizePct: number;
  minutesAfterPoolCreation: number;
}

export interface RugInfo {
  txHash: Hash;
  occurredAt: Date;
  /** Fraction of liquidity removed (0-1) in this single burn. */
  removedPct: number;
  minutesAfterPoolCreation: number;
}

export interface FundingInfo {
  fundingSource: Address;
  fundedAt: Date;
  /** How many other tracked deployer wallets this same source has funded. */
  reuseCount: number;
}

export interface WalletHistory {
  priorDeployments: number;
  priorRugs: number;
}

/** Everything the scoring engine knows about one token-deployment "case" at scoring time. */
export interface DeploymentCase {
  deployment: TokenDeploymentInfo;
  looksLikeErc20: boolean;
  pool?: PoolCreationInfo;
  initialBuy?: InitialBuyInfo;
  rug?: RugInfo;
  funding?: FundingInfo;
  walletHistory?: WalletHistory;
}

export interface ScoreBreakdownItem {
  rule: string;
  points: number;
  reason: string;
}

export interface RiskScoreResult {
  wallet: Address;
  tokenAddress: Address;
  score: number;
  breakdown: ScoreBreakdownItem[];
  computedAt: Date;
}
