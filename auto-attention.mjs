// Durable, deduplicated bot health notifications using existing opted-in push subscriptions.
export class AutoAttention {
 constructor(storage,push,clock=()=>Date.now()){this.storage=storage;this.push=push;this.clock=clock;this.queue=Promise.resolve()}
 check(s,feed,engineAt){const run=this.queue.catch(()=>{}).then(()=>this.inspect(s,feed,engineAt));this.queue=run;return run}
 async inspect(s,feed,engineAt){
 const now=this.clock();let reason=null,message=null;
 if(s.paused){reason='PAUSED:'+ (s.recovery?.startedAt||s.lastError?.at||s.paused);message='Automatic trading is paused. Order or account verification needs attention. Open owner controls.'}
 else if(s.runRequested&&feed?.available===false){reason='FEED';message='Automatic trading has no usable market-data feed. New entries cannot proceed. Open BTC15 to review.'}
 else if(s.runRequested&&engineAt&&now-engineAt>60000){reason='ENGINE';message='The trading engine has stopped updating. Trading health cannot be confirmed. Open owner controls.'}
 let a=await this.storage.get('autoAttention:v1');
 if(!reason){if(a&&!a.resolvedAt){a.resolvedAt=now;await this.storage.put('autoAttention:v1',a);if(a.sentAt)await this.storage.put('autoAttentionRecovery:v1',{at:now,kind:'BOT_RECOVERED',message:s.enabled?'Automatic trading recovered after verified checks.':'The blocker cleared. Automatic trading is off.'})}const recovery=await this.storage.get('autoAttentionRecovery:v1');if(recovery&&!recovery.sentAt&&now-(recovery.attemptAt||0)>=30000){recovery.attemptAt=now;await this.storage.put('autoAttentionRecovery:v1',recovery);const result=await this.push(recovery);if(result.sent>0)recovery.sentAt=now;await this.storage.put('autoAttentionRecovery:v1',recovery)}return}
 if(!a||a.reason!==reason||a.resolvedAt){a={reason,firstAt:now,attemptAt:0,sentAt:null,kind:'BOT_ATTENTION',message};await this.storage.put('autoAttention:v1',a);await this.storage.delete('autoAttentionRecovery:v1')}
 const grace=s.paused&&!s.recovery?.eligible?0:60000;
 if(now-a.firstAt<grace||a.sentAt||now-a.attemptAt<30000)return;
 a.attemptAt=now;await this.storage.put('autoAttention:v1',a);
 const result=await this.push({kind:a.kind,message:a.message,at:now});a.delivery={at:now,...result};if(result.sent>0)a.sentAt=now;await this.storage.put('autoAttention:v1',a);
 }
}
