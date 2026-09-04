import { Bot } from "grammy";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import type { RiskScoreResult } from "../detection/types.js";
import { listWatchlist } from "../watchlist/watchlistManager.js";
import { listClusters } from "../db/fundingRepository.js";

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

  bot.command("clusters", async (ctx) => {
    const clusters = await listClusters();
    if (clusters.length === 0) {
      await ctx.reply("No wallet clusters detected yet.");
      return;
    }
    const lines = clusters
      .slice(0, 25)
      .map((c) => `${c.sourceAddress} — funded ${c.walletCount} fresh wallet(s)`);
    await ctx.reply(lines.join("\n"));
  });
}

function explorerLink(address: string) {
  return `https://robinhoodchain.blockscout.com/address/${address}`;
}

async function sendText(text: string) {
  const b = getBot();
  if (!b || !env.TELEGRAM_CHAT_ID) {
    logger.info({ text }, "[alert - telegram not configured]");
    return;
  }
  try {
    await b.api.sendMessage(env.TELEGRAM_CHAT_ID, text, { parse_mode: "Markdown" });
  } catch (err) {
    logger.error({ err }, "failed to send Telegram alert");
  }
}

export async function sendRiskAlert(result: RiskScoreResult) {
  const lines = [
    `🚨 *Suspicious deployer activity* — risk score *${result.score}/100*`,
    `Wallet: \`${result.wallet}\` (${explorerLink(result.wallet)})`,
    `Token: \`${result.tokenAddress}\` (${explorerLink(result.tokenAddress)})`,
    "",
    ...result.breakdown.map((item) => `• +${item.points} ${item.rule} — ${item.reason}`),
  ];
  await sendText(lines.join("\n"));
}

export async function sendWatchlistReactivationAlert(wallet: string, activity: string) {
  const text = `⚠️ Watchlisted wallet is active again\nWallet: \`${wallet}\` (${explorerLink(
    wallet,
  )})\nActivity: ${activity}`;
  await sendText(text);
}

/** A funding source has just fanned out to >= FANOUT_MIN_WALLETS fresh burner wallets. */
export async function sendClusterAlert(sourceAddress: string, memberWallets: string[]) {
  const lines = [
    `🧩 *Wallet cluster detected* — 1 ví bơm tiền cho ${memberWallets.length} ví mới toanh`,
    `Nguồn: \`${sourceAddress}\` (${explorerLink(sourceAddress)})`,
    "",
    "Ví con:",
    ...memberWallets.slice(0, 20).map((w) => `• \`${w}\` (${explorerLink(w)})`),
    "",
    "Đang theo dõi — sẽ báo ngay khi ví con nào trong cụm này mua token mới.",
  ];
  await sendText(lines.join("\n"));
}

/** A wallet belonging to a known funding cluster just bought a freshly-launched token. */
export async function sendClusterBuyAlert(params: {
  buyer: string;
  tokenAddress: string;
  poolAddress: string;
  sizePct: number;
  clusterSource: string;
}) {
  const lines = [
    `🎯 *Cluster wallet buying* — có thể đáng copy trade ngay`,
    `Ví mua: \`${params.buyer}\` (${explorerLink(params.buyer)})`,
    `Token: \`${params.tokenAddress}\` (${explorerLink(params.tokenAddress)})`,
    `Pool: \`${params.poolAddress}\``,
    `Mua ~${(params.sizePct * 100).toFixed(1)}% pool`,
    `Thuộc cụm ví từ nguồn: \`${params.clusterSource}\` (${explorerLink(params.clusterSource)})`,
  ];
  await sendText(lines.join("\n"));
}

export function startTelegramBot() {
  const b = getBot();
  if (!b) return;
  void b.start();
  logger.info("Telegram bot started");
}
