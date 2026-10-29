/**
 * Runtime-configurable local host service for multiple independently consented AI inputs.
 * Each binding gets its own remote queue client, poller, consent grant and expiry timer.
 * The browser may provide a public project API key, but never the gateway URL or host token.
 */
import {createRemoteWakeStore} from './remote-wake-store.mjs';
import {createBackroomWakePoller} from './host-wake-poller.mjs';
import {FileWakeExecutionJournal} from './file-wake-execution-journal.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX=/^[a-f0-9]{64}$/;
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
function validateConfig(input){
 if(!input||typeof input!=='object'||Array.isArray(input)||
   Object.keys(input).some(key=>!['sessionDigest','bindingId','publishableKey'].includes(key)))
  throw new TypeError('Unexpected host configuration fields');
 const {sessionDigest,bindingId,publishableKey}=input;
 if(!UUID.test(bindingId??'')||!HEX.test(sessionDigest??''))
  throw new TypeError('Valid hosted binding and MCP digest required');
 if(typeof publishableKey!=='string'||publishableKey.length<20||publishableKey.length>4096||
   !/^[A-Za-z0-9._-]+$/.test(publishableKey))
  throw new TypeError('Valid public project API key required');
 return Object.freeze({bindingId,sessionDigest,publishableKey});
}

