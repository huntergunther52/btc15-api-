// Shared by all signal readers in the BTC Durable Object.
export class CandleFeed {
 constructor(storage,read,clock=Date.now){this.storage=storage;this.read=read;this.clock=clock;this.pending=null}
 async get(){if(this.pending)return this.pending;this.pending=this.load().finally(()=>{this.pending=null});return this.pending}
 async load(){const now=this.clock(),cache=await this.storage.get('candleFeed:v1');if(cache?.data?.ok&&now-cache.at<30000)return{...cache.data,cacheAgeMs:now-cache.at};if(cache?.retryAt>now)return{ok:false,error:cache.error,retryAt:cache.retryAt};let data;try{data=await this.read()}catch(e){data={ok:false,error:String(e.message||e)}}const at=this.clock();if(data.ok){await this.storage.put('candleFeed:v1',{at,data});return{...data,cacheAgeMs:0}}const retryAt=at+(data.status===429?60000:15000);await this.storage.put('candleFeed:v1',{at,error:data.error||'Candle data unavailable',retryAt});return{...data,retryAt}}
}
