/**
 * Paste a token address, get a report of which buyers look dev-controlled.
 *
 * Run with: npm run investigate -- 0xTokenAddress
 */
import { isAddress } from "viem";
import { investigateToken } from "../src/investigation/tokenInvestigator.js";
import { logger } from "../src/utils/logger.js";

async function main() {
  const tokenAddress = process.argv[2];
  if (!tokenAddress || !isAddress(tokenAddress)) {
    console.error("Usage: npm run investigate -- 0xTokenAddress");
    process.exit(1);
  }

  logger.info({ tokenAddress }, "investigating token buyers...");
  const result = await investigateToken(tokenAddress);

  if (!result.poolAddress) {
    console.log("\nKhông tìm được pool/giao dịch mua nào cho token này.");
    process.exit(0);
  }

  console.log(`\nPool: ${result.poolAddress} (${result.poolSource})`);
  console.log(`Pool tạo lúc: ${result.poolCreatedAt?.toISOString() ?? "không rõ"}`);
  console.log(`Số ví mua đã phân tích: ${result.buyersAnalyzed}\n`);

  for (const b of result.buyers) {
    const flag = b.likelyDevWallet ? "🚩 NGHI LÀ VÍ DEV" : "  ";
    console.log(
      `${flag} ${b.address}  conf=${b.confidence}  fresh=${b.isFreshWallet}  ` +
        `onlyThisToken=${b.onlyBoughtThisToken}  sameAmountGroup=${b.sameAmountGroupSize}  ` +
        `minAfterPool=${b.minutesAfterPoolCreation?.toFixed(1) ?? "?"}  amount=${b.amountBought}`,
    );
  }

  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "investigation failed");
  process.exit(1);
});
