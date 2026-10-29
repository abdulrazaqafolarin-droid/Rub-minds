/**
 * Runtime-configurable, local-only remote wake service.
 * Configure using an origin-bound paired localhost control request. This never
 * exposes the private host token and never starts polls before explicit consent.
 */
import {createRemoteWakeStore} from './remote-wake-store.mjs';
import {createBackroomWakePoller} from './host-wake-poller.mjs';
import {FileWakeExecutionJournal} from './file-wake-execution-journal.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX=/^[a-f0-9]{64}$/;
// Trust anchor: the paired website may choose a binding, never the credential destination.
const DEFAULT_WAKE_GATEWAY_URL='https://zucaeevlbwhcvjwbhwmq.supabase.co/functions/v1/backroom-wake/';
function trustedGatewayUrl(value){
 let url;
 try{url=new URL(value);}catch{throw new TypeError('Invalid trusted wake gateway URL');}
 if(url.href!==DEFAULT_WAKE_GATEWAY_URL &&
   !(process.env.BACKROOM_WAKE_GATEWAY_URL && value===process.env.BACKROOM_WAKE_GATEWAY_URL &&
     url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&
     url.pathname==='/functions/v1/backroom-wake/'))
  throw new Error('Wake gateway is not the locally configured trusted Supabase endpoint');
 return url.href;
}
export function createHostWakeService({identity,browserRuntime,journalDirectory,fetchImpl,gatewayUrl=process.env.BACKROOM_WAKE_GATEWAY_URL??DEFAULT_WAKE_GATEWAY_URL}={}){
 if(!identity||!UUID.test(identity.hostId??'')||!HEX.test(identity.hostToken??'')||
    !browserRuntime||identity.hostId!==browserRuntime.hostId)
  throw new TypeError('Trusted local host identity and browser runtime required');
 const trustedUrl=trustedGatewayUrl(gatewayUrl);
 const journal=new FileWakeExecutionJournal({directory:journalDirectory});
 let remote=null,poller=null,scope=null,activeGrantId=null,expiryTimer=null;
 async function stop(){
  if(expiryTimer){clearTimeout(expiryTimer);expiryTimer=null;}
  await poller?.stop();
  if(!remote||!scope||!activeGrantId)return Object.freeze({stopped:true,remotelyDeactivated:null});
  try{
   await remote.deactivate({hostId:identity.hostId,bindingId:scope.bindingId,
    sessionDigest:scope.sessionDigest,grantId:activeGrantId});
   activeGrantId=null;
   return Object.freeze({stopped:true,remotelyDeactivated:true});
  }catch{
   // Local polling is already stopped. The hosted activation is short-lived;
   // preserve the grant ID so a caller can retry best-effort deactivation.
   return Object.freeze({stopped:true,remotelyDeactivated:false});
  }
 }
 function configure(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||
    Object.keys(input).some(key=>!['sessionDigest','bindingId'].includes(key)))
   throw new TypeError('Only binding ID and session digest may be supplied by the paired UI');
  const {sessionDigest,bindingId}=input;
  if(poller?.running||activeGrantId)throw new Error('Deactivate the existing wake grant before reconfiguration');
  if(!UUID.test(bindingId??'')||!HEX.test(sessionDigest??''))
   throw new TypeError('Valid hosted binding and MCP digest required');
  const store=createRemoteWakeStore({
    baseUrl:trustedUrl,hostToken:identity.hostToken,
    ...(fetchImpl===undefined?{}:{fetchImpl}),
    verifyLocalGrant:grant=>browserRuntime.verifyRemoteWakeActivation(grant)
  });
  const next=createBackroomWakePoller({store,browserRuntime,hostId:identity.hostId,
    bindingId,sessionDigest,executionJournal:journal});
  remote=store;poller=next;
  scope=Object.freeze({bindingId,sessionDigest});
  return Object.freeze({configured:true,bindingId});
 }
 async function activateAndStart(grant,input){
  if(!remote||!poller||!scope)throw new Error('Configure remote wake binding before local consent');
  if(grant?.scope?.hostId!==identity.hostId||grant.scope.bindingId!==scope.bindingId||
     grant.scope.bindingId!==input?.bindingId||grant.scope.groupId!==input?.roomId||
     grant.scope.participantId!==input?.participantId||grant.scope.sessionId!==input?.sessionId)
   throw new Error('Local consent grant does not authorize configured hosted binding');
  const remainingMs=Number.isFinite(grant.expiresAt)?grant.expiresAt-Date.now():0;
  // Reserve a safety margin for request latency so hosted consent never outlives
  // the local user's actual one-shot grant.
  const ttlSeconds=Math.min(300,Math.floor((remainingMs-5000)/1000));
  if(ttlSeconds<60)throw new Error('Local wake grant has insufficient remaining lifetime');
  const accepted=await remote.activate({hostId:identity.hostId,
    bindingId:scope.bindingId,sessionDigest:scope.sessionDigest,
    grantId:grant.grantId,ttlSeconds});
  if(accepted!==true)throw new Error('Hosted wake consent activation denied');
  activeGrantId=grant.grantId;
  await poller.start();
  const localExpiryMs=Math.max(0,grant.expiresAt-Date.now());
  expiryTimer=setTimeout(()=>{expiryTimer=null;void stop();},localExpiryMs);
  expiryTimer.unref?.();
 }
 return Object.freeze({
  configure,activateAndStart,stop,
  get status(){return Object.freeze({configured:Boolean(remote),
    polling:poller?.running===true,bindingId:scope?.bindingId??null,
    activationPendingDeactivation:Boolean(activeGrantId)});}
 });
}
