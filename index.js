const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const SERIES = "KXBTC15M";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};

const out = (obj,status=200) =>
  new Response(JSON.stringify(obj,null,2),{
    status,
    headers:{...cors,"content-type":"application/json"}
  });

function n(...xs){
  for(const x of xs){
    const v=Number(x);
    if(Number.isFinite(v)) return v;
  }
  return null;
}

function px(v){
  v=Number(v);
  if(!Number.isFinite(v)) return null;
  return v>1?v/100:v;
}

function strike(m){
  let v=n(
    m.floor_strike,
    m.strike,
    m.target,
    m.custom_strike?.target,
    m.custom_strike?.value
  );

  if(v && v>1000) return v;

  for(const s of [
    m.functional_strike,
    m.subtitle,
    m.title,
    m.yes_sub_title
  ]){
    const z=String(s||"").match(
      /\$?\s*([0-9]{2,3}(?:,[0-9]{3})+(?:\.[0-9]+)?)/
    );
    if(z) return Number(z[1].replaceAll(",",""));
  }

  return null;
}

async function kj(path){
  const r=await fetch(KALSHI+path,{
    headers:{"accept":"application/json"}
  });

  const text=await r.text();

  let body;
  try{ body=JSON.parse(text); }
  catch{ body={raw:text.slice(0,1000)}; }

  if(!r.ok){
    const err=new Error(`${r.status} ${path}: ${text.slice(0,250)}`);
    err.status=r.status;
    throw err;
  }

  return body;
}

function harvest(o,a=[]){
  if(!o) return a;

  if(Array.isArray(o)){
    for(const x of o) harvest(x,a);
    return a;
  }

  if(typeof o==="object"){
    const p=n(
      o.price,
      o.value,
      o.index_value,
      o.close,
      o.y,
      o.v
    );

    const raw=
      o.ts ??
      o.timestamp ??
      o.time ??
      o.t ??
      o.datetime;

    if(p && p>1000 && raw!=null){
      let t;

      if(typeof raw==="number"){
        t=raw<1e12 ? raw*1000 : raw;
      }else{
        t=Date.parse(raw);
      }

      if(Number.isFinite(t)){
        a.push({t,p});
      }
    }

    for(const v of Object.values(o)){
      if(v && typeof v==="object"){
        harvest(v,a);
      }
    }
  }

  return a;
}

/*
 Cloudflare isolate memory.

 This dramatically reduces duplicate calls while an isolate is warm.
 The browser may poll frequently, but Kalshi live-data is only refreshed
 on our controlled interval.
*/

let marketCache=null;
let marketCacheAt=0;

let liveCache={
  event:null,
  points:[],
  latest:null,
  fetchedAt:0,
  error:null
};

const MARKET_TTL=10000;
const LIVE_TTL=10000;

function dedupePoints(points){
  const bySecond=new Map();

  for(const x of points){
    if(!Number.isFinite(x?.t) || !Number.isFinite(x?.p)) continue;

    const sec=Math.floor(x.t/1000)*1000;

    /*
      If several observations occur inside the same second,
      retain the most recent observation for that second.
    */
    bySecond.set(sec,{
      t:sec,
      p:x.p
    });
  }

  return [...bySecond.values()]
    .sort((a,b)=>a.t-b.t)
    .slice(-900);
}

async function getMarket(){
  const now=Date.now();

  if(marketCache && now-marketCacheAt<MARKET_TTL){
    return marketCache;
  }

  const q=new URLSearchParams({
    series_ticker:SERIES,
    status:"open",
    limit:"50"
  });

  const data=await kj(`/markets?${q}`);

  const arr=(data.markets||[])
    .filter(m=>{
      const close=Date.parse(
        m.close_time ||
        m.expiration_time ||
        m.expected_expiration_time ||
        0
      );

      return close>now-30000;
    })
    .sort((a,b)=>{
      const ac=Date.parse(
        a.close_time ||
        a.expiration_time ||
        a.expected_expiration_time
      );

      const bc=Date.parse(
        b.close_time ||
        b.expiration_time ||
        b.expected_expiration_time
      );

      return ac-bc;
    });

  if(!arr.length){
    throw new Error("No open KXBTC15M market returned by Kalshi.");
  }

  marketCache=arr[0];
  marketCacheAt=now;

  return marketCache;
}

