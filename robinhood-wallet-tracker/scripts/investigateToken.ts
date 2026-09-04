/**
 * Paste a token address, get a list of wallets that are BOTH brand-new
 * (nonce 0) and have never bought any other token, plus the funding
 * source shared by the most of them — the suspected dev wallet.
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
  console.log(`Số ví mua đã quét: ${result.buyersAnalyzed}`);
  console.log(
    `Số ví thoả cả 2 điều kiện (ví mới + chỉ mua riêng token này): ${result.qualifyingBuyers.length}\n`,
  );

  for (const b of result.qualifyingBuyers) {
    console.log(`${b.address}  amount=${b.amountBought}`);
    console.log(
      `     nguồn vốn: ${b.fundingSource ?? "không rõ"}${b.sameAmountGroupSize >= 2 ? ` (cùng số lượng mua với ${b.sameAmountGroupSize - 1} ví khác)` : ""}`,
    );
    console.log("");
  }

  if (result.suspectedDevWallet) {
    console.log("=== Nghi là ví dev (ví nguồn chung) ===");
    console.log(
      `${result.suspectedDevWallet} -> cấp vốn cho ${result.suspectedDevWalletMemberCount} trong số ${result.qualifyingBuyers.length} ví thoả điều kiện ở trên.`,
    );
  } else if (result.qualifyingBuyers.length > 0) {
    console.log("Không tìm thấy 1 ví nguồn chung nào cấp vốn cho từ 2 ví trở lên trong danh sách trên.");
  }

  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "investigation failed");
  process.exit(1);
});
