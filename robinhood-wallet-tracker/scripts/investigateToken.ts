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
    console.log(`${flag} ${b.address}  conf=${b.confidence}  amount=${b.amountBought}`);
    console.log(`     nguồn vốn: ${b.fundingSource ?? "không rõ"}${b.sharedFundingGroupSize >= 2 ? ` (CHUNG với ${b.sharedFundingGroupSize - 1} ví khác!)` : ""}`);
    for (const note of b.notes) console.log(`     - ${note}`);
    console.log("");
  }

  const fundingGroups = new Map<string, string[]>();
  for (const b of result.buyers) {
    if (!b.fundingSource) continue;
    const list = fundingGroups.get(b.fundingSource) ?? [];
    list.push(b.address);
    fundingGroups.set(b.fundingSource, list);
  }
  const sharedGroups = [...fundingGroups.entries()].filter(([, addrs]) => addrs.length >= 2);
  if (sharedGroups.length > 0) {
    console.log("=== Các nhóm ví cùng chung 1 nguồn vốn ===");
    for (const [source, addrs] of sharedGroups) {
      console.log(`Nguồn: ${source} -> cấp vốn cho ${addrs.length} ví mua: ${addrs.join(", ")}`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "investigation failed");
  process.exit(1);
});
