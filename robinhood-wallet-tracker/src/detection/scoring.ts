import { allRules } from "./rules.js";
import type { DeploymentCase, RiskScoreResult } from "./types.js";

/**
 * Runs every rule against a deployment case and sums the points, capped at
 * 100. Rules that don't apply (missing data, condition not met) simply
 * contribute nothing — the score only ever reflects signals we actually
 * observed, so a token with no pool yet correctly scores lower than one with
 * a pool + a suspicious initial buy.
 */
export function scoreDeploymentCase(deployCase: DeploymentCase): RiskScoreResult {
  const breakdown = allRules
    .map((rule) => rule(deployCase))
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const rawScore = breakdown.reduce((sum, item) => sum + item.points, 0);
  const score = Math.min(rawScore, 100);

  return {
    wallet: deployCase.deployment.deployer,
    tokenAddress: deployCase.deployment.tokenAddress,
    score,
    breakdown,
    computedAt: new Date(),
  };
}
