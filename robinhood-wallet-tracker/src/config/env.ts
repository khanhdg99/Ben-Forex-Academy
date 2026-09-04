import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  CHAIN_ID: z.coerce.number().default(4663),
  RPC_HTTP_URL: z.string().url(),
  RPC_WS_URL: z.string().url(),
  BLOCKSCOUT_API_BASE: z.string().url().default("https://robinhoodchain.blockscout.com/api/v2"),

  UNISWAP_V2_FACTORY: z.string().optional().default(""),
  UNISWAP_V3_FACTORY: z.string().optional().default(""),

  INITIAL_BUY_WINDOW_MINUTES: z.coerce.number().default(15),
  INITIAL_BUY_LARGE_PCT: z.coerce.number().default(15),
  RUG_WINDOW_MINUTES: z.coerce.number().default(180),
  RUG_REMOVAL_PCT: z.coerce.number().default(50),
  ALERT_SCORE_THRESHOLD: z.coerce.number().default(60),

  DATABASE_URL: z.string().default("postgresql://postgres:postgres@localhost:5432/robinhood_tracker"),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),

  LOG_LEVEL: z.string().default("info"),
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
