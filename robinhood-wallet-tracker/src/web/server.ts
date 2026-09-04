import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAddress } from "viem";
import { prisma } from "../db/prisma.js";
import { env } from "../config/env.js";
import { logger } from "../utils/logger.js";
import { removeFromWatchlist } from "../watchlist/watchlistManager.js";
import { listClusters, listClusterMembers, findClusterForWallet } from "../db/fundingRepository.js";
import { setWalletChecked, setWalletStarred, listStarredWallets } from "../db/repositories.js";
import { investigateToken } from "../investigation/tokenInvestigator.js";

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
    const [totalDeployments, totalWallets, watchlisted, alertableToday, totalClusters, totalStarred] =
      await Promise.all([
        prisma.tokenDeployment.count(),
        prisma.wallet.count(),
        prisma.watchlistEntry.count(),
        prisma.riskScoreLog.count({
          where: {
            score: { gte: env.ALERT_SCORE_THRESHOLD },
            computedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
        }),
        prisma.fundingCluster.count(),
        prisma.wallet.count({ where: { starred: true } }),
      ]);
    res.json({
      totalDeployments,
      totalWallets,
      watchlisted,
      alertableToday,
      totalClusters,
      totalStarred,
      threshold: env.ALERT_SCORE_THRESHOLD,
    });
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

  app.get("/api/clusters", async (_req, res) => {
    try {
      const clusters = await listClusters();
      res.json(toJson(clusters));
    } catch (err) {
      logger.error({ err }, "failed to list clusters");
      res.status(500).json({ error: "failed to list clusters" });
    }
  });

  app.get("/api/clusters/:source/members", async (req, res) => {
    try {
      const members = await listClusterMembers(req.params.source);
      res.json(toJson(members));
    } catch (err) {
      logger.error({ err, source: req.params.source }, "failed to list cluster members");
      res.status(500).json({ error: "failed to list cluster members" });
    }
  });

  app.get("/api/wallets/:address/cluster", async (req, res) => {
    if (!isAddress(req.params.address)) {
      res.status(400).json({ error: "invalid address" });
      return;
    }
    const cluster = await findClusterForWallet(req.params.address as `0x${string}`);
    res.json({ cluster: cluster ? toJson(cluster) : null });
  });

  app.put("/api/wallets/:address/checked", async (req, res) => {
    const checked = req.body?.checked === true;
    const wallet = await setWalletChecked(req.params.address as `0x${string}`, checked);
    res.json(toJson(wallet));
  });

  app.put("/api/wallets/:address/starred", async (req, res) => {
    const starred = req.body?.starred === true;
    const wallet = await setWalletStarred(req.params.address as `0x${string}`, starred);
    res.json(toJson(wallet));
  });

  app.get("/api/starred", async (_req, res) => {
    const wallets = await listStarredWallets();
    res.json(toJson(wallets));
  });

  app.post("/api/investigate", async (req, res) => {
    const tokenAddress = req.body?.tokenAddress;
    if (typeof tokenAddress !== "string" || !isAddress(tokenAddress)) {
      res.status(400).json({ error: "invalid tokenAddress" });
      return;
    }
    try {
      const result = await investigateToken(tokenAddress);
      res.json(toJson(result));
    } catch (err) {
      logger.error({ err, tokenAddress }, "token investigation failed");
      res.status(500).json({ error: "investigation failed" });
    }
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

  // Catch-all safety net: Express 5 auto-forwards a rejected async handler
  // here even without an explicit try/catch in the route, but without this
  // it falls through to Express's default (unlogged, HTML) error page —
  // this makes sure every API failure is visible in the server log and
  // returns clean JSON instead.
  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    logger.error({ err, path: req.path }, "unhandled API error");
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(500).json({ error: "internal error" });
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
