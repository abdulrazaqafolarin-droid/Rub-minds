/** Opt-in background polling for an already enrolled, consented Backroom host.
 * No browser, network or queue activity happens until start() is called.
 * The caller owns stop/unpair lifecycle. All errors fail closed.
 */
import {pollPairedWakeJobs} from './paired-wake-worker.mjs';
export function createBackroomWakePoller({
  store,browserRuntime,hostId,bindingId,sessionDigest,executionJournal,
  intervalMs=5000,onResult=()=>{}
}={}){
 if(!store||!browserRuntime||!executionJournal||typeof onResult!=='function')
  throw new TypeError('Trusted wake poller dependencies required');
 if(!Number.isSafeInteger(intervalMs)||intervalMs<1000||intervalMs>60000)
  throw new RangeError('Wake polling interval must be 1–60 seconds');
 if(browserRuntime.hostId!==hostId||typeof browserRuntime.resolveClaimedWakeContext!=='function'||
   typeof browserRuntime.verifyClaimedWakeGrant!=='function'||!browserRuntime.dispatcher)
  throw new TypeError('Browser host identity/dispatcher mismatch');
 let stopped=true,pending=null,sleepAbort=null;
 async function once(){
  if(stopped)return Object.freeze({state:'stopped'});
  if(pending)return pending;
  pending=(async()=>{
   try {
    if(!browserRuntime.running){stopped=true;return Object.freeze({state:'browser-stopped'});}
    return Object.freeze({state:'polled',results:await pollPairedWakeJobs({
      store,hostId,sessionDigest,bindingId,limit:1,
      dispatcher:browserRuntime.dispatcher,executionJournal,
      resolveContext:scope=>browserRuntime.resolveClaimedWakeContext(scope),
      verifyApproval:(approval,context)=>browserRuntime.verifyClaimedWakeGrant(approval,context)
    })});
   }catch{return Object.freeze({state:'unavailable'});}
  })();
  try{return await pending;}
  finally{pending=null;}
 }
 let runner=null;
 async function start(){
  if(!stopped)return;
  stopped=false;
  runner=(async()=>{
   while(!stopped){
    const result=await once();
    // Do not log host tokens, session digests or canonical provider prompts.
    try{onResult(result);}catch{}
    if(stopped)break;
    sleepAbort=new AbortController();
    try{await new Promise(resolve=>{
      const handle=setTimeout(resolve,intervalMs);
      sleepAbort.signal.addEventListener('abort',()=>{clearTimeout(handle);resolve();},{once:true});
    });}finally{sleepAbort=null;}
   }
  })();
 }
 async function stop(){
  stopped=true;
  sleepAbort?.abort();
  if(runner)await runner;
  runner=null;
 }
 return Object.freeze({start,stop,pollOnce:once,get running(){return !stopped;}});
}
