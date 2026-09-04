import { chainEventsQueue } from "./queue.js";
import type {
  DeploymentJobData,
  PoolCreatedJobData,
  InitialBuyJobData,
  RugJobData,
  FundingTransferJobData,
} from "./types.js";

export const enqueueDeployment = (data: DeploymentJobData) =>
  chainEventsQueue.add("deployment", data);

export const enqueuePoolCreated = (data: PoolCreatedJobData) =>
  chainEventsQueue.add("pool-created", data);

export const enqueueInitialBuy = (data: InitialBuyJobData) =>
  chainEventsQueue.add("initial-buy", data);

export const enqueueRug = (data: RugJobData) => chainEventsQueue.add("rug", data);

export const enqueueFundingTransfer = (data: FundingTransferJobData) =>
  chainEventsQueue.add("funding-transfer", data);
