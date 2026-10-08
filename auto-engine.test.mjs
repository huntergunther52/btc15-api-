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
await test('entry and exit use market exchange balance and preserve sizing evidence',async()=>{const{engine,b}=fixture();const market=b.market.bind(b);b.market=async t=>({...await market(t),exchange_index:2});const reads=[];b.balance=async index=>{reads.push(index);return index===2?12.8597:0};await engine.control('enable');await engine.tick({ticker:'T'},signal);assert.deepEqual(reads,[undefined,2]);assert.equal(b.calls[0].exchange_index,2);let state=await engine.status();assert.equal(state.position.exchangeIndex,2);assert.equal(state.position.balanceAtEntry.balanceDollars,12.8597);assert(state.position.balanceAtEntry.estimatedCostDollars<=5);b.bid=.65;await engine.tick({ticker:'T'},signal);assert.equal(b.calls[1].exchange_index,2);assert.equal((await engine.status()).history[0].balanceAtEntry.balanceDollars,12.8597)});
await test('an empty market exchange balance blocks orders despite aggregate cash',async()=>{const{engine,b}=fixture();const market=b.market.bind(b);b.market=async t=>({...await market(t),exchange_index:1});b.balance=async index=>index===1?0:12.85;await engine.control('enable');await engine.tick({ticker:'T'},signal);assert.equal(b.calls.length,0);assert.equal((await engine.status()).lastCheck.state,'INSUFFICIENT_BALANCE');assert.equal(orderPayload({ticker:'T',side:'YES'},'entry',1,.5,'test').exchange_index,-1)});
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
await test('transient unfilled order recovers automatically and preserves owner run intent',async()=>{
 const{engine,b}=fixture();b.entryQty=0;await engine.control('enable');const order=b.order.bind(b);let first=true;b.order=async id=>{if(first){first=false;throw Object.assign(Error('Kalshi GET HTTP 404 (not_found)'),{method:'GET',httpStatus:404})}return order(id)};
 await engine.tick({ticker:'T'},signal);assert.equal((await engine.state()).enabled,false);assert((await engine.state()).position);const calls=b.calls.length;time+=10001;await engine.tick({ticker:'T'},null);const s=await engine.state();assert.equal(s.position,null);assert.equal(s.history.at(-1).status,'UNFILLED');assert.equal(s.paused,null);assert.equal(s.enabled,true);assert.equal(b.calls.length,calls);assert.equal(s.history.at(-1).recoveryEvidence.fillCount,0);
});
await test('single-order 404 falls back only to matching exchange order and never submits',async()=>{
 const b=new KalshiBroker({AUTO_TRADING_MODE:'live'});let requests=[];const found={order_id:'OID',ticker:'T',client_order_id:'CID',status:'canceled',fill_count_fp:'0',remaining_count_fp:'0'};
 b.request=async(method,path)=>{requests.push({method,path});if(path.startsWith('/portfolio/orders/OID'))throw Object.assign(Error('404'),{httpStatus:404});return{orders:[found]}};
 assert.deepEqual(await b.order('OID','T','CID'),found);assert(requests.every(x=>x.method==='GET'));b.request=async()=>{throw Object.assign(Error('403'),{httpStatus:403})};await assert.rejects(b.order('OID','T','CID'),/403/);
 b.request=async(method,path)=>{if(path.startsWith('/portfolio/orders/OID'))throw Object.assign(Error('404'),{httpStatus:404});return{orders:[{...found,order_id:'OTHER'}]}};await assert.rejects(b.order('OID','T','CID'),/404/);
});
async function manualFixture(){const f=fixture();await f.engine.control('enable');await f.engine.tick({ticker:'T'},signal);f.b.positionCount=0;await f.engine.tick({ticker:'T'},signal);f.b.market=async ticker=>({ticker,status:'closed',close_time:new Date(time-61000).toISOString()});f.b.marketFills=async()=>f.b.allFills;return f}
await test('manual close verifies fills and flat exchange, preserves history, and stays off',async()=>{
 const{engine,b}=await manualFixture();const before=await engine.state(),calls=b.calls.length;await engine.control('reconcile-manual-close');const s=await engine.status();assert.equal(s.position,null);assert.equal(s.paused,null);assert.equal(s.enabled,false);assert.equal(b.calls.length,calls);assert.deepEqual(s.orders,before.orders);assert.deepEqual(s.seen,before.seen);assert.equal(s.history.at(-1).status,'MANUALLY_CLOSED');assert(s.history.at(-1).entry.quantity>0);assert.equal(s.history.at(-1).exit,null);assert.equal(s.history.at(-1).netPnlDollars,null);assert.equal(s.totalNetDollars,0);assert.equal(s.pauseHistory.at(-1).recovery,'VERIFIED_MANUAL_CLOSE');assert.equal((await engine.orderDiagnostics()),null);
});
await test('manual close refuses unresolved exposure, active market, bot exits and failed verification',async()=>{
 for(const reason of ['held','resting','active','recent','fills','pending','read','exits','enabled']){const{engine,b,map}=await manualFixture();
 if(reason==='held')b.positionCount=1;if(reason==='resting')b.openOrders=[{}];if(reason==='active')b.market=async()=>({status:'active',close_time:new Date(time-61000).toISOString()});if(reason==='recent')b.market=async()=>({status:'closed',close_time:new Date(time-1000).toISOString()});if(reason==='fills')b.allFills=[];if(reason==='pending')b.orders[0].status='resting';if(reason==='read')b.marketFills=async()=>{throw Error('lookup failed')};if(['exits','enabled'].includes(reason)){const s=await engine.state();if(reason==='exits')s.position.exitOrders=['other'];else s.enabled=true;await engine.save(s)}
 const prior=structuredClone([...map]),calls=b.calls.length;await assert.rejects(engine.control('reconcile-manual-close'));assert.deepEqual([...map],prior);assert.equal(b.calls.length,calls);
 }
});
await test('uncertain submission resolves after restart without duplicate entry or recovery exit',async()=>{
 const{engine,b,map}=fixture();await engine.control('enable');b.throwAfterAccept=true;await engine.tick({ticker:'T'},signal);const count=b.calls.length;time+=10001;b.bid=.7;
 const restarted=new AutoEngine({get:async k=>structuredClone(map.get(k)),put:async(k,v)=>map.set(k,structuredClone(v))},b,()=>time,()=>String(++ids));await restarted.tick({ticker:'T'},signal);let s=await restarted.state();assert.equal(s.paused,null);assert.equal(s.enabled,true);assert(s.position.remaining>0);assert.equal(b.calls.length,count);await restarted.tick({ticker:'T'},signal);assert.equal(b.calls.length,count+1);assert(b.calls.at(-1).reduce_only);
});
await test('owner stop during recovery overrides automatic resume',async()=>{const{engine,b}=fixture();await engine.control('enable');b.throwAfterAccept=true;await engine.tick({ticker:'T'},signal);await engine.control('disable');time+=10001;await engine.tick({ticker:'T'},signal);const s=await engine.state();assert.equal(s.paused,null);assert.equal(s.enabled,false);assert.equal(s.runRequested,false);assert.equal(b.calls.length,1)});
await test('persistent missing acknowledgement stays paused with backoff and never repeats POST',async()=>{const{engine,b}=fixture();await engine.control('enable');b.create=async body=>{b.calls.push(body);throw Error('lost response')};await engine.tick({ticker:'T'},signal);let reads=0;b.findClient=async()=>{reads++;return[]};await engine.tick({ticker:'T'},signal);assert.equal(reads,0);time+=10001;await engine.tick({ticker:'T'},signal);assert.equal(reads,1);await engine.tick({ticker:'T'},signal);assert.equal(reads,1);const s=await engine.state();assert(s.paused);assert.equal(s.enabled,false);assert.equal(b.calls.length,1)});
await test('unfilled verification refuses stray holdings and leaves permanent safety pause',async()=>{const{engine,b}=fixture();b.entryQty=0;await engine.control('enable');b.position=async()=>1;await engine.tick({ticker:'T'},signal);/* pre-entry exposure gate prevents entry */assert.equal(b.calls.length,0);b.position=Broker.prototype.position.bind(b);const original=b.create.bind(b);b.create=async body=>{const r=await original(body);b.manualPosition=1;return r};await engine.tick({ticker:'NEW'},signal);const s=await engine.state();assert(s.paused);assert(s.position);assert.equal(s.recovery.eligible,false);time+=100000;await engine.tick({ticker:'NEW'},signal);assert.equal(b.calls.length,1)});
await test('read failure before entry recovers with flat-account checks and no POST',async()=>{const{engine,b}=fixture();await engine.control('enable');const market=b.market.bind(b);let fail=true;b.market=async ticker=>{if(fail){fail=false;throw Object.assign(Error('Kalshi GET HTTP 503'),{method:'GET',httpStatus:503})}return market(ticker)};await engine.tick({ticker:'T'},signal);assert((await engine.state()).paused);time+=10001;await engine.tick({ticker:'T'},signal);const s=await engine.state();assert.equal(s.paused,null);assert.equal(s.enabled,true);assert.equal(b.calls.length,0)});
console.log(tests+' mocked test scenarios passed; no exchange request was made.');

