import assert from 'node:assert/strict';
import {AutoEngine,RULES,qualifies,orderPayload,sizeForBudget,summarizeFills,ownerAuthorized,KalshiBroker} from './auto-engine.mjs';
let time=1000000,ids=0;const signal={side:'YES',confidence:.90,entry:.5,targetPrice:.62,stopPrice:.42};
class Broker{
 constructor(){this.mode='live';this.calls=[];this.orders=[];this.allFills=[];this.positionCount=0;this.ask=.5;this.bid=.49;this.close=time+480000;this.entryQty=null;this.exitQty=null;this.throwAfterAccept=false;this.manualPosition=0;this.openOrders=[]}
 async balance(){return 10}
 async market(ticker){return{ticker,status:'active',close_time:new Date(this.close).toISOString(),yes_ask_dollars:String(this.ask),yes_bid_dollars:String(this.bid),no_ask_dollars:String(1-this.bid),no_bid_dollars:String(1-this.ask)}}
 async position(){return this.positionCount+this.manualPosition}
 async resting(){return this.openOrders}
 async findClient(t,c){return this.orders.filter(x=>x.client_order_id===c)}
 async order(id){return this.orders.find(x=>x.order_id===id)}
 async fills(id){return this.allFills.filter(x=>x.order_id===id)}
 async create(body){this.calls.push(body);const entry=!body.reduce_only,q=Math.min(Number(body.count),entry?(this.entryQty??99):(this.exitQty??99)),id='O'+this.orders.length;const price=Number(body.price);this.orders.push({order_id:id,client_order_id:body.client_order_id,status:q?'executed':'canceled',fill_count_fp:String(q),remaining_count_fp:'0'});if(q){this.positionCount+=(body.side==='bid'?1:-1)*q;this.allFills.push({fill_id:'F'+id,order_id:id,count_fp:String(q),yes_price_dollars:String(price),no_price_dollars:String(1-price),fee_cost:String(q*.01)})}if(this.throwAfterAccept){this.throwAfterAccept=false;throw Error('lost response')}return{order_id:id}}
}
function fixture(){const map=new Map,b=new Broker,storage={get:async k=>structuredClone(map.get(k)),put:async(k,v)=>map.set(k,structuredClone(v))},engine=new AutoEngine(storage,b,()=>time,()=>String(++ids));return{engine,b,map}}
let tests=0;async function test(name,fn){await fn();tests++;console.log('PASS '+name)}
await test('score and clock boundary filters',async()=>{for(const seconds of [15,480])assert(qualifies(signal,seconds));for(const seconds of [14,481,NaN])assert(!qualifies(signal,seconds));assert(!qualifies({...signal,confidence:.8999},300));assert(!qualifies({...signal,side:null},300))});
await test('YES/NO entry and exit book direction',async()=>{assert.equal(orderPayload({ticker:'T',side:'YES'},'entry',2,.3,'a').side,'bid');assert.equal(orderPayload({ticker:'T',side:'YES'},'exit',2,.4,'a').side,'ask');const n=orderPayload({ticker:'T',side:'NO'},'entry',2,.3,'a');assert.equal(n.side,'ask');assert.equal(n.price,'0.7000');const e=orderPayload({ticker:'T',side:'NO'},'exit',2,.4,'a');assert.equal(e.side,'bid');assert.equal(e.price,'0.6000');assert(e.reduce_only)});
await test('disabled mode performs no broker work',async()=>{const{engine,b}=fixture();b.mode='disabled';await engine.tick({ticker:'T'},signal);assert.equal(b.calls.length,0);await assert.rejects(engine.control('enable'))});
await test('owner controls require a long secret',async()=>{const r=new Request('https://x',{headers:{authorization:'Bearer '+ 'x'.repeat(32)}});assert(ownerAuthorized(r,{AUTO_TRADING_OWNER_TOKEN:'x'.repeat(32)}));assert(!ownerAuthorized(r,{}));assert(!ownerAuthorized(r,{AUTO_TRADING_OWNER_TOKEN:'y'.repeat(32)}));const b=new KalshiBroker({});await assert.rejects(b.create({}),/disabled/)});
await test('full entry, target exit, actual fees and preserved ledger',async()=>{const{engine,b}=fixture();await engine.control('enable');await engine.tick({ticker:'T'},signal);assert.equal(b.calls.length,1);const n=Number(b.calls[0].count);assert(n*.5+Math.ceil(.07*n*.25*100)/100<=5);b.bid=.65;await engine.tick({ticker:'T'},signal);const s=await engine.status();assert.equal(s.position,null);assert.equal(s.history.length,1);assert.equal(b.positionCount,0);assert(Math.abs(s.history[0].netPnlDollars-(n*.15-2*n*.01))<1e-8);await engine.tick({ticker:'T'},signal);assert.equal(b.calls.length,2)});
await test('partial entry manages only filled quantity',async()=>{const{engine,b}=fixture();b.entryQty=3;await engine.control('enable');await engine.tick({ticker:'T'},signal);assert.equal((await engine.status()).position.remaining,3);b.bid=.39;await engine.tick({ticker:'T'},signal);assert.equal(Number(b.calls[1].count),3);assert.equal((await engine.status()).history[0].exitTriggered,'STOP')});
await test('partial exit retains remainder and latched trigger',async()=>{const{engine,b}=fixture();b.entryQty=3;b.exitQty=1;await engine.control('enable');await engine.tick({ticker:'T'},signal);b.bid=.65;await engine.tick({ticker:'T'},signal);assert.equal((await engine.status()).position.remaining,2);b.bid=.50;time+=2100;await engine.tick({ticker:'T'},null);assert.equal(Number(b.calls.at(-1).count),2);assert.equal((await engine.status()).position.remaining,1);time+=2100;await engine.tick({ticker:'T'},null);assert.equal((await engine.status()).position,null);assert.equal(b.positionCount,0)});
await test('lost POST response is reconciled without resubmission, including restart',async()=>{const{engine,b,map}=fixture();await engine.control('enable');b.throwAfterAccept=true;await engine.tick({ticker:'T'},signal);assert.equal(b.calls.length,1);assert((await engine.status()).paused);const restarted=new AutoEngine({get:async k=>structuredClone(map.get(k)),put:async(k,v)=>map.set(k,structuredClone(v))},b,()=>time,()=>String(++ids));await restarted.control('reconcile');assert.equal(b.calls.length,1);assert((await restarted.status()).position.remaining>0);assert.equal((await restarted.status()).enabled,false)});
await test('no entry into existing positions, resting orders, or higher ask',async()=>{for(const mode of ['position','resting','price']){const{engine,b}=fixture();await engine.control('enable');if(mode==='position')b.manualPosition=2;if(mode==='resting')b.openOrders=[{}];if(mode==='price')b.ask=.51;await engine.tick({ticker:'T'},signal);assert.equal(b.calls.length,0)}});
await test('disable stops new entries but continues exiting owned position',async()=>{const{engine,b}=fixture();await engine.control('enable');await engine.tick({ticker:'T'},signal);await engine.control('disable');time+=91000;b.close=time+300000;await engine.tick({ticker:'T'},null);assert.equal((await engine.status()).position,null);assert.equal((await engine.status()).history[0].exitTriggered,'TIMEOUT');await engine.tick({ticker:'NEW'},signal);assert.equal(b.calls.length,2)});
await test('missing fills and manual position changes pause rather than guess',async()=>{const{engine,b}=fixture();await engine.control('enable');await engine.tick({ticker:'T'},signal);b.manualPosition=1;b.bid=.7;await engine.tick({ticker:'T'},signal);assert((await engine.status()).paused);assert.equal(b.calls.length,1);assert((await engine.status()).position)});
await test('fill deduplication and conservative sizing',async()=>{const f={fill_id:'a',count_fp:'2',yes_price_dollars:'.5',no_price_dollars:'.5',fee_cost:'.03'};assert.equal(summarizeFills([f,f],'YES').quantity,2);assert.equal(sizeForBudget(.5,0),0)});
await test('native fetch receiver is preserved during signed balance check',async()=>{
 const originalFetch=globalThis.fetch;
 const keys=await crypto.subtle.generateKey({name:'RSA-PSS',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const privateKey=Buffer.from(await crypto.subtle.exportKey('pkcs8',keys.privateKey)).toString('base64');
 let requests=0;
 globalThis.fetch=async function(url,options){
  assert.equal(this,globalThis,'native fetch must receive its global runtime context');
  assert.equal(url,'https://external-api.kalshi.com/trade-api/v2/portfolio/balance');
  assert.equal(options.method,'GET');
  assert(options.headers['KALSHI-ACCESS-SIGNATURE']);
  requests++;return new Response(JSON.stringify({balance:1000}),{status:200});
 };
 try{
  const broker=new KalshiBroker({AUTO_TRADING_MODE:'live',KALSHI_API_KEY_ID:'mock-key',KALSHI_PRIVATE_KEY:privateKey});
  assert.equal(await broker.balance(),10);
  const map=new Map();
  const engine=new AutoEngine({get:async k=>map.get(k),put:async(k,v)=>map.set(k,v)},broker);
  await engine.control('enable');assert.equal((await engine.status()).enabled,true);
  assert.equal(requests,2);
  globalThis.fetch=async()=>{throw Error('mock balance failure')};
  const failed=new AutoEngine({get:async()=>undefined,put:async()=>assert.fail('failed activation must not save enabled state')},new KalshiBroker({AUTO_TRADING_MODE:'live',KALSHI_API_KEY_ID:'mock-key',KALSHI_PRIVATE_KEY:privateKey}));
  await assert.rejects(failed.control('enable'),/mock balance failure/);
  assert.equal((await failed.status()).enabled,false);
 }finally{globalThis.fetch=originalFetch}
});
await test('uncertain order diagnostics preserve the original failure and never place or clear orders',async()=>{
 const{engine,b,map}=fixture();await engine.control('enable');b.create=async()=>{throw Object.assign(Error('Kalshi POST HTTP 400 (invalid_order)'),{stage:'Kalshi response',exchangeCode:'invalid_order'})};
 await engine.tick({ticker:'T'},signal);const initial=await engine.state();assert.equal(initial.orders[0].error,'Kalshi POST HTTP 400 (invalid_order)');
 b.marketFills=async()=>[];await engine.tick({ticker:'T'},signal);const before=structuredClone([...map]);
 const diagnostic=await engine.orderDiagnostics();assert.equal(diagnostic.matchingOrderCount,0);assert.equal(diagnostic.heldContracts,0);assert.equal(diagnostic.exchangeCode,'invalid_order');assert.equal(diagnostic.submissionStage,'Kalshi response');assert.deepEqual([...map],before);assert.equal(b.calls.length,0);assert((await engine.state()).position);
 b.marketFills=async()=>{throw Error('lookup unavailable')};assert.equal((await engine.orderDiagnostics()).ok,false);assert.deepEqual([...map],before);
});
await test('closed-market recovery archives an attempt without trades, PNL, or activation',async()=>{
 const{engine,b}=fixture();await engine.control('enable');b.create=async()=>{throw Error('lost acknowledgement')};await engine.tick({ticker:'T'},signal);
 const openMarket=b.market.bind(b);b.market=async ticker=>({...await openMarket(ticker),status:'closed',close_time:new Date(time-61000).toISOString()});b.marketFills=async()=>[];
 await engine.control('archive-unresolved');const s=await engine.status();assert.equal(s.enabled,false);assert.equal(s.paused,null);assert.equal(s.position,null);assert.equal(s.history[0].status,'UNCONFIRMED_NO_EXPOSURE');assert.equal(s.history[0].netPnlDollars,null);assert.equal(s.totalNetDollars,0);assert.equal(s.orders[0].state,'ARCHIVED_UNCONFIRMED');assert.deepEqual(s.seen,['T:YES']);assert.equal(b.calls.length,0);
});
await test('recovery refuses open markets, found orders, fills, and positions without changing state',async()=>{
 for(const reason of ['active','order','fill','held','resting']){const{engine,b,map}=fixture();await engine.control('enable');b.create=async()=>{throw Error('unknown')};await engine.tick({ticker:'T'},signal);
 b.market=async ticker=>({ticker,status:reason==='active'?'active':'closed',close_time:new Date(time-61000).toISOString()});b.marketFills=async()=>reason==='fill'?[{}]:[];if(reason==='order')b.findClient=async()=>[{}];if(reason==='held')b.positionCount=1;if(reason==='resting')b.openOrders=[{}];
 const prior=structuredClone([...map]);await assert.rejects(engine.control('archive-unresolved'));assert.deepEqual([...map],prior);assert.equal(b.calls.length,0);
 }
});
await test('entry health records exact filters and counts without sending orders',async()=>{
 const{engine,b}=fixture();await engine.control('enable');await engine.tick({ticker:'T'}, {...signal,confidence:.89});let s=await engine.status();assert.equal(s.lastCheck.reason,'Confidence below 90%');assert.equal(s.lastCheck.confidence,.89);assert.equal(s.checkCounts.NO_SIGNAL,1);
 b.close=time+481000;await engine.tick({ticker:'T'},signal);s=await engine.status();assert.equal(s.lastCheck.reason,'More than 8 minutes remaining');assert.equal(s.lastCheck.secondsRemaining,481);
 b.close=time+300000;b.ask=.51;await engine.tick({ticker:'T'},signal);s=await engine.status();assert.equal(s.lastCheck.state,'PRICE_MOVED');assert.equal(s.lastCheck.currentAsk,.51);assert.equal(s.checkCounts.NO_SIGNAL,2);assert.equal(b.calls.length,0);
 await engine.control('disable');await engine.tick({ticker:'T'},signal);assert.equal((await engine.status()).lastCheck.state,'OFF');assert.equal(b.calls.length,0);
});
await test('resolved unfilled pause can be verified and cleared without placing orders or enabling',async()=>{
 const{engine,b,map}=fixture();b.entryQty=0;await engine.control('enable');const order=b.order.bind(b);let first=true;b.order=async id=>{if(first){first=false;throw Error('Kalshi GET HTTP 404 (not_found)')}return order(id)};
 await engine.tick({ticker:'T'},signal);assert.equal((await engine.state()).enabled,false);assert((await engine.state()).position);await engine.tick({ticker:'T'},null);let s=await engine.state();assert.equal(s.position,null);assert.equal(s.history.at(-1).status,'UNFILLED');assert(s.paused);const calls=b.calls.length;await engine.control('reconcile');s=await engine.state();assert.equal(s.paused,null);assert.equal(s.enabled,false);assert.equal(b.calls.length,calls);assert.equal(s.history.at(-1).recoveryEvidence.fillCount,0);assert.equal(s.pauseHistory.length,1);
 s.paused='another pause';await engine.save(s);b.openOrders=[{}];const before=structuredClone([...map]);await assert.rejects(engine.control('reconcile'));assert.deepEqual([...map],before);
});
await test('single-order 404 falls back only to matching exchange order and never submits',async()=>{
 const b=new KalshiBroker({AUTO_TRADING_MODE:'live'});let requests=[];const found={order_id:'OID',ticker:'T',client_order_id:'CID',status:'canceled',fill_count_fp:'0',remaining_count_fp:'0'};
 b.request=async(method,path)=>{requests.push({method,path});if(path.startsWith('/portfolio/orders/OID'))throw Object.assign(Error('404'),{httpStatus:404});return{orders:[found]}};
 assert.deepEqual(await b.order('OID','T','CID'),found);assert(requests.every(x=>x.method==='GET'));b.request=async()=>{throw Object.assign(Error('403'),{httpStatus:403})};await assert.rejects(b.order('OID','T','CID'),/403/);
 b.request=async(method,path)=>{if(path.startsWith('/portfolio/orders/OID'))throw Object.assign(Error('404'),{httpStatus:404});return{orders:[{...found,order_id:'OTHER'}]}};await assert.rejects(b.order('OID','T','CID'),/404/);
});
console.log(tests+' mocked test scenarios passed; no exchange request was made.');
