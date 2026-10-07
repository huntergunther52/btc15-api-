# BTC15 automatic trading — review package

This package is a working implementation with mocked tests. It has **not been deployed, enabled, or tested against a Kalshi trading account**. The production BTC15 site and its saved history remain unchanged. The supplied configuration explicitly disables automatic trading.

## Entry and exit behavior

- Only existing Scalp TRADE signals with score >= 0.90 qualify. The score is not a calibrated 90% win probability.
- Fresh market close time must leave 15–480 seconds inclusive. This is the final eight minutes, not the first eight minutes of a window.
- Entry uses a fresh ask no higher than the signal entry price. An immediate-or-cancel limit order buys only what fills. Estimated premium plus conservatively rounded taker fees must fit within a $5 budget and the available balance. An exchange fee change can affect that estimate.
- One bot position at a time; at most one attempted entry per ticker and side. An existing position or resting order in that market blocks entry.
- Existing signal target and stop are retained. Exit uses the observed sell bid with a reduce-only immediate-or-cancel order. Timeout triggers after 90 seconds, or with 15 seconds remaining. The timer starts at entry submission, conservatively before confirmation.
- Partial exits retain the position and retry only the confirmed remainder. The exit trigger stays latched. This is a software stop, not an exchange-native guaranteed stop.
- Monitoring uses BTC15's existing background alarm and feed polling (normally around 10 seconds when no browser is polling). Actual holding periods can exceed 90 seconds. Network outages, price gaps, and thin liquidity can prevent or delay exits.
- Actual exchange fills and reported fees determine realized P&L. Pending/partial positions are not marked closed. Unfilled entries are saved separately as UNFILLED records with zero P&L.
- Existing paper history, notifications, and parallel experiments keep their existing keys and strategy. The live ledger uses `autoTrading:v1` only.

## Files

- `auto-engine.mjs`: persistent serialized order state machine and signed Kalshi adapter.
- `worker-autotrading.js`: integration wrapper around the current BTC15 Worker, without changing the paper strategy.
- `owner-panel.html` / `.mjs`: owner controls served at `/auto` after deployment. The HTML is also included for inspection.
- `worker-v450.js`, `worker-v425.js`, `index.js`: authoritative existing backend dependencies copied from GitHub on October 7, 2026. Baseline Worker is 5.0.6.
- `wrangler.jsonc`: preserves the existing Worker name, Durable Object class/name, and v1 migration; defaults AUTO_TRADING_MODE to disabled.
- Tests: run `npm test` in this directory. Node 22 or later is appropriate. No npm dependencies are required for the tests.

## Owner deployment and testing

These steps are for you or your developer to perform. Never paste credentials into GitHub source, a public BTC15 page, or chat.

1. Back up the existing repository, confirm the baseline has not changed, and review this implementation. The package targets `huntergunther52/btc15-api-` and replaces the Wrangler entrypoint with `worker-autotrading.js`. Preserve all current Cloudflare secrets and namespace bindings. Do not create a new Durable Object class or delete/migrate its storage.
2. Add the package's new engine, wrapper, and owner panel module to the backend repository. Update Wrangler from the supplied config. Keep `AUTO_TRADING_MODE: disabled` for the initial deployment. No changes to the GitHub Pages frontend are needed. Its existing paper results will continue to work.
3. Create a random owner token of at least 32 characters, and store it as the Cloudflare Worker **secret** `AUTO_TRADING_OWNER_TOKEN`. Keep the existing Kalshi credentials as Worker secrets. The owner token grants order-control access; do not share it or commit it.
4. Before using production, test in a **separate demo Worker and separate Durable Object namespace**, using Kalshi demo API credentials. Set `AUTO_TRADING_MODE` to `demo` in that test deployment. Demo calls use `https://external-api.demo.kalshi.co/trade-api/v2`; live calls use `https://external-api.kalshi.com/trade-api/v2`. Use an eligible BTC15 demo market if available; the live BTC discovery ticker may not exist in demo, so full feed-to-demo validation may need demo-market fixtures. A demo credential must never be mixed with the live deployment.
5. Open the demo Worker's `/auto` page, enter the owner token, and refresh status. Verify authentication, expected mode, and empty position. Type ENABLE and click Enable automatic trading yourself to authorize demo trading. Test an entry, a target exit, a stop, a timeout, an unfilled entry, and a partial exit. Confirm resulting positions and fees in Kalshi. The mocked tests do not replace this exchange validation.
6. Only after reviewing the results, you can choose to set `AUTO_TRADING_MODE` to `live` on the production deployment using your production Kalshi credentials. This configuration change alone does not enable entries: the stored `enabled` value defaults to false. Open `/auto`, verify the mode and rule settings, enter your owner token, type ENABLE, and activate it yourself.
7. Keep the owner status page and your Kalshi account available during initial operation. Look for `paused`, `position.remaining`, order IDs, and the actual filled position—not just the paper signal. Do not trade the same contract manually while the bot is managing it.

The `/api/auto/status` and `/api/auto/control` routes require the owner Bearer token. The public `/auto` page contains no credentials; entering a token does not persist it in browser storage. Do not store the token in the existing public frontend.

## Stopping and reconciling

- **Stop new entries** sets enabled=false but continues managing an existing bot position while the configured mode remains live/demo. Do not switch the deployment to disabled or remove its credentials while a position still needs an exit.
- An uncertain POST response never triggers a blind resubmission. The durable intent and client order ID are saved first. Use **Reconcile paused position** after checking the actual account. Reconciliation searches orders and confirms fills. It does not enable new entries.
- Missing/inconsistent fills, an unexpected resting IOC order, a different account position, pagination failure, or a closed market with a position pauses new orders. A later manual reconciliation must succeed before management resumes. If the market closes, inspect the position/settlement in Kalshi; this version does not automatically reconcile settlement into the closed-trade ledger.
- Do not delete `autoTrading:v1`, clear its seen list, or reset an unresolved intent to retry an order. This can create duplicate exposure. If an accepted order cannot be identified or you changed the position manually, reconcile the account directly and have a developer inspect the ledger.
- Order placement, fills and liquidity are not guaranteed. This package has no live exchange execution validation, websocket execution feed, exchange-native stop, or automatic settlement accounting. It is a review/test implementation, not a claim of production readiness or profitability.

## Verification performed

Twelve mocked engine scenarios plus integration checks cover the score/time boundaries, YES/NO book mapping, disabled-mode guard, owner authentication, fee-aware sizing, target/stop/timeout exits, partial fills, deduplication, lost POST response and restart recovery, manual-account mismatch, and preservation of old paper history/subscriptions. All pass. No production or demo orders were submitted during development.

## Primary references used

- https://docs.kalshi.com/openapi.yaml (retrieved October 7, 2026)
- https://docs.kalshi.com/getting_started/quick_start_create_order
- https://docs.kalshi.com/getting_started/quick_start_authenticated_requests
- https://docs.kalshi.com/getting_started/orderbook_responses

The current schema uses `/portfolio/events/orders`, fixed-point `bid`/`ask` requests, IOC time-in-force, and reduce_only for exits. YES and NO are mapped to the single YES-price book. Authentication uses RSA-PSS/SHA256 as in the existing BTC15 connection.
