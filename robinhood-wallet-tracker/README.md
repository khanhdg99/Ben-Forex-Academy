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
  → filters: contract-creation txs, Uniswap PairCreated/PoolCreated logs,
             native-ETH value transfers (fan-out detection)
  → Redis (BullMQ) queue for realtime, retry-safe processing
  → Detection Engine (rule-based risk scoring, src/detection/)
  → Fan-out / Wallet Cluster Detector (src/pipeline/handlers.ts, src/db/fundingRepository.ts)
  → Postgres (wallets, token deployments, liquidity/swap events, score log,
             funding transfers + clusters)
  → Watchlist Manager
  → Telegram Alert Service (deployer risk alerts + cluster-buy copy-trade alerts)
  → Web Dashboard (reads the same Postgres DB, http://localhost:3000)
```

- `src/chain/` — viem clients + watchers (blocks, contract creation, pool
  creation, pool swap/burn activity, native-ETH value transfers), a
  fresh-wallet (nonce-0) check, plus a Blockscout REST client for
  funding-source lookback.
- `src/detection/` — the scoring rules and the engine that runs them
  (`rules.ts`, `scoring.ts`).
- `src/db/` — Prisma schema + repository functions (`repositories.ts` for
  wallets/deployments/scores, `fundingRepository.ts` for the fan-out
  cluster detector).
- `src/pipeline/` — wires the chain watchers to the queue, and manages the
  time-boxed "watch this pool for an initial buy / a rug" surveillance
  windows.
- `src/queue/` — BullMQ queue/worker.
- `src/watchlist/`, `src/alerts/` — watchlist persistence + Telegram bot.
- `src/web/`, `public/` — read-only Express API + static dashboard page.

## Setup trên macOS (chạy trực tiếp bằng terminal, không cần Docker)

Cần Homebrew (https://brew.sh) và Node.js ≥20.

```bash
# 1. Cài Postgres + Redis qua Homebrew, chạy như service nền
brew install node postgresql@16 redis
brew services start postgresql@16
brew services start redis

# 2. Tạo database
createdb robinhood_tracker

# 3. Cài dependencies của project
cd robinhood-wallet-tracker
npm install
cp .env.example .env
```

Mở `.env` và điền:
- `RPC_HTTP_URL` / `RPC_WS_URL` — xem phần Step 1 bên dưới
- `DATABASE_URL=postgresql://<mac_username>@localhost:5432/robinhood_tracker`
  (Postgres của Homebrew mặc định không cần password, dùng username macOS của bạn —
  chạy `whoami` để lấy, hoặc tạo role riêng bằng `createuser`)
- `REDIS_URL=redis://localhost:6379` (giữ nguyên mặc định)
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` — xem phần Telegram bên dưới (không bắt buộc,
  bỏ trống thì cảnh báo chỉ in ra terminal + hiện trên web dashboard)

```bash
npm run db:migrate     # tạo schema Postgres (chỉ cần chạy 1 lần, hoặc khi đổi schema)
```

Từ đây chạy `npm run dev` (xem phần "Steps 3-5" bên dưới) — lệnh này khởi động cùng lúc:
bot theo dõi chain, queue worker, Telegram bot, **và web dashboard** trong cùng một
tiến trình terminal. Để nó chạy tiếp khi đóng terminal, dùng `nohup npm start &`
sau khi `npm run build`, hoặc cài `pm2` (`npm i -g pm2 && pm2 start dist/index.js --name robinhood-tracker`).

<details>
<summary>Setup bằng Docker thay vì Homebrew (tùy chọn)</summary>

```bash
cd robinhood-wallet-tracker
npm install
cp .env.example .env   # fill in RPC URLs, Telegram token, etc.
```

</details>

### Step 1 — confirm chain connectivity

```bash
npm run step1:test-connection
```

Should print the chain ID, current block number, and then stream new blocks
as they land — **live-tested and confirmed working** against the public RPC
(`RPC_HTTP_URL=https://rpc.mainnet.chain.robinhood.com`, chain ID `4663`).

No API key is required by default: leave `RPC_WS_URL` blank in `.env` and
the bot polls over HTTP every `POLL_INTERVAL_MS` (1s default) instead of
using a WebSocket push subscription — fine for an alert-only bot with no
gas bidding. The public endpoint's WebSocket
(`wss://rpc.mainnet.chain.robinhood.com`) was tested and does **not** work,
so don't set `RPC_WS_URL` to that. If you want true real-time push instead
of ~1s polling latency, sign up for [Alchemy](https://www.alchemy.com/rpc/robinhood)
(confirmed to support Robinhood Chain) and set both `RPC_HTTP_URL` and
`RPC_WS_URL` to your Alchemy app's endpoints instead — see the comments in
`.env.example`.

If it fails or the chain ID doesn't match `4663`, double-check
`RPC_HTTP_URL` in `.env` against https://docs.robinhood.com/chain/connecting.

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

### Steps 3-5 — full pipeline (scoring, DB, watchlist, Telegram, web dashboard)

```bash
# (Docker path) docker compose up -d postgres redis — skip if using Homebrew above
npm run db:migrate       # creates the Postgres schema
npm run dev               # or: npm run build && npm start
```

This single command starts the queue worker, the Telegram bot (if
`TELEGRAM_BOT_TOKEN` is set), the chain watchers, **and the web dashboard**
(http://localhost:3000 by default) together in one terminal. Every
deployment/pool/swap/burn event gets scored via `src/detection/rules.ts`,
persisted, and — once a wallet's score crosses `ALERT_SCORE_THRESHOLD`
(default 60) — pushed to your configured Telegram chat and shown on the
dashboard, with subsequent activity from that wallet triggering a lighter
"watchlisted wallet is active again" alert.

To run everything (including the bot) in Docker instead:

```bash
docker compose up -d --build
```

## Web dashboard

A small local dashboard for eyeballing what the bot has found, instead of
only reading terminal logs / Telegram:

```bash
npm run web        # standalone, if you just want the dashboard against
                    # data the bot already collected (e.g. from another
                    # terminal tab running `npm run dev`)
```

Or just leave it running as part of `npm run dev` / `npm start` — the
dashboard starts automatically alongside the bot. Open
**http://localhost:3000** (or whatever `WEB_PORT` is set to in `.env`).

It shows, refreshing every 5 seconds:
- Summary stats (tokens tracked, wallets seen, watchlist size, alerts in the last 24h)
- **⭐ Ví quan trọng**: every wallet you've starred (see below), gathered
  in one place regardless of where you found it
- **Watchlist**: every wallet that crossed the alert threshold, with its
  latest score and a button to remove it
- **Recent deployments**: every tracked token with its deployer, current
  risk score, and status badges (ERC-20-like? pool created? initial buy
  seen? rug detected?) — click a row to expand the full score breakdown
  (which rules fired and why)

Every wallet row (watchlist, deployments, cluster members/source, token
investigator results) carries two independent toggles, both persisted to
Postgres (`Wallet.checked`/`.starred`):
- ☑ **Đã check** — "I'm done with this, get rid of it": turns the tick
  **red** and immediately moves the wallet (or, for a cluster card's own
  checkbox, the whole cluster) into the **🗑 Đã xoá** section — it
  disappears from its normal list right away. From there it's a real
  countdown: if you don't un-check it (the "Khôi phục" button in that
  section) within **24 hours**, it's **permanently deleted** from the
  database — the wallet row itself, every token it deployed and all of
  that token's liquidity/swap/score events, its watchlist entry, and its
  fan-out cluster row if it was a cluster source. This is irreversible, so
  only check something once you're actually done looking at it. (Raw
  on-chain `FundingTransfer` records mentioning the address are left
  alone — that's chain history, not wallet bookkeeping.) The cleanup runs
  hourly (`src/db/trashRepository.ts`), plus once immediately on startup
  to catch up on anything that expired while the bot wasn't running.
- ⭐ **Quan trọng** — "keep an eye on this one" — highlights the row and
  adds it to the dedicated Ví quan trọng section above, so starred wallets
  stay easy to find no matter which table they came from. Checking a
  starred wallet still moves it to Trash — starring only means "important
  while it's still around," it doesn't protect against the 24-hour timer.

Cluster cards carry a third toggle in the header, next to the checkbox and
star: a purple **"D"** button marking the source address as a
**🧑‍💻 Ví Dev** — a wallet you've personally confirmed is a real dev worth
following, gathered into its own section (`Wallet.isDevWallet`). Unlike
starring, this one *does* protect against the trash timer: a dev-flagged
wallet is skipped by the checked-wallet cleanup even if it's also checked,
since the whole point is to keep it around for tracking.

### Token watch-list — save or lose it in 24h

The reverse of the wallet trash: every new deployment starts a 24-hour
countdown from its `deployedAt` (shown as a badge in its "Lưu?" column in
Deployment gần đây), and if you don't click **Lưu** within that window it's
**permanently deleted** — the deployment row and all of its
liquidity/swap/score events. Saved tokens move into the dedicated
**📌 Token đã lưu** section and stay there indefinitely (no timer) until you
click **Bỏ lưu**, which restarts nothing — it just removes the saved flag,
so an old unsaved deployment past its window is simply gone the next
cleanup pass. Runs on the same hourly loop as the wallet trash cleanup
(`runTokenCleanup` in `src/db/trashRepository.ts`).

Every address shown anywhere on the dashboard links out to its
**Zerion** wallet-overview page (`https://app.zerion.io/<address>/overview`)
so you can eyeball a wallet's balances/activity in one click. Note Zerion
may not index Robinhood Chain (chain ID 4663) specifically yet since it's a
very new L2 — the link still opens the address page, it just may not show
this chain's activity if Zerion hasn't added support for it.

Tables only re-render when their underlying data actually changed (a
per-row signature comparison) instead of on every 5s tick regardless — this
is what stops the dashboard from visibly flickering/jumping when nothing
new happened, which was most ticks.

It's a thin read-only Express API (`src/web/server.ts`) over the same
Postgres database the bot writes to, plus a single static HTML page
(`public/index.html`, vanilla JS, no build step) — nothing to compile or
deploy separately.

### Telegram bot setup

1. Create a bot via [@BotFather](https://t.me/BotFather), grab the token.
2. Add the bot to a chat/group/channel, find the chat ID (e.g. via
   `getUpdates` on the Bot API, or a helper bot like @userinfobot).
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`.
4. `/watchlist` in the chat lists currently-watchlisted wallets. `/clusters`
   lists detected wallet fan-out clusters (see below).

## Wallet cluster (fan-out) detection — copy-trade signals

Separate from the deployer risk-scoring above: this watches **every**
native-value transfer on the chain (`src/chain/valueTransferWatcher.ts`) —
no minimum amount by default, so cross-chain bridge deposits landing on
Robinhood Chain (which can be small or odd amounts) aren't filtered out —
and looks for a single funding source that just fanned money out to several
other wallets in one tight burst. Two independent signals can trigger a
cluster:

- **`fresh`** — the classic pattern: the source funded `FANOUT_MIN_WALLETS`
  (default 3) or more **brand-new burner wallets** (nonce 0, never sent a
  transaction before) — a dev prepping fake buyer wallets, or a
  multi-wallet sniper spinning up fresh wallets to buy a new listing.
- **`amount`** — a newer signal for when funds go **directly from an
  exchange/bridge wallet into wallets that already have history** (so they
  aren't "fresh"): if that source sent `FANOUT_MIN_WALLETS`+ wallets a
  near-identical amount (within `FANOUT_AMOUNT_TOLERANCE_PCT`) close
  together in time, those are flagged as one cluster too — this is what
  catches "one person's several source wallets all got topped up by the
  exchange at the same time" even when none of them are brand new.

A cluster that fires both signals at once is labeled `fresh+amount`. Either
way it's flagged and shown in the dashboard's "Cụm ví nghi vấn" section
(with a badge — 🆕 ví mới / 💰 cùng số tiền / 🆕💰 cả hai — so you can see at
a glance why it was flagged) and via a Telegram alert. Non-fresh members are
tagged "ví cũ" in the member list so you know that one was reused, not new.

"Burst" means **members must be funded close to each other in time**, not
just within some window measured from *now*: consecutive fundings from the
same source can be at most `FANOUT_MAX_GAP_MINUTES` (default 10) apart — if
a source funds wallet A, then wallet B two hours later, that's two separate
bursts, not one cluster, even though both are within the outer
`FANOUT_LOOKBACK_HOURS` lookback the query considers.

Cluster cards stay expanded across the dashboard's 5s auto-refresh once
opened. Forgot which cluster a wallet belonged to? Paste its address into
the small lookup box above the cluster list — it finds and auto-opens the
matching cluster card for you. Each member row also shows how much was
sent to fund it, converted to USD (`src/chain/priceService.ts`, ETH/USD
from CoinGecko, cached 5 min) — shows `$?` if the price fetch fails, never
a wrong number. Click the ⭐ on a card's header to star the *whole cluster*
(separate from starring individual member wallets below it) — starred
clusters get a gold border and always sort to the top of the list, so an
important cluster stays easy to find regardless of how recently it updated.
There's also a checkbox right next to it — that marks the cluster's
**source wallet itself** as checked (turns the same red tick used
everywhere else), independent of checking individual member wallets below.

From then on, **any purchase by a wallet belonging to that cluster on a
freshly-launched token** fires an immediate, separate Telegram alert
("🎯 Cluster wallet buying") — independent of the deployer's own risk score.
That's the actionable moment: the alert names the buyer wallet and the
token, so you can react fast (e.g. add that wallet to a copy-trading tool
like Bloom EVM) while it's still early.

Tuning (`.env`):
- `FANOUT_MIN_WALLETS` — lower catches clusters faster but with more false
  positives (e.g. a legitimate faucet or exchange hot wallet funding many
  users also looks like a fan-out); higher requires more confirmation first.
- `FANOUT_MIN_VALUE_ETH` — 0 (default) means no minimum at all. Only raise
  this if dust transfers become real noise; leaving it at 0 is what lets
  small/odd bridge-deposit amounts get caught.
- `FANOUT_LOOKBACK_HOURS` — outer cap on how far back a source's history is
  even pulled before burst-splitting; doesn't affect how tight a burst is.
- `FANOUT_MAX_GAP_MINUTES` — the actual "how close together" knob. Lower it
  if you only want very tight, obviously-automated bursts (e.g. a script
  firing off wallets seconds apart); raise it if genuine operations in your
  experience are spread a bit further apart than the default 10 minutes.
- `FANOUT_AMOUNT_TOLERANCE_PCT` — how close two amounts must be (as a % of
  the smaller one) to count as "the same amount" for the `amount` signal.

Note: this is a heuristic, not proof of coordinated behavior — verify a
flagged cluster's wallets yourself on the explorer before acting on it, and
be aware that copy-trading brand-new memecoins is extremely high risk
regardless of how the wallet was found (rugs, honeypots, and wallets that
buy early but still lose money are all common on this chain — see
`docs/ROBINHOOD_CHAIN_FACTS.md`).

## Token investigator — find the dev wallet behind a fake-buyer batch

Paste any token address into the "Kiểm tra token" panel at the top of the
dashboard (or run `npm run investigate -- 0xTokenAddress` from the
terminal) and the bot scans its first 100 buyers (earliest first) —
including tokens it never tracked itself (deployed before the bot was
running), by inferring the pool address from the token's own transfer
history when needed.

It's a hard filter, not a fuzzy score: a buyer is only listed if it's
**both**:

1. A brand-new wallet — nonce 0, never sent a transaction before.
2. Has never bought/received any ERC-20 token other than this one, ever —
   a real trader's wallet has other tokens in its history; a throwaway
   wallet spun up to fake-buy one launch usually doesn't.

Among just that qualifying list, it looks at who funded each one (the same
funding-source lookup used for deployer scoring) and, if **2 or more** of
them were funded by the *same* wallet, surfaces that wallet as the
**suspected dev wallet** in a callout above the results table — the one
worth adding to follow/watchlist via its ⭐ button. Each qualifying row
also shows its own funding source and flags when multiple qualifying
buyers bought the exact same token amount (a scripted-batch signal). A
"Xoá kết quả" button clears the table — nothing from this tool is ever
written to the database, it's pure on-chain analysis shown on demand.

Analysis does up to 3 Blockscout lookups per scanned buyer
(`src/investigation/tokenInvestigator.ts`), so it can take a few seconds to
tens of seconds depending on how many buyers there were. The core
qualifying-filter and shared-funding-source logic is covered by an isolated
unit test in this repo's sandbox (mocked buyer data, since the actual
Blockscout token-transfer lookups can't be exercised against live data
there — egress blocked); run it once against a real token to confirm the
response shape still matches, per the usual Blockscout-API caveat in that
file.

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

- **Step 1 (HTTP RPC connectivity) is live-tested and confirmed working**
  against the public RPC — chain ID `4663`, real block numbers. Steps 2+
  (deployment/pool detection against real chain activity) still haven't
  been observed end-to-end against live traffic — run Step 2 and watch for
  real events before trusting the full pipeline.
- **Uniswap factory addresses unconfirmed** — see
  `docs/ROBINHOOD_CHAIN_FACTS.md`. The signature-based watcher is a
  reasonable stopgap but will also catch non-Uniswap forks.
- **Funding-source / serial-deployer backfill is best-effort**: it calls the
  Blockscout REST API (`src/chain/blockscoutClient.ts`), which may need
  adjusting if the instance's exact response shape differs from what's
  coded here (couldn't confirm firsthand — see the facts doc). Confirmed
  from a real run's terminal log that a bare `fetch()` with no headers gets
  **403'd by Blockscout's Cloudflare/WAF bot protection** even though the
  exact same address loads fine in a browser — fixed by sending
  browser-like `User-Agent`/`Accept` headers plus a couple of retries with
  backoff on 403/429 (verified against a local mock server: headers are
  sent on every attempt and a request that fails twice then succeeds is
  correctly picked up on the 3rd try). If 403s still show up in the log
  after this, Blockscout's bot protection has likely gotten stricter and
  the headers may need updating to match a current real browser's.
  Also confirmed from a real run: neither the v2 nor classic
  token-transfers fetch was paginating — each made exactly one API call
  and kept whatever fit in that single page (commonly ~50 items), so a
  token with real trading activity was silently capped down to a handful
  of buyers instead of the "first 100" the investigator is supposed to
  scan. Both now page through (v2 via `next_page_params`, classic via
  `page`/`offset`) until they've gathered enough items or run out of
  pages — verified against a local mock server that a 3-page response is
  fully accumulated (not just its first page) and that requesting fewer
  items than are available correctly stops early instead of over-fetching.
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
