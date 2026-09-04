import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { env } from "../config/env.js";

export const redisConnection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const CHAIN_EVENTS_QUEUE = "chain-events";

export const chainEventsQueue = new Queue(CHAIN_EVENTS_QUEUE, {
  connection: redisConnection,
  defaultJobOptions: {
    removeOnComplete: 1000,
    removeOnFail: 1000,
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
  },
});
