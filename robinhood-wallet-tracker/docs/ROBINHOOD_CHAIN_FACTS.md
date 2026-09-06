# Robinhood Chain — verified facts (as of Sept 2026)

Gathered via web search from this session's sandbox, which **cannot reach
docs.robinhood.com, alchemy.com, or blog.uniswap.org directly** (egress
policy blocks them) — everything below comes from search-result snippets,
not a first-hand fetch of the primary source. **Re-verify every value here
against the official docs before depending on it for anything
production-critical.**

## Live-tested (2026-09-04, from a real Mac, not the sandbox)

- **`RPC_HTTP_URL=https://rpc.mainnet.chain.robinhood.com` works.**
  `npm run step1:test-connection` returned `chainId: 4663` and a real,
  advancing block number (~54,005,867 at test time) over plain HTTPS. This
  confirms the chain ID and public HTTP RPC facts below firsthand.
- **`wss://rpc.mainnet.chain.robinhood.com` (same host, WS scheme) does
  NOT work.** The WebSocket connection fails immediately with a socket
  close error. Whether the public endpoint doesn't expose WS at all, or
  needs a different path, wasn't determined — treat the public RPC as
  **HTTP-only**. The bot now defaults to HTTP polling (`POLL_INTERVAL_MS`,
  1s default) when `RPC_WS_URL` is left blank, which needs no API key and
  works against this endpoint as-is. Real push-based WebSocket (lower
  latency) still requires a provider like Alchemy.

## Network

