import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  CHAIN_ID: z.coerce.number().default(4663),
  RPC_HTTP_URL: z.string().url(),
  // Optional: leave blank to fall back to HTTP polling (no API key needed).
  RPC_WS_URL: z.union([z.string().url(), z.literal("")]).optional().default(""),
  // How often to poll over HTTP when RPC_WS_URL isn't set.
  POLL_INTERVAL_MS: z.coerce.number().default(1000),
  BLOCKSCOUT_API_BASE: z.string().url().default("https://robinhoodchain.blockscout.com/api/v2"),

  UNISWAP_V2_FACTORY: z.string().optional().default(""),
  UNISWAP_V3_FACTORY: z.string().optional().default(""),

  INITIAL_BUY_WINDOW_MINUTES: z.coerce.number().default(15),
  INITIAL_BUY_LARGE_PCT: z.coerce.number().default(15),
  RUG_WINDOW_MINUTES: z.coerce.number().default(180),
  RUG_REMOVAL_PCT: z.coerce.number().default(50),
  ALERT_SCORE_THRESHOLD: z.coerce.number().default(60),

  // Funding fan-out / wallet cluster detection (dev sybil wallets or
  // multi-wallet snipers funding a batch of brand-new burner wallets).
  FANOUT_WINDOW_MINUTES: z.coerce.number().default(60),
  FANOUT_MIN_WALLETS: z.coerce.number().default(3),
  FANOUT_MIN_VALUE_ETH: z.coerce.number().default(0.0005),

  DATABASE_URL: z.string().default("postgresql://postgres:postgres@localhost:5432/robinhood_tracker"),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),

  LOG_LEVEL: z.string().default("info"),

  WEB_PORT: z.coerce.number().default(3000),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
