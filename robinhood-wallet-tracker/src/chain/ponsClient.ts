import { parseAbiItem, type Address, type Hash } from "viem";
import { wsClient, httpClient } from "./client.js";
import { logger } from "../utils/logger.js";

/**
 * Pons is the dominant memecoin launchpad on Robinhood Chain — ~10% of all
 * chain transactions and 167,000+ tokens launched as of Sept 2026 (per
 * Bitquery's Robinhood Chain coverage and Pons's own GitHub repo,
 * github.com/ponsdotdev/ponsfamily — verified against two independent
 * sources since this chain is too new for first-hand confirmation from
 * this sandbox). Every token launched through it exposes a getTokenInfo()
 * read with its creator-supplied social links, which is the only reliable
 * on-chain source of "does this token have a real X/website/Telegram"
 * this bot has for Robinhood Chain — hence the launchpad-specific
 * integration instead of a generic heuristic.
 */
export const PONS_V2_FACTORY: Address = "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e";

const tokenLaunchedEvent = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)",
);

const getTokenInfoAbi = [
  {
    type: "function",
    name: "getTokenInfo",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "tokenDeployer", type: "address" },
      { name: "tokenLogo", type: "string" },
      { name: "tokenDescription", type: "string" },
      {
        name: "tokenSocials",
        type: "tuple",
        components: [
          { name: "twitter", type: "string" },
          { name: "telegram", type: "string" },
          { name: "discord", type: "string" },
          { name: "website", type: "string" },
          { name: "farcaster", type: "string" },
        ],
      },
    ],
  },
] as const;

export interface PonsLaunchEvent {
  tokenAddress: Address;
  deployer: Address;
  curve: Address;
  pairToken: Address;
  txHash: Hash;
  blockNumber: bigint;
}

export type PonsLaunchHandler = (event: PonsLaunchEvent) => void | Promise<void>;

/** Watches PonsV2LaunchFactory for new TokenLaunched events — one per memecoin launched through Pons. */
export function watchPonsLaunches(onLaunch: PonsLaunchHandler) {
  return wsClient.watchEvent({
    address: PONS_V2_FACTORY,
    event: tokenLaunchedEvent,
    onLogs: (logs) => {
      for (const log of logs) {
        const args = log.args as unknown as {
          token: Address;
          curve: Address;
          deployer: Address;
          pairToken: Address;
        };
        void onLaunch({
          tokenAddress: args.token,
          deployer: args.deployer,
          curve: args.curve,
          pairToken: args.pairToken,
          txHash: log.transactionHash!,
          blockNumber: log.blockNumber!,
        });
      }
    },
    onError: (error) => logger.error({ err: error }, "Pons launch watcher error"),
  });
}

export interface PonsSocials {
  twitter: string;
  telegram: string;
  discord: string;
  website: string;
  farcaster: string;
}

/**
 * Reads a Pons-launched token's own getTokenInfo(). Returns null (never
 * throws) if the call fails — e.g. the ABI doesn't match this exact token
 * (a future Pons version, or a non-Pons token passed in by mistake) — since
 * this is an enrichment step, not something that should ever break the
 * pipeline.
 */
export async function getPonsTokenInfo(tokenAddress: Address): Promise<{
  deployer: Address;
  logo: string;
  description: string;
  socials: PonsSocials;
} | null> {
  try {
    const [tokenDeployer, tokenLogo, tokenDescription, tokenSocials] = await httpClient.readContract({
      address: tokenAddress,
      abi: getTokenInfoAbi,
      functionName: "getTokenInfo",
    });
    return {
      deployer: tokenDeployer,
      logo: tokenLogo,
      description: tokenDescription,
      socials: {
        twitter: tokenSocials.twitter,
        telegram: tokenSocials.telegram,
        discord: tokenSocials.discord,
        website: tokenSocials.website,
        farcaster: tokenSocials.farcaster,
      },
    };
  } catch (err) {
    logger.warn({ err, tokenAddress }, "failed to read Pons getTokenInfo() for launched token");
    return null;
  }
}
