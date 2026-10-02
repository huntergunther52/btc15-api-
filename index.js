const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const SERIES = "KXBTC15M";
const VERSION = "4.1.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { ...cors, "content-type": "application/json" } });
}
function number(...values) { for (const value of values) { const x = Number(value); if (Number.isFinite(x)) return x; } return null; }
function probabilityPrice(value) { const x = Number(value); return Number.isFinite(x) ? (x > 1 ? x / 100 : x) : null; }
function extractTarget(market) {
  const direct = number(market.floor_strike, market.strike, market.target, market.custom_strike?.target, market.custom_strike?.value);
  if (direct && direct > 1000) return direct;
  for (const text of [market.functional_strike, market.subtitle, market.title, market.yes_sub_title]) {
    const match = String(text || "").match(/\$?\s*([0-9]{2,3}(?:,[0-9]{3})+(?:\.[0-9]+)?)/);
    if (match) return Number(match[1].replaceAll(",", ""));
  }
  return null;
}
async function kalshi(path) {
  const response = await fetch(KALSHI + path, { headers: { accept: "application/json" } });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Kalshi ${response.status}: ${raw.slice(0,250)}`);
  try { return JSON.parse(raw); } catch { throw new Error("Kalshi returned invalid JSON"); }
}

/* Durable Object: keeps a rolling BTC spot history alive on Cloudflare even when the phone is backgrounded. */
export class PriceHistory {
  constructor(state) {
    this.state = state;
    this.points = null;
    this.tick = 0;
  }
  async load() {
    if (this.points) return;
    this.points = (await this.state.storage.get("points")) || [];
  }
  async sample() {
    await this.load();
    try {
      const r = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot", { headers: { accept: "application/json" } });
      if (r.ok) {
        const d = await r.json();
        const p = Number(d?.data?.amount);
        const t = Date.now();
        if (Number.isFinite(p)) {
          this.points.push({ t, p });
          this.points = this.points.filter(x => t - x.t <= 600000).slice(-650);
          this.tick++;
          if (this.tick % 5 === 0) await this.state.storage.put("points", this.points);
        }
      }
    } catch {}
    await this.state.storage.setAlarm(Date.now() + 1000);
  }
  async alarm() { await this.sample(); }
  async fetch(request) {
    await this.load();
    const url = new URL(request.url);
    const alarm = await this.state.storage.getAlarm();
    if (!alarm) await this.state.storage.setAlarm(Date.now() + 100);
    if (url.pathname.endsWith("/snapshot")) {
      const now = Date.now();
      const pts = this.points.filter(x => now - x.t <= 300000);
      return json({ ok:true, latest:pts.length ? pts[pts.length-1] : null, points:pts, samples:pts.length, persistent:true });
    }
    return json({ok:true});
  }
}

let marketCache = null, marketCacheAt = 0;
const MARKET_TTL = 4000;
async function getCurrentMarket() {
  const now = Date.now();
  if (marketCache && now - marketCacheAt < MARKET_TTL) return { market:marketCache, cached:true, cacheAgeMs:now-marketCacheAt };
  const query = new URLSearchParams({ series_ticker:SERIES, status:"open", limit:"50" });
  const data = await kalshi(`/markets?${query}`);
  const candidates = (data.markets || []).filter(m => Date.parse(m.close_time || m.expiration_time || m.expected_expiration_time || 0) > now - 30000)
    .sort((a,b) => Date.parse(a.close_time || a.expiration_time) - Date.parse(b.close_time || b.expiration_time));
  if (!candidates.length) throw new Error("No open KXBTC15M market returned by Kalshi.");
  marketCache = candidates[0]; marketCacheAt = now;
  return { market:marketCache, cached:false, cacheAgeMs:0 };
}
async function btcSnapshot(env) {
  const id = env.PRICE_HISTORY.idFromName("btc-usd");
  const stub = env.PRICE_HISTORY.get(id);
  const r = await stub.fetch("https://collector/snapshot");
  return r.json();
}
async function current(env) {
  const [result, btc] = await Promise.all([getCurrentMarket(), btcSnapshot(env)]);
  const m = result.market;
  const closeTime = m.close_time || m.expiration_time || m.expected_expiration_time;
  const closeMs = Date.parse(closeTime), now = Date.now();
  const remainingMs = Number.isFinite(closeMs) ? Math.max(0, closeMs-now) : null;
  return {
    ok:true, version:VERSION, server_time:new Date(now).toISOString(), source:"Kalshi + Coinbase backend collector",
    architecture:{ kalshi_market_data:true, backend_btc_history:true, persistent_collector:true, live_price_strategy:"cloudflare_durable_object" },
    market:{ ticker:m.ticker, event_ticker:m.event_ticker, title:m.title, subtitle:m.subtitle, close_time:closeTime, target:extractTarget(m), yes_bid:probabilityPrice(m.yes_bid_dollars ?? m.yes_bid), yes_ask:probabilityPrice(m.yes_ask_dollars ?? m.yes_ask), no_bid:probabilityPrice(m.no_bid_dollars ?? m.no_bid), no_ask:probabilityPrice(m.no_ask_dollars ?? m.no_ask) },
    btc,
    timing:{ ms_remaining:remainingMs, seconds_remaining:remainingMs==null?null:remainingMs/1000, final_60:remainingMs!=null&&remainingMs>0&&remainingMs<=60000 },
    cache:{ market_cached:result.cached, market_cache_age_ms:result.cacheAgeMs }
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null,{headers:cors});
    const url = new URL(request.url);
    try {
      if (url.pathname === "/" || url.pathname === "/health") {
        const btc = await btcSnapshot(env);
        return json({ok:true,service:"btc15-api",version:VERSION,architecture:"persistent-backend-btc-history",btc_samples:btc.samples,time:new Date().toISOString()});
      }
      if (url.pathname === "/api/current") return json(await current(env));
      return json({ok:false,error:"Not found",routes:["/health","/api/current"]},404);
    } catch (error) {
      return json({ok:false,version:VERSION,error:String(error?.message||error),time:new Date().toISOString()},502);
    }
  }
};
