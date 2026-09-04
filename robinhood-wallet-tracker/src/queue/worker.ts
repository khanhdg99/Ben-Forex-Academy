import { Worker, type Job } from "bullmq";
import { CHAIN_EVENTS_QUEUE, redisConnection } from "./queue.js";
import { logger } from "../utils/logger.js";
import {
  handleDeployment,
  handlePoolCreated,
  handleInitialBuy,
  handleRug,
  handleFundingTransfer,
} from "../pipeline/handlers.js";
import type {
  DeploymentJobData,
  PoolCreatedJobData,
  InitialBuyJobData,
  RugJobData,
  FundingTransferJobData,
} from "./types.js";

export function startWorker() {
  const worker = new Worker(
    CHAIN_EVENTS_QUEUE,
    async (job: Job) => {
      switch (job.name) {
        case "deployment":
          return handleDeployment(job.data as DeploymentJobData);
        case "pool-created":
          return handlePoolCreated(job.data as PoolCreatedJobData);
        case "initial-buy":
          return handleInitialBuy(job.data as InitialBuyJobData);
        case "rug":
          return handleRug(job.data as RugJobData);
        case "funding-transfer":
          return handleFundingTransfer(job.data as FundingTransferJobData);
        default:
          logger.warn({ jobName: job.name }, "unknown job type");
      }
    },
    { connection: redisConnection, concurrency: 5 },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, jobName: job?.name, err }, "job failed");
  });
  worker.on("completed", (job) => {
    logger.debug({ jobId: job.id, jobName: job.name }, "job completed");
  });

  logger.info("chain-events worker started");
  return worker;
}
