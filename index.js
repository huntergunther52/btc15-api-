const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const SERIES = "KXBTC15M";
const VERSION = "3.3.0";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      ...cors,
      "content-type": "application/json"
    }
  });
}

function number(...values) {
  for (const value of values) {
    const x = Number(value);
    if (Number.isFinite(x)) return x;
  }
  return null;
}

function probabilityPrice(value) {
  const x = Number(value);

  if (!Number.isFinite(x)) return null;

  return x > 1 ? x / 100 : x;
}

function extractTarget(market) {
  const direct = number(
    market.floor_strike,
    market.strike,
    market.target,
    market.custom_strike?.target,
    market.custom_strike?.value
  );

  if (direct && direct > 1000) {
    return direct;
  }

  const possibleText = [
    market.functional_strike,
    market.subtitle,
    market.title,
    market.yes_sub_title
  ];

  for (const text of possibleText) {
    const match = String(text || "").match(
      /\$?\s*([0-9]{2,3}(?:,[0-9]{3})+(?:\.[0-9]+)?)/
    );

    if (match) {
      return Number(match[1].replaceAll(",", ""));
    }
  }

  return null;
}

async function kalshi(path) {
  const response = await fetch(KALSHI + path, {
    headers: {
      accept: "application/json"
    }
  });

  const raw = await response.text();

  let body;

  try {
    body = JSON.parse(raw);
  } catch {
    body = {
      raw: raw.slice(0, 1000)
    };
  }

  if (!response.ok) {
    throw new Error(
      `Kalshi ${response.status}: ${raw.slice(0, 250)}`
    );
  }

  return body;
}

/*
  Warm-isolate cache.

  Market metadata does not need to be requested every time
  the iPhone refreshes the dashboard.
*/

let marketCache = null;
let marketCacheAt = 0;

const MARKET_TTL = 5000;

async function getCurrentMarket() {
  const now = Date.now();

  if (
    marketCache &&
    now - marketCacheAt < MARKET_TTL
  ) {
    return {
      market: marketCache,
      cached: true,
      cacheAgeMs: now - marketCacheAt
    };
  }

  const query = new URLSearchParams({
    series_ticker: SERIES,
    status: "open",
    limit: "50"
  });

  const data = await kalshi(
    `/markets?${query.toString()}`
  );

  const candidates = (data.markets || [])
    .filter(market => {
      const close = Date.parse(
        market.close_time ||
        market.expiration_time ||
        market.expected_expiration_time ||
        0
      );

      return close > now - 30000;
    })
    .sort((a, b) => {
      const aClose = Date.parse(
        a.close_time ||
        a.expiration_time ||
        a.expected_expiration_time
      );

      const bClose = Date.parse(
        b.close_time ||
        b.expiration_time ||
        b.expected_expiration_time
      );

      return aClose - bClose;
    });

  if (!candidates.length) {
    throw new Error(
      "No open KXBTC15M market returned by Kalshi."
    );
  }

  marketCache = candidates[0];
  marketCacheAt = now;

  return {
    market: marketCache,
    cached: false,
    cacheAgeMs: 0
  };
}

async function current() {
  const result = await getCurrentMarket();
  const m = result.market;

  const closeTime =
    m.close_time ||
    m.expiration_time ||
    m.expected_expiration_time;

  const closeMs = Date.parse(closeTime);
  const now = Date.now();

  const remainingMs =
    Number.isFinite(closeMs)
      ? Math.max(0, closeMs - now)
      : null;

  return {
    ok: true,

    version: VERSION,

    server_time:
      new Date(now).toISOString(),

    source:
      "Kalshi market API",

    architecture: {
      kalshi_market_data: true,

      kalshi_live_data: false,

      live_price_strategy:
        "frontend_stream",

      reason:
        "Kalshi live_data endpoint disabled to prevent 429 rate-limit failures."
    },

    market: {
      ticker: m.ticker,

      event_ticker:
        m.event_ticker,

      title:
        m.title,

      subtitle:
        m.subtitle,

      close_time:
        closeTime,

      target:
        extractTarget(m),

      yes_bid:
        probabilityPrice(
          m.yes_bid_dollars ??
          m.yes_bid
        ),

      yes_ask:
        probabilityPrice(
          m.yes_ask_dollars ??
          m.yes_ask
        ),

      no_bid:
        probabilityPrice(
          m.no_bid_dollars ??
          m.no_bid
        ),

      no_ask:
        probabilityPrice(
          m.no_ask_dollars ??
          m.no_ask
        )
    },

    timing: {
      ms_remaining:
        remainingMs,

      seconds_remaining:
        remainingMs == null
          ? null
          : remainingMs / 1000,

      final_60:
        remainingMs != null &&
        remainingMs > 0 &&
        remainingMs <= 60000
    },

    cache: {
      market_cached:
        result.cached,

      market_cache_age_ms:
        result.cacheAgeMs
    }
  };
}

export default {
  async fetch(request) {

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: cors
      });
    }

    const url =
      new URL(request.url);

    try {

      if (
        url.pathname === "/" ||
        url.pathname === "/health"
      ) {
        return json({
          ok: true,

          service:
            "btc15-api",

          version:
            VERSION,

          architecture:
            "kalshi-market-plus-frontend-live-stream",

          time:
            new Date().toISOString()
        });
      }

      if (
        url.pathname === "/api/current"
      ) {
        return json(
          await current()
        );
      }

      return json(
        {
          ok: false,

          error:
            "Not found",

          routes: [
            "/health",
            "/api/current"
          ]
        },
        404
      );

    } catch (error) {

      return json(
        {
          ok: false,

          version:
            VERSION,

          error:
            String(
              error?.message ||
              error
            ),

          time:
            new Date().toISOString()
        },
        502
      );
    }
  }
};