| Field | Value | Source |
|---|---|---|
| Chain ID | `4663` | [TrustSwap network details](https://trustswap.com/robinhood/network-details), [NockTerminal](https://nockterminal.com/guides/robinhood-chain-rpc-url) |
| Public RPC | `https://rpc.mainnet.chain.robinhood.com` | Search snippet referencing [docs.robinhood.com/chain/connecting](https://docs.robinhood.com/chain/connecting) |
| Block explorer | `https://robinhoodchain.blockscout.com` (Blockscout) | [HoodScan](https://www.hood-chain.com/), TrustSwap |
| Native gas token | ETH | [Robinhood support article](https://robinhood.com/us/en/support/articles/robinhood-chain-mainnet/) |
| Stack | Arbitrum Orbit L2, settles to Ethereum via blobs | [crypto.news explainer](https://crypto.news/what-is-robinhood-chain-brokers-blockchain-explained/), [Alchemy blog](https://www.alchemy.com/blog/robinhood-chain-mainnet-is-live-on-alchemy) |
| Block time | ~100ms | [cryptobriefing](https://cryptobriefing.com/robinhood-arbitrum-layer-2-mainnet-launch/) |
| Testnet launch | Feb 10, 2026 | [Robinhood newsroom](https://robinhood.com/us/en/newsroom/robinhood-chain-launches-public-testnet) |
| Mainnet launch | Jul 1, 2026 ("The World is Flat" keynote, London) | [cryptobriefing](https://cryptobriefing.com/robinhood-arbitrum-layer-2-mainnet-launch/) |

**Important:** the public RPC is explicitly called out as rate-limited and
not recommended for 24/7 production use. Use a managed provider instead.

## RPC providers

- **Alchemy: confirmed live**, both mainnet and testnet, with RPC, WebSocket,
  webhooks, and data APIs. Explicitly named as a recommended provider.
  Sources: [Alchemy blog post](https://www.alchemy.com/blog/robinhood-chain-mainnet-is-live-on-alchemy),
  [Alchemy RPC page](https://www.alchemy.com/rpc/robinhood).
- **Infura: not confirmed.** Search did not surface Infura support; treat it
  as unsupported until you check https://www.infura.io/networks yourself.
- Other providers mentioned in search results: QuickNode, Chainstack,
  OrbitFlare, dRPC. Chainstack in particular publishes Robinhood-specific
  tooling docs (`docs.chainstack.com/docs/robinhood-tooling`) — worth
  checking if Alchemy access is a blocker.
- Since the chain is Arbitrum Orbit, Arbitrum's own Orbit node-runner tooling
  is the fallback if you ever need to run your own full node instead of
  relying on a third party (see "Run a Robinhood Chain full node" referenced
  at `docs.robinhood.com/chain/run-a-full-node/`).

## Uniswap deployment

Uniswap v2, v3, v4, and UniswapX are reported live on Robinhood Chain from
launch ([Uniswap blog: "Uniswap is Live on Robinhood Chain"](https://blog.uniswap.org/robinhood-chain-is-live)).
**Exact factory/router contract addresses were not found via search** — pull
them from `docs.robinhood.com/chain/protocol-contracts` (referenced by
search snippets but not independently fetched here) or read them directly
off verified contracts on the Blockscout explorer. Until you've confirmed
them, `.env`'s `UNISWAP_V2_FACTORY`/`UNISWAP_V3_FACTORY` are left blank and
the pool-creation watcher matches on the `PairCreated`/`PoolCreated` event
*signature* chain-wide instead of a specific factory address — this works
without knowing the address, at the cost of also picking up any other
Uniswap-shaped fork/clone deployed on the chain.

## Pons Launchpad — confirmed dominant memecoin launchpad

Cross-validated via web search + a direct fetch of the official GitHub source
(`github.com` was reachable from the sandbox even though the chain's own docs
site was not).

| Field | Value | Source |
|---|---|---|
| Role | Dominant memecoin launchpad on Robinhood Chain — reported ~10% of all chain transactions, 167,000+ tokens launched | Search snippets citing on-chain analytics |
| Official repo | `github.com/ponsdotdev/ponsfamily` | Direct fetch |
| V2 factory contract | `PonsV2LaunchFactory` at `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` | `ponsfamily` repo source |
| V1 factory contract | `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB` | `ponsfamily` repo source |
| Launch event | `TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)` | `ponsfamily` repo source |
| Token contract | `PonsV2LauncherToken` | `ponsfamily` repo source |
| Social-link read | `getTokenInfo() external view returns (address tokenDeployer, string tokenLogo, string tokenDescription, Socials tokenSocials)` and `socials() external view returns (string twitter, string telegram, string discord, string website, string farcaster)` on the launched token itself | `ponsfamily` repo source |

This is the bot's real, verified data source for the dashboard's "≥2-of-3
social links" filter on `TokenDeployment` — `src/chain/ponsClient.ts` watches
`TokenLaunched` on the V2 factory and reads `socials()` off each launched
token. Only Pons-launched tokens carry this data; generic bytecode-detected
deployments (non-Pons) have no social info one way or the other and are not
held to the filter. The V1 factory is not currently watched (V2 is the
active one per the repo); revisit if V1 launches turn out to still be common.

## Memecoin activity — premise confirmed

This is the most important finding: **the premise of this bot is validated**.
Within two weeks of mainnet launch, DEX volume on Robinhood Chain reportedly
jumped from ~$200K to over $500M, led by meme tokens (CASHCAT cited as the
flagship). Multiple sources describe an active scam wave — honeypots,
copycat tokens, liquidity pulls — consistent enough that third-party "safety
checklists" for Robinhood Chain memecoins already exist (LP lock status,
verified contract, no mint function, deployer wallet history).

Sources: [Bitcoin Foundation — Top 5 Robinhood Chain Memecoins](https://bitcoinfoundation.org/news/altcoins/top-5-robinhood-chain-memecoins-to-buy/),
[TrustSwap — Robinhood Chain Memecoins Safety-Checked List](https://trustswap.com/robinhood/memecoins),
[Memeburn — What Is Robinhood Chain? Built for Stocks, Run by Memes](https://memeburn.com/what-is-robinhood-chain-built-for-stocks-run-by-memes/).

## What to verify yourself before running this in production

1. Chain ID, RPC URL, WS URL — confirm at `docs.robinhood.com/chain/connecting`.
2. Uniswap factory addresses — confirm at `docs.robinhood.com/chain/protocol-contracts`
   or by reading verified contracts on Blockscout.
3. Blockscout API base path/shape — the v2 REST API used in
   `src/chain/blockscoutClient.ts` (`/api/v2/addresses/{address}/transactions`)
   is the current standard Blockscout shape, but confirm against the
   instance's own Swagger docs (`robinhoodchain.blockscout.com/api-docs`)
   since exact fields can drift between Blockscout versions.
4. Whether Infura support has since shipped, if you'd rather not depend on
   Alchemy alone.
