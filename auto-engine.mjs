// Offline implementation. No activation or deployment is performed by this package.
export const RULES = Object.freeze({minScore:.90,minSeconds:15,maxSeconds:480,maxTradeDollars:5,maxHoldMs:90000});
const KEY='autoTrading:v1';
const finite=x=>x!==null&&x!==undefined&&x!==''&&Number.isFinite(Number(x));
const num=x=>{if(!finite(x))throw Error('Missing numeric exchange field');return Number(x)};
const fee=(p,n)=>Math.ceil(.07*n*p*(1-p)*100)/100;
export function sizeForBudget(p,budget=5){if(!(p>0&&p<1))return 0;let n=Math.floor(budget/p);while(n>0&&n*p+fee(p,n)>budget+1e-9)n--;return n}
export function qualifies(sc,seconds){return !!sc?.side&&['YES','NO'].includes(sc.side)&&finite(sc.confidence)&&Number(sc.confidence)>=.90&&finite(seconds)&&seconds>=15&&seconds<=480&&finite(sc.entry)&&sc.entry>.04&&sc.entry<.96&&finite(sc.targetPrice)&&finite(sc.stopPrice)&&sc.targetPrice>sc.entry&&sc.stopPrice<sc.entry}
export function signalBlockReason(sc,seconds){
 if(!sc)return 'Signal data unavailable';
 if(!sc.side||!['YES','NO'].includes(sc.side))return sc.reason||'Scalp model is WATCH/WAIT';
 if(!finite(sc.confidence)||Number(sc.confidence)<.90)return 'Confidence below 90%';
 if(!finite(seconds))return 'Market close time unavailable';
 if(seconds>480)return 'More than 8 minutes remaining';
 if(seconds<15)return 'Less than 15 seconds remaining';
 if(!finite(sc.entry)||sc.entry<=.04||sc.entry>=.96)return 'Entry price outside allowed range';
 if(!finite(sc.targetPrice)||!finite(sc.stopPrice)||sc.targetPrice<=sc.entry||sc.stopPrice>=sc.entry)return 'Invalid target or stop';
 return null;
}
export function orderPayload(p,leg,quantity,heldPrice,cid){if(!(quantity>0&&Number.isInteger(quantity))||!(heldPrice>0&&heldPrice<1))throw Error('Invalid order quantity or price');const yesExposure=(p.side==='YES')===(leg==='entry');const price=p.side==='YES'?heldPrice:1-heldPrice;return{ticker:p.ticker,client_order_id:cid,exchange_index:Number.isInteger(p.exchangeIndex)&&p.exchangeIndex>=0?p.exchangeIndex:-1,side:yesExposure?'bid':'ask',count:quantity.toFixed(2),price:price.toFixed(4),time_in_force:'immediate_or_cancel',self_trade_prevention_type:'taker_at_cross',cancel_order_on_pause:true,reduce_only:leg==='exit'}}
export function summarizeFills(fills,side){const ids=new Set;let quantity=0,value=0,fees=0;for(const f of fills){if(!f.fill_id||ids.has(f.fill_id))continue;ids.add(f.fill_id);const q=num(f.count_fp),price=num(side==='YES'?f.yes_price_dollars:f.no_price_dollars),paid=num(f.fee_cost);if(q<0||price<0||price>1||paid<0)throw Error('Invalid fill');quantity+=q;value+=q*price;fees+=paid}return{quantity,value,fees}}
export class AutoEngine{
 constructor(storage,broker,clock=()=>Date.now(),uuid=()=>crypto.randomUUID()){this.storage=storage;this.broker=broker;this.clock=clock;this.uuid=uuid;this.queue=Promise.resolve()}
 async state(){return await this.storage.get(KEY)||{enabled:false,paused:null,position:null,seen:[],history:[],orders:[]}}
 async save(s){s.updatedAt=this.clock();await this.storage.put(KEY,s)}
 serial(fn){const run=this.queue.catch(()=>{}).then(fn);this.queue=run;return run}
 async status(){const s=await this.state();return{...s,rules:RULES,mode:this.broker.mode,totalNetDollars:s.history.reduce((a,x)=>a+x.netPnlDollars,0)}}
 async orderDiagnostics(){
 const s=await this.state(),p=s.position;if(!p||!s.paused)return null;
 const intent=s.orders.find(x=>x.clientOrderId===p.entryOrder);
 try{
  const [matches,held,resting,fills]=await Promise.all([this.broker.findClient(p.ticker,p.entryOrder),this.broker.position(p.ticker),this.broker.resting(p.ticker),this.broker.marketFills(p.ticker)]);
  return{ok:true,readOnly:true,ticker:p.ticker,matchingOrderCount:matches.length,heldContracts:held,restingOrderCount:resting.length,marketFillCount:fills.length,submissionError:intent?.error||(intent?.orderId?null:'Original submission error was not saved by the previous build'),submissionStage:intent?.errorStage||null,exchangeCode:intent?.exchangeCode||null,notice:'No order was submitted or cleared. An absent order is not by itself proof that submission never reached the exchange.'};
 }catch(e){return{ok:false,readOnly:true,error:e.message,stage:e.stage||'order lookup'}}
 }
 async control(action){return this.serial(async()=>{const s=await this.state();if(action==='enable'){if(!['live','demo'].includes(this.broker.mode))throw Error('Live mode is disabled in deployment configuration');if(s.position||s.paused)throw Error('Reconcile existing state before enabling');await this.broker.balance();s.enabled=true;s.runRequested=true;s.recovery=null}else if(action==='reconcile'){if(!s.position){await this.reconcileFlatPause(s);await this.save(s);return{enabled:s.enabled,position:s.position,paused:s.paused}}const prior=s.paused;s.paused=null;try{await this.manage(s);s.enabled=false}catch(e){s.paused=prior||String(e.message||e);s.enabled=false;await this.save(s);throw e}}else if(action==='reconcile-manual-close'){await this.reconcileManualClose(s)}else if(action==='archive-unresolved'){await this.archiveUnresolved(s)}else if(action==='disable'){s.enabled=false;s.runRequested=false}else throw Error('Unknown control action');await this.save(s);return{enabled:s.enabled,position:s.position,paused:s.paused}})}
 tick(m,sc){return this.serial(async()=>{const s=await this.state();let detail={ticker:m?.ticker||null,side:sc?.side||null,direction:sc?.direction||null,confidence:finite(sc?.confidence)?Number(sc.confidence):null,signalStatus:sc?.status||null,signalReason:sc?.reason||null,secondsRemaining:Number.isFinite(Date.parse(m?.close_time))?(Date.parse(m.close_time)-this.clock())/1000:null};
 const report=async(state,reason,extra={})=>{s.lastCheck={at:this.clock(),state,reason,...detail,...extra};s.checkCounts=s.checkCounts||{};s.checkCounts[state]=(s.checkCounts[state]||0)+1;await this.save(s);return{state,reason}};
 try{if(s.enabled&&s.runRequested===undefined)s.runRequested=true;if(!['live','demo'].includes(this.broker.mode))return await report('DISABLED','Deployment mode is disabled');if(s.paused){if(!s.recovery&&s.history.at(-1)?.status==='UNFILLED')s.recovery={startedAt:this.clock(),nextAt:0,attempts:0,eligible:true};if(s.recovery?.eligible&&this.clock()>=(s.recovery.nextAt||0)){await this.recover(s);return await report(s.paused?'RECOVERING':'RECOVERED',s.paused||'Exchange checks agree; automatic recovery completed')}return await report('PAUSED',s.paused)}if(s.position){await this.manage(s);await this.save(s);return await report(s.position?'MANAGING':'CLOSED','Existing position checked')}if(!s.enabled||s.paused)return await report('OFF',s.paused||'Automatic trading is disabled');if(!m?.ticker)return await report('NO_MARKET','No current market');
 const fresh=await this.broker.market(m.ticker),close=Date.parse(fresh.close_time),seconds=(close-this.clock())/1000;
 detail={...detail,secondsRemaining:seconds,marketStatus:fresh.status};if(!qualifies(sc,seconds)||fresh.status!=='active')return await report('NO_SIGNAL',fresh.status!=='active'?'Market is not active':signalBlockReason(sc,seconds));
 const key=fresh.ticker+':'+sc.side;if(s.seen.includes(key))return await report('DUPLICATE','This ticker and side already have an entry attempt');
 const ask=num(sc.side==='YES'?fresh.yes_ask_dollars:fresh.no_ask_dollars);
 // A signal is a maximum buy price, not permission to chase the market.
 if(ask>sc.entry+1e-9||ask<=0||ask>=1)return await report('PRICE_MOVED','Current ask exceeds signal entry or is not executable',{currentAsk:ask,entryLimit:sc.entry});
 const exchangeIndex=Number.isInteger(fresh.exchange_index)&&fresh.exchange_index>=0?fresh.exchange_index:null;const balance=await this.broker.balance(exchangeIndex),budget=Math.min(5,balance),quantity=sizeForBudget(ask,budget);if(!quantity)return await report('INSUFFICIENT_BALANCE','No contract fits available balance including estimated fees');
 if(Math.abs(await this.broker.position(fresh.ticker))>1e-9||(await this.broker.resting(fresh.ticker)).length)return await report('EXISTING_EXPOSURE','Existing account position or resting order');
 const now=this.clock();s.position={ticker:fresh.ticker,exchangeIndex,balanceAtEntry:{at:this.clock(),balanceDollars:balance,estimatedCostDollars:quantity*ask+fee(ask,quantity),budgetDollars:budget},side:sc.side,target:sc.targetPrice,stop:sc.stopPrice,closeAt:close,createdAt:now,openedAt:null,entryLimit:ask,requested:quantity,entryOrder:null,exitOrders:[],remaining:0,exitTriggered:null};
 s.seen.push(key);await this.save(s);await this.submit(s,'entry',quantity,ask);await this.manage(s);await this.save(s);return await report(s.position?'MANAGING':'UNFILLED','Entry submitted and reconciled')
 }catch(e){s.lastError={at:this.clock(),message:String(e.message||e),stage:e.stage||null,method:e.method||null,path:e.requestPath||null,httpStatus:e.httpStatus||null};const eligible=this.recoverable(e);s.recovery={...(s.paused&&!s.recovery?.resolvedAt&&s.recovery?s.recovery:{startedAt:this.clock(),attempts:0}),eligible,nextAt:this.clock()+10000};s.paused=String(e.message||e);s.enabled=false;await this.save(s);return await report('PAUSED',s.paused)}})}
 recoverable(e){return (e.method==='GET'&&(e.httpStatus===404||e.httpStatus===429||e.httpStatus>=500))||/lost response|Order outcome uncertain|Unresolved order |Fills not yet reconciled|Order is not terminal|fetch failed|network|timed out|aborted/i.test(String(e.message||e))}
 async recover(s){
 const r=s.recovery;r.attempts++;r.nextAt=this.clock()+Math.min(60000,10000*2**Math.min(r.attempts-1,3));
 try{
  if(s.position){await this.manage(s);if(!s.position&&s.history.at(-1)?.status==='UNFILLED')await this.reconcileFlatPause(s)}
  else if(s.history.at(-1)?.status==='UNFILLED')await this.reconcileFlatPause(s);else{const ticker=s.lastCheck?.ticker;if(!ticker||s.orders.some(x=>['PENDING','ACKNOWLEDGED','UNCERTAIN'].includes(x.state)))throw Error('Cannot verify unresolved durable order state');await this.broker.balance();const [held,resting]=await Promise.all([this.broker.position(ticker),this.broker.resting(ticker)]);if(!Number.isFinite(held)||Math.abs(held)>1e-9||resting.length)throw Error('Account exposure remains; manual reconciliation required')}
  // manage keeps paused positions read-only. Clear only after terminal orders, fills and holdings agree.
  s.pauseHistory=s.pauseHistory||[];s.pauseHistory.push({at:this.clock(),reason:s.paused||s.lastError?.message,recovery:'AUTOMATIC_VERIFIED'});s.paused=null;s.enabled=s.runRequested===true;s.recovery={...r,resolvedAt:this.clock(),eligible:false};
 }catch(e){s.paused=String(e.message||e);s.enabled=false;r.lastError=s.paused;if(!this.recoverable(e))r.eligible=false}
 await this.save(s);
 }
 async reconcileFlatPause(s){
 const h=s.history.at(-1),intent=s.orders.find(x=>x.clientOrderId===h?.entryOrder);
 if(s.enabled||!s.paused||s.position||h?.status!=='UNFILLED'||!intent?.orderId||intent.state!=='RECONCILED'||h.exitOrders.length||h.entry?.quantity!==0)throw Error('No resolved unfilled attempt available to clear this pause');
 const order=intent.verifiedUnfilledOrder||await this.broker.order(intent.orderId,h.ticker,intent.clientOrderId);
 const [fills,held,resting]=await Promise.all([this.broker.fills(intent.orderId),this.broker.position(h.ticker),this.broker.resting(h.ticker)]);
 if(!['canceled','executed'].includes(order.status)||num(order.fill_count_fp)!==0||num(order.remaining_count_fp)!==0||fills.length||!Number.isFinite(held)||Math.abs(held)>1e-9||resting.length)throw Error('Exchange activity or exposure remains; pause was not cleared');
 h.recoveryEvidence={checkedAt:this.clock(),orderId:intent.orderId,fillCount:0,heldContracts:0,restingOrderCount:0};s.pauseHistory=s.pauseHistory||[];s.pauseHistory.push({at:this.clock(),reason:s.paused,recovery:'VERIFIED_UNFILLED'});s.paused=null;s.enabled=false;
 }
 async reconcileManualClose(s){
 const p=s.position,intent=s.orders.find(x=>x.clientOrderId===p?.entryOrder);
 if(s.enabled||!s.paused||!p||!p.openedAt||!intent?.orderId||intent.state!=='RECONCILED'||p.exitOrders.length)throw Error('Only a paused, confirmed entry without bot exits can be reconciled as manually closed');
 const market=await this.broker.market(p.ticker),closed=Date.parse(market.close_time);
 if(!Number.isFinite(closed)||this.clock()<closed+60000||!['closed','settled','finalized'].includes(market.status))throw Error('Wait until the market is closed for at least 60 seconds');
 const [order,fills,held,resting,marketFills]=await Promise.all([this.broker.order(intent.orderId,p.ticker,intent.clientOrderId),this.broker.fills(intent.orderId),this.broker.position(p.ticker),this.broker.resting(p.ticker),this.broker.marketFills(p.ticker)]);
 const entry=summarizeFills(fills,p.side);
 if(!['executed','canceled'].includes(order.status)||num(order.remaining_count_fp)!==0||!(entry.quantity>0)||Math.abs(num(order.fill_count_fp)-entry.quantity)>1e-6||!Number.isFinite(held)||Math.abs(held)>1e-9||resting.length)throw Error('Entry is not fully verified or exchange exposure remains; pause was not cleared');
 const now=this.clock();s.history.push({...p,remaining:0,status:'MANUALLY_CLOSED',entry,exit:null,netPnlDollars:null,closedAt:now,recoveryEvidence:{checkedAt:now,entryOrderId:intent.orderId,entryFillCount:entry.quantity,heldContracts:0,restingOrderCount:0,marketFillCount:marketFills.length},note:'Owner reported manual close. Confirmed entry preserved; closed market and flat exchange position verified. Manual exit proceeds are not assigned to bot profit or loss.'});
 s.pauseHistory=s.pauseHistory||[];s.pauseHistory.push({at:now,reason:s.paused,recovery:'VERIFIED_MANUAL_CLOSE'});s.position=null;s.paused=null;s.enabled=false;s.lastCheck={at:now,state:'OFF',reason:'Manual close reconciled; automatic trading remains disabled',ticker:p.ticker};
 }
 async archiveUnresolved(s){
 const p=s.position,intent=s.orders.find(x=>x.clientOrderId===p?.entryOrder);
 if(s.enabled||!s.paused||!p||!intent||intent.orderId||intent.state!=='UNCERTAIN'||p.openedAt||p.exitOrders.length)throw Error('Only a paused, unacknowledged entry can be archived');
 const market=await this.broker.market(p.ticker),closed=Date.parse(market.close_time);
 if(!Number.isFinite(closed)||this.clock()<closed+60000||!['closed','settled','finalized'].includes(market.status))throw Error('Wait until the market is closed for at least 60 seconds');
 const [matches,held,resting,fills]=await Promise.all([this.broker.findClient(p.ticker,p.entryOrder),this.broker.position(p.ticker),this.broker.resting(p.ticker),this.broker.marketFills(p.ticker)]);
 if(matches.length||!Number.isFinite(held)||Math.abs(held)>1e-9||resting.length||fills.length)throw Error('Exchange activity or exposure found; the entry cannot be archived');
 const now=this.clock();intent.state='ARCHIVED_UNCONFIRMED';intent.archivedAt=now;
 s.history.push({...p,status:'UNCONFIRMED_NO_EXPOSURE',netPnlDollars:null,closedAt:now,recoveryEvidence:{checkedAt:now,matchingOrderCount:0,heldContracts:0,restingOrderCount:0,marketFillCount:0},note:'Unacknowledged attempt archived after market closure and exchange checks. Not a confirmed trade, win, loss, or break-even.'});
 s.position=null;s.paused=null;s.enabled=false;
 }
 async submit(s,leg,q,price){const p=s.position,cid=this.uuid(),intent={clientOrderId:cid,orderId:null,leg,quantity:q,price,at:this.clock(),state:'PENDING'};s.orders.push(intent);if(leg==='entry')p.entryOrder=cid;else p.exitOrders.push(cid);await this.save(s);try{const result=await this.broker.create(orderPayload(p,leg,q,price,cid));if(!result.order_id)throw Error('Missing order ID');intent.orderId=result.order_id;intent.state='ACKNOWLEDGED';await this.save(s)}catch(e){intent.state='UNCERTAIN';intent.error=String(e.message||e);intent.errorStage=e.stage||'order acknowledgement';intent.exchangeCode=e.exchangeCode||null;await this.save(s);throw Error('Order outcome uncertain; reconcile before another order: '+e.message)}}
 async resolve(s,cid){const i=s.orders.find(x=>x.clientOrderId===cid);if(!i)throw Error('Missing durable order intent');if(!i.orderId){const matches=await this.broker.findClient(s.position.ticker,cid);if(matches.length!==1)throw Error('Unresolved order '+cid+'; no order will be resubmitted');i.orderId=matches[0].order_id;i.state='ACKNOWLEDGED';await this.save(s)}const order=i.verifiedUnfilledOrder||await this.broker.order(i.orderId,s.position.ticker,cid),fills=await this.broker.fills(i.orderId),sum=summarizeFills(fills,s.position.side);if(Math.abs(num(order.fill_count_fp)-sum.quantity)>1e-6)throw Error('Fills not yet reconciled for '+i.orderId);if(num(order.remaining_count_fp)>0||order.status==='resting')throw Error('Unexpected resting IOC order: '+i.orderId);if(!['executed','canceled'].includes(order.status))throw Error('Order is not terminal');i.state='RECONCILED';i.filledQuantity=sum.quantity;if(sum.quantity===0)i.verifiedUnfilledOrder=order;return sum}
 async manage(s){const p=s.position;if(!p.entryOrder)throw Error('Entry intent was not persisted; reconcile manually');const entry=await this.resolve(s,p.entryOrder);let exit={quantity:0,value:0,fees:0};for(const cid of p.exitOrders){const z=await this.resolve(s,cid);exit.quantity+=z.quantity;exit.value+=z.value;exit.fees+=z.fees}p.remaining=entry.quantity-exit.quantity;if(p.remaining< -1e-6)throw Error('Exit fills exceed entry fills');
 if(!entry.quantity){if(Math.abs(await this.broker.position(p.ticker))>1e-9||(await this.broker.resting(p.ticker)).length)throw Error('Account exposure remains after unfilled entry; manual reconciliation required');s.history.push({...p,status:'UNFILLED',entry,exit,netPnlDollars:0,closedAt:this.clock()});s.position=null;return}
 if(!p.openedAt)p.openedAt=s.orders.find(x=>x.clientOrderId===p.entryOrder).at;
 const held=await this.broker.position(p.ticker),expected=(p.side==='YES'?1:-1)*p.remaining;
 if(Math.abs(held-expected)>1e-6)throw Error('Account position differs from bot ledger; manual reconciliation required');
 if(p.remaining<=1e-6){s.history.push({...p,status:'CLOSED',entry,exit,netPnlDollars:exit.value-entry.value-entry.fees-exit.fees,closedAt:this.clock()});s.position=null;return}
 if(s.paused)return; // Disable new entries but keep monitoring; uncertain orders need reconciliation first.
 const fresh=await this.broker.market(p.ticker),bid=num(p.side==='YES'?fresh.yes_bid_dollars:fresh.no_bid_dollars),now=this.clock();
 if(fresh.status!=='active'||now>=p.closeAt)throw Error('Market closed with an open position; settlement reconciliation required');
 if(!p.exitTriggered){if(bid>=p.target)p.exitTriggered='TAKE_PROFIT';else if(bid<=p.stop)p.exitTriggered='STOP';else if(now-p.openedAt>=90000||p.closeAt-now<=15000)p.exitTriggered='TIMEOUT'}
 if(!p.exitTriggered)return;if(!(bid>0&&bid<1))throw Error('No executable exit bid');
 // Exit remains latched across partial fills. Never reverse or sell more than owned.
 if(p.lastExitAt&&now-p.lastExitAt<2000)return;
 if(!Number.isInteger(p.remaining))throw Error('Fractional position needs manual reconciliation');p.lastExitAt=now;await this.save(s);await this.submit(s,'exit',p.remaining,bid);
 // Reconcile immediately, with a later tick retrying only the unfilled remainder.
 const last=await this.resolve(s,p.exitOrders.at(-1));p.remaining-=last.quantity;await this.save(s);
 if(p.remaining<=1e-6){await this.finish(s)}
 }
 async finish(s){const p=s.position,entry=await this.resolve(s,p.entryOrder);let exit={quantity:0,value:0,fees:0};for(const id of p.exitOrders){const z=await this.resolve(s,id);for(const k of Object.keys(exit))exit[k]+=z[k]}if(Math.abs(await this.broker.position(p.ticker))>1e-6)throw Error('Exchange position not flat after exit');s.history.push({...p,status:'CLOSED',entry,exit,netPnlDollars:exit.value-entry.value-entry.fees-exit.fees,closedAt:this.clock()});s.position=null}
}
export class KalshiBroker{
 constructor(env,fetcher=(...args)=>globalThis.fetch(...args)){this.env=env;this.fetcher=(...args)=>fetcher(...args);this.mode=['live','demo'].includes(env.AUTO_TRADING_MODE)?env.AUTO_TRADING_MODE:'disabled'}
 async request(method,path,body){let stage='credentials';try{if(method!=='GET'&&!['live','demo'].includes(this.mode))throw Error('Live orders disabled');const env=this.env;if(!env.KALSHI_API_KEY_ID||!env.KALSHI_PRIVATE_KEY)throw Error('Missing Kalshi credentials');stage='private-key decode';const timestamp=String(Date.now()),der=Uint8Array.from(atob(env.KALSHI_PRIVATE_KEY.replace(/-----[^-]+-----/g,'').replace(/\s/g,'')),x=>x.charCodeAt(0));stage='private-key import';const key=await crypto.subtle.importKey('pkcs8',der,{name:'RSA-PSS',hash:'SHA-256'},false,['sign']);stage='request signing';const sig=new Uint8Array(await crypto.subtle.sign({name:'RSA-PSS',saltLength:32},key,new TextEncoder().encode(timestamp+method+'/trade-api/v2'+path.split('?')[0])));stage='Kalshi fetch';const r=await this.fetcher((this.mode==='demo'?'https://external-api.demo.kalshi.co':'https://external-api.kalshi.com')+'/trade-api/v2'+path,{method,headers:{'KALSHI-ACCESS-KEY':env.KALSHI_API_KEY_ID,'KALSHI-ACCESS-TIMESTAMP':timestamp,'KALSHI-ACCESS-SIGNATURE':btoa(String.fromCharCode(...sig)),'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(8000)});stage='Kalshi response';if(!r.ok){let code;try{const d=await r.json();const candidate=d.code||d.error?.code;if(typeof candidate==='string'&&/^[a-zA-Z0-9_.-]{1,100}$/.test(candidate))code=candidate}catch{}const error=Error('Kalshi '+method+' HTTP '+r.status+(code?' ('+code+')':''));error.exchangeCode=code||null;error.httpStatus=r.status;throw error;}return await r.json()}catch(e){e.stage=stage;e.method=method;e.requestPath=path.split('?')[0];throw e}}
 async pages(path,field){let out=[],cursor='';for(let page=0;page<100;page++){const d=await this.request('GET',path+(path.includes('?')?'&':'?')+'limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''));if(!Array.isArray(d[field]))throw Error('Missing exchange collection');out.push(...d[field]);if(!d.cursor)return out;cursor=d.cursor}throw Error('Pagination limit; refusing incomplete account data')}
 async balance(exchangeIndex=null){const scoped=Number.isInteger(exchangeIndex)&&exchangeIndex>=0;const d=await this.request('GET','/portfolio/balance'+(scoped?'?exchange_index='+exchangeIndex:''));const dollars=d.balance_dollars==null?num(d.balance)/100:num(d.balance_dollars);this.lastBalanceSnapshot={checkedAt:Date.now(),exchangeIndex:scoped?exchangeIndex:null,balanceDollars:dollars,reportedBalanceDollars:d.balance_dollars??null,portfolioValueDollars:d.portfolio_value==null?null:num(d.portfolio_value)/100,updatedTs:d.updated_ts??null,exchangeBalances:(d.balance_breakdown||[]).map(x=>({exchangeIndex:x.exchange_index,balanceDollars:x.balance}))};return dollars}
 async market(ticker){const d=await this.request('GET','/markets/'+encodeURIComponent(ticker));if(d.market?.ticker!==ticker)throw Error('Market mismatch');return d.market}
 async position(ticker){const a=await this.pages('/portfolio/positions?ticker='+encodeURIComponent(ticker),'market_positions');return a.filter(x=>x.ticker===ticker).reduce((n,x)=>n+num(x.position_fp),0)}
 async resting(ticker){return this.pages('/portfolio/orders?ticker='+encodeURIComponent(ticker)+'&status=resting','orders')}
 async findClient(ticker,cid){return(await this.pages('/portfolio/orders?ticker='+encodeURIComponent(ticker),'orders')).filter(x=>x.client_order_id===cid)}
 async order(id,ticker,cid){let d;try{d=await this.request('GET','/portfolio/orders/'+encodeURIComponent(id))}catch(e){if(e.httpStatus!==404||!ticker||!cid)throw e;const matches=(await this.findClient(ticker,cid)).filter(x=>x.order_id===id&&x.ticker===ticker);if(matches.length!==1)throw e;d={order:matches[0]}}if(d.order?.order_id!==id||(ticker&&d.order.ticker!==ticker)||(cid&&d.order.client_order_id!==cid))throw Error('Order mismatch');return d.order}
 async fills(id){return(await this.pages('/portfolio/fills?order_id='+encodeURIComponent(id),'fills')).filter(x=>x.order_id===id)}
 async marketFills(ticker){return(await this.pages('/portfolio/fills?ticker='+encodeURIComponent(ticker),'fills')).filter(x=>x.ticker===ticker)}
 async create(body){return this.request('POST','/portfolio/events/orders',body)}
}
export function ownerAuthorized(req,env){const token=env.AUTO_TRADING_OWNER_TOKEN;if(typeof token!=='string'||token.length<32)return false;const candidate=req.headers.get('authorization')||'',expected='Bearer '+token;if(candidate.length!==expected.length)return false;let mismatch=0;for(let i=0;i<expected.length;i++)mismatch|=candidate.charCodeAt(i)^expected.charCodeAt(i);return mismatch===0}