async function getLive(eventTicker){
  const now=Date.now();

  /*
    New 15-minute event:
    reset old event observations.
  */
  if(liveCache.event!==eventTicker){
    liveCache={
      event:eventTicker,
      points:[],
      latest:null,
      fetchedAt:0,
      error:null
    };
  }

  /*
    Don't hit Kalshi again if we queried recently.
  */
  if(now-liveCache.fetchedAt<LIVE_TTL){
    return liveCache;
  }

  /*
    Mark the attempt immediately. This helps prevent simultaneous browser
    requests from each triggering another Kalshi request.
  */
  liveCache.fetchedAt=now;

  try{
    const raw=await kj(
      `/live_data/events/${encodeURIComponent(eventTicker)}?range=15min`
    );

    const incoming=harvest(raw);

    liveCache.points=dedupePoints([
      ...liveCache.points,
      ...incoming
    ]);

    liveCache.latest=
      liveCache.points.length
        ? liveCache.points[liveCache.points.length-1]
        : liveCache.latest;

    liveCache.error=null;

  }catch(e){

    /*
      CRITICAL:
      A 429 no longer destroys the last valid price data.
      We keep serving the last successful observations.
    */
    liveCache.error=String(e.message||e);
  }

  return liveCache;
}

function settlementStats(points,closeTime,target){
  const close=Date.parse(closeTime);

  if(
    !Number.isFinite(close) ||
    !Number.isFinite(target)
  ){
    return null;
  }

  const start=close-60000;

  /*
    Exactly one observation per second inside the final settlement minute.
  */
  const final=dedupePoints(points)
    .filter(x=>x.t>=start && x.t<close);

  const locked=final.length;

  if(!locked){
    return {
      active:Date.now()>=start,
      locked:0,
      running_average:null,
      average_needed:null,
      cushion:null
    };
  }

  const sum=final.reduce((s,x)=>s+x.p,0);
  const avg=sum/locked;

  let needed=null;

  if(locked<60){
    needed=((target*60)-sum)/(60-locked);
  }

  const latest=final[final.length-1]?.p ?? null;

  return {
    active:true,
    locked,
    running_average:avg,
    average_needed:needed,
    cushion:
      Number.isFinite(latest) &&
      Number.isFinite(needed)
        ? latest-needed
        : null
  };
}

async function current(){
  const m=await getMarket();

  const closeTime=
    m.close_time ||
    m.expiration_time ||
    m.expected_expiration_time;

  const target=strike(m);

  const live=m.event_ticker
    ? await getLive(m.event_ticker)
    : {
        points:[],
        latest:null,
        error:"No event ticker"
      };

  const stats=settlementStats(
    live.points,
    closeTime,
    target
  );

  return {
    ok:true,
    version:"3.2",
    server_time:new Date().toISOString(),
    source:"Kalshi public API",

    market:{
      ticker:m.ticker,
      event_ticker:m.event_ticker,
      title:m.title,
      subtitle:m.subtitle,
      close_time:closeTime,
      target,

      yes_bid:px(
        m.yes_bid_dollars ??
        m.yes_bid
      ),

      yes_ask:px(
        m.yes_ask_dollars ??
        m.yes_ask
      ),

      no_bid:px(
        m.no_bid_dollars ??
        m.no_bid
      ),

      no_ask:px(
        m.no_ask_dollars ??
        m.no_ask
      )
    },

    live:{
      available:live.points.length>0,
      stale:
        live.latest
          ? Date.now()-live.latest.t>15000
          : true,

      latest:live.latest,

      /*
        Keep enough history for calculations without sending
        unnecessary amounts to the phone.
      */
      points:live.points.slice(-180),

      error:live.error,
      last_attempt:
        live.fetchedAt
          ? new Date(live.fetchedAt).toISOString()
          : null
    },

    settlement:stats
  };
}

export default {
  async fetch(req){
    if(req.method==="OPTIONS"){
      return new Response(null,{headers:cors});
    }

    const u=new URL(req.url);

    try{

      if(
        u.pathname==="/" ||
        u.pathname==="/health"
      ){
        return out({
          ok:true,
          service:"btc15-api",
          version:"3.2",
          time:new Date().toISOString()
        });
      }

      if(u.pathname==="/api/current"){
        return out(await current());
      }

      return out({
        ok:false,
        error:"Not found",
        routes:[
          "/health",
          "/api/current"
        ]
      },404);

    }catch(e){

      return out({
        ok:false,
        error:String(e.message||e),
        time:new Date().toISOString()
      },502);
    }
  }
};
