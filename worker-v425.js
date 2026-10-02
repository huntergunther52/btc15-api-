import legacy, { PriceHistory } from "./index.js";
export { PriceHistory };

const VERSION = "4.2.5";
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const SERIES = "KXBTC15M";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,DELETE,OPTIONS","Access-Control-Allow-Headers":"Content-Type","Cache-Control":"no-store"};
const json=(o,s=200)=>new Response(JSON.stringify(o,null,2),{status:s,headers:{...cors,"content-type":"application/json"}});
const num=(...xs)=>{for(const x of xs){const n=Number(x);if(Number.isFinite(n))return n}return null};
const pp=v=>{const n=Number(v);return Number.isFinite(n)?(n>1?n/100:n):null};
const closeOf=m=>Date.parse(m?.close_time||m?.expiration_time||m?.expected_expiration_time||0);
function target(m){if(!m)return null;const d=num(m.floor_strike,m.strike,m.target,m.custom_strike?.target,m.custom_strike?.value);if(d&&d>1000)return d;for(const s of[m.functional_strike,m.subtitle,m.title,m.yes_sub_title]){const z=String(s||"").match(/\$?\s*([0-9]{2,3}(?:,[0-9]{3})+(?:\.[0-9]+)?)/);if(z)return Number(z[1].replaceAll(",",""))}return null}
async function get(path){const r=await fetch(KALSHI+path,{headers:{accept:"application/json"},cf:{cacheTtl:0}});if(!r.ok)throw Error(`Kalshi ${r.status}: ${(await r.text()).slice(0,160)}`);return r.json()}
function choose(markets){const now=Date.now();return (markets||[]).filter(m=>m&&m.ticker&&closeOf(m)>now+5000).sort((a,b)=>closeOf(a)-closeOf(b))[0]||null}
async function discover(){
  const attempts=[];
  try{const d=await get(`/markets?series_ticker=${SERIES}&status=open&limit=100`);const m=choose(d.markets);attempts.push({route:"markets-open",count:d.markets?.length||0});if(m)return{market:m,route:"markets-open",attempts}}catch(e){attempts.push({route:"markets-open",error:String(e.message||e)})}
  try{const d=await get(`/markets?series_ticker=${SERIES}&limit=100`);const m=choose(d.markets);attempts.push({route:"markets-all",count:d.markets?.length||0});if(m)return{market:m,route:"markets-all",attempts}}catch(e){attempts.push({route:"markets-all",error:String(e.message||e)})}
  try{const d=await get(`/events?series_ticker=${SERIES}&status=open&with_nested_markets=true&limit=100`);const nested=(d.events||[]).flatMap(e=>e.markets||[]);const m=choose(nested);attempts.push({route:"events-open",events:d.events?.length||0,markets:nested.length});if(m)return{market:m,route:"events-open",attempts}}catch(e){attempts.push({route:"events-open",error:String(e.message||e)})}
  try{const d=await get(`/events?series_ticker=${SERIES}&with_nested_markets=true&limit=100`);const nested=(d.events||[]).flatMap(e=>e.markets||[]);const m=choose(nested);attempts.push({route:"events-all",events:d.events?.length||0,markets:nested.length});if(m)return{market:m,route:"events-all",attempts}}catch(e){attempts.push({route:"events-all",error:String(e.message||e)})}
  return{market:null,route:null,attempts};
}
function normalized(m){const close=m.close_time||m.expiration_time||m.expected_expiration_time;return{ticker:m.ticker,event_ticker:m.event_ticker,title:m.title,subtitle:m.subtitle,close_time:close,target:target(m),yes_bid:pp(m.yes_bid_dollars??m.yes_bid),yes_ask:pp(m.yes_ask_dollars??m.yes_ask),no_bid:pp(m.no_bid_dollars??m.no_bid),no_ask:pp(m.no_ask_dollars??m.no_ask)}}
async function fixedCurrent(req,env){
  const oldResp=await legacy.fetch(req,env);let base;try{base=await oldResp.clone().json()}catch{return oldResp}
  if(base?.ok&&base?.market)return json({...base,version:VERSION,market_discovery:"legacy-cache"});
  const d=await discover();
  if(!d.market)return json({...base,ok:true,version:VERSION,market_status:"waiting",status:"waiting",message:"Waiting for next BTC 15-minute market.",market_discovery:"fallback-none",discovery_attempts:d.attempts});
  const m=normalized(d.market),ms=Math.max(0,Date.parse(m.close_time)-Date.now());
  return json({...base,ok:true,version:VERSION,server_time:new Date().toISOString(),market_status:"live",status:"live",message:undefined,market:m,timing:{ms_remaining:ms,seconds_remaining:ms/1000,final_60:ms>0&&ms<=60000},market_discovery:d.route,discovery_attempts:d.attempts});
}
export default{async fetch(req,env,ctx){const u=new URL(req.url);if(req.method==="OPTIONS")return new Response(null,{headers:cors});if(u.pathname==="/"||u.pathname==="/health")return json({ok:true,service:"btc15-api",version:VERSION,background_push:true,market_discovery_fallback:true,time:new Date().toISOString()});if(u.pathname==="/api/current")try{return await fixedCurrent(req,env)}catch(e){return json({ok:false,version:VERSION,error:String(e?.message||e),time:new Date().toISOString()},502)}return legacy.fetch(req,env,ctx)}};