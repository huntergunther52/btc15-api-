# BTC15 API

Cloudflare Worker bridge for the BTC15 Signal iPhone app.

Routes:
- `/health` — backend health check
- `/api/current` — current open KXBTC15M market, strike, bid/ask, and Kalshi event live-data observations when Kalshi exposes them.

## Cloudflare
Connect this repository to Cloudflare Workers Builds. Build command: `npx wrangler deploy`.
No secrets are required for this public-data bridge.

## Safety / data integrity
The Worker does not invent settlement data. `live.available` is false when Kalshi's event live-data endpoint does not return usable observations. The frontend should visibly fall back rather than treating another exchange as official settlement data.