await test('fresh entry quote must still agree with Kalshi confirmation',async()=>{
 for(const kind of ['stale','wrong-market','failed','widened','falling']){const {engine,b}=fixture();await engine.control('enable');const confirmation={ticker:'T',side:'YES',passed:true,quoteCheckedAt:time,bid:.49,ask:.5};if(kind==='stale')confirmation.quoteCheckedAt-=11000;if(kind==='wrong-market')confirmation.ticker='OLD';if(kind==='failed')confirmation.passed=false;if(kind==='widened')b.bid=.46;if(kind==='falling'){b.ask=.48;b.bid=.47}await engine.tick({ticker:'T'},{...signal,confirmation});assert.equal(b.calls.length,0);assert(['CONFIRMATION_EXPIRED','QUOTE_CHANGED'].includes((await engine.status()).lastCheck.state))}
 const {engine,b}=fixture();await engine.control('enable');await engine.tick({ticker:'T'},{...signal,confirmation:{ticker:'T',side:'YES',passed:true,quoteCheckedAt:time,bid:.49,ask:.5}});assert.equal(b.calls.length,1);assert.equal((await engine.status()).position.entryConfirmation.passed,true);
});

async function settlementFixture({side='YES',partial=false,stop=false}={}){
 const f=fixture(),{engine,b}=f;const active=b.market.bind(b);b.market=async t=>({...await active(t),exchange_index:2});
 if(side==='NO')b.bid=.5;await engine.control('enable');await engine.tick({ticker:'T'},{...signal,side});
 if(partial){b.exitQty=3;b.bid=.4;await engine.tick({ticker:'T'},signal)}
 if(side==='YES')b.bid=0;else b.ask=1;
 await engine.tick({ticker:'T'},signal);let s=await engine.state();assert.equal(s.paused,'No executable exit bid');assert.equal(s.recovery.eligible,true);
 if(stop)await engine.control('disable');
 time=Math.max(time+10001,s.position.closeAt+1000);b.positionCount=0;b.market=async ticker=>({ticker,exchange_index:2,status:'settled',result:'no',close_time:new Date(s.position.closeAt).toISOString()});
 const quantity=s.position.remaining;
 b.record={ticker:'T',exchange_index:2,market_result:'no',yes_count_fp:side==='YES'?String(quantity):'0',no_count_fp:side==='NO'?String(quantity):'0',revenue:side==='NO'?quantity*100:0,fee_cost:'.1',settled_time:new Date(s.position.closeAt+100).toISOString()};
 b.settlements=async()=>[b.record];b.marketFills=async()=>b.allFills;
 return f;
}
await test('closed settled position recovers with actual settlement revenue and fill fees, without orders',async()=>{
 for(const side of ['YES','NO']){const {engine,b}=await settlementFixture({side});const calls=b.calls.length;await engine.tick({ticker:'NEW'},signal);const s=await engine.state(),h=s.history.at(-1);assert.equal(s.position,null);assert.equal(s.paused,null);assert.equal(s.enabled,true);assert.equal(h.status,'SETTLED');assert.equal(h.settlement.result,'no');assert.equal(h.netPnlDollars,h.exit.value+h.settlement.revenueDollars-h.entry.value-h.entry.fees-h.exit.fees);assert.equal(b.calls.length,calls);await engine.control('disable');await engine.tick({ticker:'NEW'},signal);assert.equal(s.history.length,1);assert.equal(b.calls.length,calls)}
});
await test('partial exit plus settlement accounts only remaining contracts and honors owner stop',async()=>{
 const {engine,b}=await settlementFixture({partial:true,stop:true});const before=b.calls.length;await engine.tick({ticker:'NEW'},signal);const s=await engine.state(),h=s.history.at(-1);assert.equal(h.exit.quantity,3);assert.equal(h.settlement.quantity,h.entry.quantity-3);assert.equal(s.enabled,false);assert.equal(s.position,null);assert.equal(b.calls.length,before);
});
await test('missing settlement retries with backoff and legacy no-bid pause is migrated',async()=>{
 const {engine,b}=await settlementFixture();b.settlements=async()=>[];const state=await engine.state();state.recovery.eligible=false;await engine.save(state);const before=b.calls.length;
 await engine.tick({ticker:'NEW'},signal);let s=await engine.state();assert(s.position);assert.equal(s.enabled,false);assert.equal(s.recovery.eligible,true);assert(s.paused.startsWith('Settlement pending:'));assert.equal(b.calls.length,before);
 b.settlements=async()=>[b.record];time=s.recovery.nextAt+1;await engine.tick({ticker:'NEW'},signal);s=await engine.state();assert.equal(s.position,null);assert.equal(s.enabled,true);assert.equal(b.calls.length,before);
});
await test('settlement refuses mismatched counts, payout, manual fills, exposure and resting orders',async()=>{
 for(const kind of ['count','revenue','manual','held','resting','wrong-market','wrong-exchange','unfinalized','missing-market-fills']){
  const {engine,b}=await settlementFixture();const calls=b.calls.length;
  if(kind==='count')b.record.yes_count_fp='999';if(kind==='revenue')b.record.revenue=99999;if(kind==='manual')b.allFills.push({...b.allFills[0],fill_id:'manual',order_id:'MANUAL'});if(kind==='held')b.positionCount=1;if(kind==='resting')b.openOrders=[{}];if(kind==='wrong-market')b.record.ticker='OTHER';if(kind==='wrong-exchange')b.record.exchange_index=3;if(kind==='unfinalized')b.record.market_result='scalar';if(kind==='missing-market-fills')b.marketFills=async()=>[];
  await engine.tick({ticker:'NEW'},signal);const s=await engine.state();assert(s.position,kind);assert.equal(s.enabled,false,kind);assert(s.paused,kind);assert.equal(s.history.length,0,kind);assert.equal(b.calls.length,calls,kind);
 }
});
await test('temporary missing bid retries read-only, then resumes verified position management',async()=>{
 const {engine,b}=fixture();await engine.control('enable');await engine.tick({ticker:'T'},signal);b.bid=0;await engine.tick({ticker:'T'},signal);const calls=b.calls.length;time+=10001;await engine.tick({ticker:'T'},signal);let s=await engine.state();assert.equal(s.paused,'No executable exit bid');assert.equal(s.recovery.eligible,true);assert.equal(b.calls.length,calls);b.bid=.4;time=s.recovery.nextAt+1;await engine.tick({ticker:'T'},signal);s=await engine.state();assert.equal(s.paused,null);assert.equal(s.enabled,true);assert.equal(b.calls.length,calls);await engine.tick({ticker:'T'},signal);assert.equal(b.calls.length,calls+1);
});
await test('settlement broker uses complete ticker-filtered primary-subaccount pages',async()=>{
 const broker=new KalshiBroker({});const paths=[];broker.request=async(method,path)=>{assert.equal(method,'GET');paths.push(path);return paths.length===1?{settlements:[{ticker:'T'}],cursor:'NEXT'}:{settlements:[{ticker:'OTHER'},{ticker:'T'}],cursor:''}};const records=await broker.settlements('T');assert.equal(records.length,2);assert(paths[0].includes('/portfolio/settlements?ticker=T&subaccount=0&limit=100'));assert(paths[1].endsWith('&cursor=NEXT'));
});
