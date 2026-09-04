# Robinhood Chain — Memecoin Deployer Wallet Tracker

Monitors Robinhood Chain (an Arbitrum Orbit EVM L2, chain ID `4663`) for
wallets behaving like memecoin "devs": deploy an ERC-20-shaped contract →
create a Uniswap pool for it → often buy a large chunk of it immediately →
sometimes rug the liquidity soon after. Scores every deployer wallet with a
weighted rule engine, keeps history in Postgres, and pushes Telegram alerts
when a wallet crosses a risk threshold or a watchlisted wallet becomes
active again.

**Read-only / alert-only.** No private key handling, no automated trading —
by design, per the project brief. See `docs/ROBINHOOD_CHAIN_FACTS.md` for
the chain facts this was built against and their sources, and re-verify them
yourself — this was researched via web search in a sandboxed environment
that could not directly reach `docs.robinhood.com` to confirm firsthand.

## Architecture

```
RPC/WebSocket Listener (viem)
  → filters: contract-creation txs, Uniswap PairCreated/PoolCreated logs
  → Redis (BullMQ) queue for realtime, retry-safe processing
  → Detection Engine (rule-based risk scoring, src/detection/)
  → Postgres (wallets, token deployments, liquidity/swap events, score log)
  → Watchlist Manager
  → Telegram Alert Service
```

- `src/chain/` — viem clients + watchers (blocks, contract creation, pool
  creation, pool swap/burn activity), plus a Blockscout REST client for
  funding-source lookback.
- `src/detection/` — the scoring rules and the engine that runs them
  (`rules.ts`, `scoring.ts`).
- `src/db/` — Prisma schema + repository functions.
- `src/pipeline/` — wires the chain watchers to the queue, and manages the
  time-boxed "watch this pool for an initial buy / a rug" surveillance
  windows.
- `src/queue/` — BullMQ queue/worker.
- `src/watchlist/`, `src/alerts/` — watchlist persistence + Telegram bot.

## Setup

```bash
cd robinhood-wallet-tracker
npm install
cp .env.example .env   # fill in RPC URLs, Telegram token, etc.
```

### Step 1 — confirm chain connectivity

```bash
npm run step1:test-connection
```

Should print the chain ID, current block number, and then stream new blocks
as they land. **This is the step you need to run in an environment with real
network access** — this bot was scaffolded in a sandbox whose egress policy
blocks the RPC/explorer hosts, so the connection itself has not been
live-tested here.

If it fails or the chain ID doesn't match `4663`, double-check
`RPC_HTTP_URL`/`RPC_WS_URL` in `.env` against
https://docs.robinhood.com/chain/connecting — the public RPC
(`rpc.mainnet.chain.robinhood.com`) is rate-limited, so switch to Alchemy
(confirmed to support Robinhood Chain) for anything beyond quick testing.

### Step 2 — watch deployments + pool creations

```bash
npm run step2:log-events
```

Prints every ERC-20-like contract deployment and every Uniswap
`PairCreated`/`PoolCreated` event as they happen — no scoring or storage
yet, just proof the detection hooks work. Because the exact Robinhood Chain
Uniswap factory addresses weren't confirmed during research (see
`docs/ROBINHOOD_CHAIN_FACTS.md`), this matches on the Uniswap event
*signature* chain-wide rather than a specific factory address; set
`UNISWAP_V2_FACTORY`/`UNISWAP_V3_FACTORY` in `.env` once you've confirmed
them to cut down noise from unrelated Uniswap forks.

### Steps 3-5 — full pipeline (scoring, DB, watchlist, Telegram)

```bash
docker compose up -d postgres redis
npm run db:migrate       # creates the Postgres schema
npm run dev               # or: npm run build && npm start
```

This starts the queue worker, the Telegram bot (if `TELEGRAM_BOT_TOKEN` is
set), and the chain watchers together. Every deployment/pool/swap/burn event
gets scored via `src/detection/rules.ts`, persisted, and — once a wallet's
score crosses `ALERT_SCORE_THRESHOLD` (default 60) — pushed to your
configured Telegram chat, with subsequent activity from that wallet
triggering a lighter "watchlisted wallet is active again" alert.

To run everything (including the bot) in Docker:

```bash
docker compose up -d --build
```

### Telegram bot setup

1. Create a bot via [@BotFather](https://t.me/BotFather), grab the token.
2. Add the bot to a chat/group/channel, find the chat ID (e.g. via
   `getUpdates` on the Bot API, or a helper bot like @userinfobot).
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`.
4. `/watchlist` in the chat lists currently-watchlisted wallets.

## Scoring model

Each rule in `src/detection/rules.ts` contributes points independently based
only on signals actually observed (a token with no pool yet simply doesn't
get pool-related points — it isn't penalized for missing data):

| Rule | Signal | Points |
|---|---|---|
| `erc20_bytecode` | Deployed bytecode matches standard ERC-20 selectors | 15 |
| `fast_pool_creation` | Uniswap pool for this token created within 30 min of deploy | 15-25 |
| `large_initial_buy` | A single buy within `INITIAL_BUY_WINDOW_MINUTES` takes ≥`INITIAL_BUY_LARGE_PCT`% of the pool | 15-25 |
| `reused_funding_source` | Deployer's funding wallet has funded other tracked deployers | 10-25 |
| `serial_deployer` | Wallet has deployed other similar tokens before | 10-30 |
| `rug_history` | Wallet has prior tokens where liquidity was pulled fast | 30-60 |
| `active_rug` | ≥`RUG_REMOVAL_PCT`% of liquidity pulled within `RUG_WINDOW_MINUTES` of pool creation, on this token | 50 |

Score is capped at 100. All thresholds are tunable via `.env` — see
`.env.example` for the full list. There is no gas-bidding logic anywhere: the
sequencer is first-come-first-served, so the only latency lever here is
"subscribe over WebSocket and react fast," which is what the watchers do.

## Known limitations / next steps (step 6 and beyond)

- **Not live-tested against the real chain** — built and typechecked in a
  sandbox that couldn't reach Robinhood Chain's RPC/explorer. Run Step 1
  first in a real environment before trusting anything downstream.
- **Uniswap factory addresses unconfirmed** — see
  `docs/ROBINHOOD_CHAIN_FACTS.md`. The signature-based watcher is a
  reasonable stopgap but will also catch non-Uniswap forks.
- **Funding-source / serial-deployer backfill is best-effort**: it calls the
  Blockscout REST API (`src/chain/blockscoutClient.ts`), which may need
  adjusting if the instance's exact response shape differs from what's
  coded here (couldn't confirm firsthand — see the facts doc).
- **No wallet clustering yet** — the brief's step 6 (clustering deployers by
  shared funding source into ownership groups, beyond simple "this address
  funded N tracked wallets" reuse counting) isn't implemented. The
  `Wallet.fundingSource` column is there to build on.
- **ERC-20 detection is heuristic** (bytecode selector matching), not a
  guarantee — treat it as one signal among several, which is how the scoring
  engine already treats it.
- If Robinhood Chain's memecoin activity is concentrated on a specific
  launchpad-style contract (the facts doc found evidence CASHCAT "launched
  its own launchpad") rather than raw Uniswap interactions, watching that
  launchpad's contract directly would likely catch more real activity than
  the generic ERC-20+Uniswap pattern — worth investigating once you have
  live chain access.
