import { logger } from "./utils/logger.js";
import { startWorker } from "./queue/worker.js";
import { startPipeline } from "./pipeline/pipeline.js";
import { startTelegramBot } from "./alerts/telegram.js";
import { startWebServer } from "./web/server.js";
import { prisma } from "./db/prisma.js";
import { redisConnection } from "./queue/queue.js";

async function main() {
  logger.info("starting robinhood-wallet-tracker...");

  startTelegramBot();
  const webServer = startWebServer();
  const worker = startWorker();
  const stopPipeline = startPipeline();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down...");
    stopPipeline();
    await new Promise((resolve) => webServer.close(resolve));
    await worker.close();
    await redisConnection.quit();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error({ err }, "fatal startup error");
  process.exit(1);
});