export function createHostWakeService({
 identity,browserRuntime,journalDirectory,fetchImpl,
 gatewayUrl=process.env.BACKROOM_WAKE_GATEWAY_URL??DEFAULT_WAKE_GATEWAY_URL
}={}){
 if(!identity||!UUID.test(identity.hostId??'')||!HEX.test(identity.hostToken??'')||
    !browserRuntime||identity.hostId!==browserRuntime.hostId)
  throw new TypeError('Trusted local host identity and browser runtime required');

 const trustedUrl=trustedGatewayUrl(gatewayUrl);
 const journal=new FileWakeExecutionJournal({directory:journalDirectory});
 const bindings=new Map();

 async function stopOne(entry){
  if(entry.expiryTimer){clearTimeout(entry.expiryTimer);entry.expiryTimer=null;}
  try{await entry.poller.stop();}catch{}
  if(!entry.activeGrantId)return Object.freeze({stopped:true,remotelyDeactivated:null,bindingId:entry.scope.bindingId});
  const input={hostId:identity.hostId,bindingId:entry.scope.bindingId,
    sessionDigest:entry.scope.sessionDigest,grantId:entry.activeGrantId};
  try{
   const confirmed=await entry.remote.deactivate(input);
   // false means this exact grant is no longer the active server-side grant
   // (for example, the owner already revoked the binding). Do not misreport
   // that as a confirmed write; local polling is stopped regardless.
   entry.activeGrantId=null;
   return Object.freeze({stopped:true,remotelyDeactivated:confirmed===true,bindingId:entry.scope.bindingId});
  }catch{
   // A response can be lost after the host's binding was already revoked. Repeat
   // the exact grant-bound request once. Polling is stopped before these retries.
   try{
    const confirmed=await entry.remote.deactivate(input);
    entry.activeGrantId=null;
    return Object.freeze({stopped:true,remotelyDeactivated:confirmed===true,bindingId:entry.scope.bindingId});
   }catch{
    return Object.freeze({stopped:true,remotelyDeactivated:false,bindingId:entry.scope.bindingId});
   }
  }
 }

 async function stop(bindingId){
  if(bindingId!==undefined && !UUID.test(bindingId??''))
   throw new TypeError('Invalid binding ID for stop');
  const entries=bindingId===undefined?[...bindings.values()]:
    (bindings.has(bindingId)?[bindings.get(bindingId)]:[]);
  const results=[];
  for(const entry of entries)results.push(await stopOne(entry));
  return Object.freeze({stopped:true,bindings:results,remotelyDeactivated:
    results.every(result=>result.remotelyDeactivated!==false)});
 }

 async function unconfigure(bindingId){
  if(!UUID.test(bindingId??''))throw new TypeError('Invalid binding ID to remove');
  const entry=bindings.get(bindingId);
  if(!entry)return Object.freeze({removed:false,bindingId});
  // Stop local consumption first. If server-side revocation preceded this call,
  // remote deactivation can be denied; removing the stopped local poller remains safe.
  const stopped=await stopOne(entry);
  bindings.delete(bindingId);
  return Object.freeze({removed:true,bindingId,remotelyDeactivated:stopped.remotelyDeactivated});
 }

 function configure(rawInput={}){
  const config=validateConfig(rawInput);
  const current=bindings.get(config.bindingId);
  if(current){
   const same=current.scope.sessionDigest===config.sessionDigest&&
    current.publishableKey===config.publishableKey;
   if(same)return Object.freeze({configured:true,bindingId:config.bindingId,existing:true});
   if(current.poller.running||current.activeGrantId)
    throw new Error('Deactivate this binding before changing its hosted session or project key');
   throw new Error('Binding configuration cannot be silently replaced; revoke the old binding and register a new one');
  }
  const remote=createRemoteWakeStore({
   baseUrl:trustedUrl,hostToken:identity.hostToken,apiKey:config.publishableKey,
   ...(fetchImpl===undefined?{}:{fetchImpl}),
   verifyLocalGrant:grant=>browserRuntime.verifyRemoteWakeActivation(grant)
  });
  const poller=createBackroomWakePoller({
   store:remote,browserRuntime,hostId:identity.hostId,
   bindingId:config.bindingId,sessionDigest:config.sessionDigest,
   executionJournal:journal
  });
  const entry={
   remote,poller,publishableKey:config.publishableKey,
   scope:Object.freeze({bindingId:config.bindingId,sessionDigest:config.sessionDigest}),
   activeGrantId:null,expiryTimer:null
  };
  bindings.set(config.bindingId,entry);
  return Object.freeze({configured:true,bindingId:config.bindingId,existing:false});
 }

 async function activateAndStart(grant,input){
  const bindingId=input?.bindingId;
  const entry=bindings.get(bindingId);
  if(!entry)throw new Error('Configure this hosted input binding before local consent');
  if(grant?.scope?.hostId!==identity.hostId||grant.scope.bindingId!==entry.scope.bindingId||
     grant.scope.bindingId!==input.bindingId||grant.scope.groupId!==input.roomId||
     grant.scope.participantId!==input.participantId||grant.scope.sessionId!==input.sessionId)
   throw new Error('Local consent grant does not authorize this hosted binding');
  if(entry.activeGrantId===grant.grantId && entry.poller.running)
   return Object.freeze({activated:true,bindingId,existing:true});
  if(entry.activeGrantId||entry.poller.running)
   throw new Error('Stop the previous consent grant before activating this binding');
  const remainingMs=Number.isFinite(grant.expiresAt)?grant.expiresAt-Date.now():0;
  const ttlSeconds=Math.min(300,Math.floor((remainingMs-5000)/1000));
  if(ttlSeconds<60)throw new Error('Local wake grant has insufficient remaining lifetime');
  const activateInput={hostId:identity.hostId,bindingId:entry.scope.bindingId,
    sessionDigest:entry.scope.sessionDigest,grantId:grant.grantId,ttlSeconds};
  let accepted;
  try{accepted=await entry.remote.activate(activateInput);}
  catch{
   // Activation is idempotent for the exact grant ID. Retry only that same request
   // to recover a response lost after the server committed.
   accepted=await entry.remote.activate(activateInput);
  }
  if(accepted!==true)throw new Error('Hosted wake consent activation denied');
  entry.activeGrantId=grant.grantId;
  try{await entry.poller.start();}
  catch(error){
   await stopOne(entry);
   throw error;
  }
  const localExpiryMs=Math.max(0,grant.expiresAt-Date.now());
  entry.expiryTimer=setTimeout(()=>{entry.expiryTimer=null;void stopOne(entry);},localExpiryMs);
  entry.expiryTimer.unref?.();
  return Object.freeze({activated:true,bindingId,existing:false});
 }

 return Object.freeze({
  configure,activateAndStart,stop,unconfigure,
  get status(){
   const list=[...bindings.values()].map(entry=>Object.freeze({
    bindingId:entry.scope.bindingId,polling:entry.poller.running===true,
    consentActive:Boolean(entry.activeGrantId)
   }));
   return Object.freeze({configured:list.length>0,count:list.length,bindings:Object.freeze(list)});
  }
 });
}
