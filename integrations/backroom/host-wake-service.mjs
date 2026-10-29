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
export function createHostWakeService({identity,browserRuntime,journalDirectory,fetchImpl}={}){
 if(!identity||!UUID.test(identity.hostId??'')||!HEX.test(identity.hostToken??'')||
    !browserRuntime||identity.hostId!==browserRuntime.hostId)
  throw new TypeError('Trusted local host identity and browser runtime required');
 const journal=new FileWakeExecutionJournal({directory:journalDirectory});
 let remote=null,poller=null,scope=null;
 async function stop(){await poller?.stop();}
 function configure({gatewayUrl,sessionDigest,bindingId}={}){
  if(poller?.running)throw new Error('Stop active wake polling before reconfiguration');
  if(!UUID.test(bindingId??'')||!HEX.test(sessionDigest??''))
   throw new TypeError('Valid hosted binding and MCP digest required');
  const store=createRemoteWakeStore({
    baseUrl:gatewayUrl,hostToken:identity.hostToken,
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
  const accepted=await remote.activate({hostId:identity.hostId,
    bindingId:scope.bindingId,sessionDigest:scope.sessionDigest,
    grantId:grant.grantId,ttlSeconds:300});
  if(accepted!==true)throw new Error('Hosted wake consent activation denied');
  await poller.start();
 }
 return Object.freeze({
  configure,activateAndStart,stop,
  get status(){return Object.freeze({configured:Boolean(remote),
    polling:poller?.running===true,bindingId:scope?.bindingId??null});}
 });
}
