const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const SERIES = "KXBTC15M";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};

const out = (obj, status=200) =>
  new Response(JSON.stringify(obj, null, 2), {status, headers:{...cors,"content-type":"application/json"}});

function n(...xs){ for(const x of xs){ const v=Number(x); if(Number.isFinite(v)) return v; } return null; }

function strike(m){
  let v=n(m.floor_strike,m.strike,m.target,m.custom_strike?.target,m.custom_strike?.value);
  if(v && v>1000) return v;
  for(const s of [m.functional_strike,m.subtitle,m.title,m.yes_sub_title]){
    const z=String(s||"").match(/\$?\s*([0-9]{2,3}(?:,[0-9]{3})+(?:\.[0-9]+)?)/);
    if(z) return Number(z[1].replaceAll(",",""));
  }
  return null;
}
function px(v){ v=Number(v); if(!Number.isFinite(v)) return null; return v>1?v/100:v; }

async function kj(path){
  const r=await fetch(KALSHI+path,{headers:{"accept":"application/json"}});
  const text=await r.text();
  let body; try{body=JSON.parse(text)}catch{body={raw:text.slice(0,1000)}}
  if(!r.ok) throw new Error(`${r.status} ${path}: ${text.slice(0,250)}`);
  return body;
}
function harvest(o,a=[]){
  if(!o) return a;
  if(Array.isArray(o)){ for(const x of o) harvest(x,a); return a; }
  if(typeof o==="object"){
    const p=n(o.price,o.value,o.index_value,o.close,o.y,o.v);
    const raw=o.ts??o.timestamp??o.time??o.t??o.datetime;
    if(p && p>1000 && raw!=null){
      let t=typeof raw==="number"?(raw<1e12?raw*1000:raw):Date.parse(raw);
      if(Number.isFinite(t)) a.push({t,p});
    }
    for(const v of Object.values(o)) if(v && typeof v==="object") harvest(v,a);
  }
  return a;
}

async function current(){
  const q=new URLSearchParams({series_ticker:SERIES,status:"open",limit:"50"});
  const data=await kj(`/markets?${q}`);
  const now=Date.now();
  const arr=(data.markets||[])
    .filter(m=>Date.parse(m.close_time||m.expiration_time||m.expected_expiration_time||0)>now-30000)
    .sort((a,b)=>Date.parse(a.close_time||a.expiration_time)-Date.parse(b.close_time||b.expiration_time));
  if(!arr.length) throw new Error("No open KXBTC15M market returned by Kalshi.");
  const m=arr[0];
  let live=null, live_error=null, points=[];
  if(m.event_ticker){
    try{
      live=await kj(`/live_data/events/${encodeURIComponent(m.event_ticker)}?range=15min`);
      points=harvest(live).sort((a,b)=>a.t-b.t);
    }catch(e){live_error=String(e.message||e)}
  }
  return {
    ok:true,
    server_time:new Date().toISOString(),
    source:"Kalshi public API",
    market:{
      ticker:m.ticker,event_ticker:m.event_ticker,title:m.title,subtitle:m.subtitle,
      close_time:m.close_time||m.expiration_time||m.expected_expiration_time,
      target:strike(m),
      yes_bid:px(m.yes_bid_dollars??m.yes_bid),
      yes_ask:px(m.yes_ask_dollars??m.yes_ask),
      no_bid:px(m.no_bid_dollars??m.no_bid),
      no_ask:px(m.no_ask_dollars??m.no_ask)
    },
    live:{
      available:points.length>0,
      latest:points.length?points.at(-1):null,
      points:points.slice(-180),
      error:live_error
    }
  };
}

export default {
 async fetch(req){
  if(req.method==="OPTIONS") return new Response(null,{headers:cors});
  const u=new URL(req.url);
  try{
    if(u.pathname==="/" || u.pathname==="/health")
      return out({ok:true,service:"btc15-api",version:"2.0.0",time:new Date().toISOString()});
    if(u.pathname==="/api/current") return out(await current());
    return out({ok:false,error:"Not found",routes:["/health","/api/current"]},404);
  }catch(e){
    return out({ok:false,error:String(e.message||e),time:new Date().toISOString()},502);
  }
 }
};
