import { Bot } from "grammy";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { RiskScoreResult } from "../detection/types.js";
import { listWatchlist } from "../watchlist/watchlistManager.js";

let bot: Bot | null = null;

function getBot(): Bot | null {
  if (!env.TELEGRAM_BOT_TOKEN) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — alerts will be logged only, not sent");
    return null;
  }
  if (!bot) {
    bot = new Bot(env.TELEGRAM_BOT_TOKEN);
    registerCommands(bot);
  }
  return bot;
}

function registerCommands(bot: Bot) {
  bot.command("start", (ctx) => ctx.reply("Robinhood Chain wallet tracker online."));

  bot.command("watchlist", async (ctx) => {
    const entries = await listWatchlist();
    if (entries.length === 0) {
      await ctx.reply("Watchlist is empty.");
      return;
    }
    const lines = entries
      .slice(0, 25)
      .map((e) => `${e.walletAddress} — score ${e.wallet.latestRiskScore} — ${e.reason}`);
    await ctx.reply(lines.join("\n"));
  });
}

function explorerLink(address: string) {
  return `https://robinhoodchain.blockscout.com/address/${address}`;
}

export async function sendRiskAlert(result: RiskScoreResult) {
  const b = getBot();
  const lines = [
    `🚨 *Suspicious deployer activity* — risk score *${result.score}/100*`,
    `Wallet: \`${result.wallet}\` (${explorerLink(result.wallet)})`,
    `Token: \`${result.tokenAddress}\` (${explorerLink(result.tokenAddress)})`,
    "",
    ...result.breakdown.map((item) => `• +${item.points} ${item.rule} — ${item.reason}`),
  ];
  const text = lines.join("\n");

  if (!b) {
    logger.info({ text }, "[alert - telegram not configured]");
    return;
  }
  if (!env.TELEGRAM_CHAT_ID) {
    logger.warn("TELEGRAM_CHAT_ID not set — cannot send alert");
    return;
  }

  try {
    await b.api.sendMessage(env.TELEGRAM_CHAT_ID, text, { parse_mode: "Markdown" });
  } catch (err) {
    logger.error({ err }, "failed to send Telegram alert");
  }
}

export async function sendWatchlistReactivationAlert(wallet: string, activity: string) {
  const b = getBot();
  const text = `⚠️ Watchlisted wallet is active again\nWallet: \`${wallet}\` (${explorerLink(
    wallet,
  )})\nActivity: ${activity}`;

  if (!b || !env.TELEGRAM_CHAT_ID) {
    logger.info({ text }, "[alert - telegram not configured]");
    return;
  }
  try {
    await b.api.sendMessage(env.TELEGRAM_CHAT_ID, text, { parse_mode: "Markdown" });
  } catch (err) {
    logger.error({ err }, "failed to send Telegram reactivation alert");
  }
}

export function startTelegramBot() {
  const b = getBot();
  if (!b) return;
  void b.start();
  logger.info("Telegram bot started");
}
