import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../db/prisma.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { removeFromWatchlist } from "../watchlist/watchlistManager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** JSON-safe serializer: Prisma rows can carry BigInt/Date fields. */
function toJson(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export function startWebServer() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "../../public")));

  app.get("/api/stats", async (_req, res) => {
    const [totalDeployments, totalWallets, watchlisted, alertableToday] = await Promise.all([
      prisma.tokenDeployment.count(),
      prisma.wallet.count(),
      prisma.watchlistEntry.count(),
      prisma.riskScoreLog.count({
        where: {
          score: { gte: env.ALERT_SCORE_THRESHOLD },
          computedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
        },
      }),
    ]);
    res.json({ totalDeployments, totalWallets, watchlisted, alertableToday, threshold: env.ALERT_SCORE_THRESHOLD });
  });

  app.get("/api/watchlist", async (_req, res) => {
    const entries = await prisma.watchlistEntry.findMany({
      include: { wallet: true },
      orderBy: { addedAt: "desc" },
      take: 200,
    });
    res.json(toJson(entries));
  });

  app.delete("/api/watchlist/:address", async (req, res) => {
    await removeFromWatchlist(req.params.address as `0x${string}`);
    res.json({ ok: true });
  });

  app.get("/api/deployments", async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const deployments = await prisma.tokenDeployment.findMany({
      include: {
        deployer: true,
        liquidityEvents: { orderBy: { occurredAt: "asc" } },
        scoreLogs: { orderBy: { computedAt: "desc" }, take: 1 },
      },
      orderBy: { deployedAt: "desc" },
      take: limit,
    });
    res.json(toJson(deployments));
  });

  app.get("/api/wallets/:address", async (req, res) => {
    const wallet = await prisma.wallet.findUnique({
      where: { address: req.params.address.toLowerCase() },
      include: {
        deployments: { include: { liquidityEvents: true } },
        scoreLogs: { orderBy: { computedAt: "desc" }, take: 50 },
        watchlistEntry: true,
      },
    });
    if (!wallet) {
      res.status(404).json({ error: "wallet not found" });
      return;
    }
    res.json(toJson(wallet));
  });

  const server = app.listen(env.WEB_PORT, () => {
    logger.info({ port: env.WEB_PORT }, `dashboard: http://localhost:${env.WEB_PORT}`);
  });

  return server;
}

// Allow running this file standalone (`npm run web`) in addition to being
// wired into src/index.ts alongside the bot.
const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  startWebServer();
}
